// The overview as a terminal app: it follows one session and redraws as the session changes.
import {
  findSessionRecord,
  findTranscriptPath,
  TranscriptFollower,
  type SessionQuery,
  type SessionRecord,
} from "./claudeSession.ts"
import { BROWSER_COMMAND, openInBrowser, runQuietly } from "./command.ts"
import { readDevServers, type DevServer } from "./devServers.ts"
import { readBranchPullRequests, readGitState, type GitState, type PullRequest } from "./git.ts"
import { followPaneStatus, type PaneStatusFollower } from "./rexStatus.ts"
import { TranscriptReader } from "./transcript.ts"
import { buildLinkRows, renderScreen, type LinkRow, type OverviewState } from "./view.ts"

// The pane whose Claude reports its status to Rex.
export type RexPane = { rexBinary: string; sessionId: string; blockId: string }

export type OverviewOptions = {
  sessionQuery: SessionQuery
  gitBinary: string
  // Empty without the GitHub CLI.
  ghBinary: string
  contextWindowTokens?: number
  rexPane?: RexPane
}

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l"
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l"
const KEY_PATTERN = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g
const SESSION_POLL_MILLISECONDS = 1_000
const GIT_POLL_MILLISECONDS = 5_000
const PULL_REQUEST_POLL_MILLISECONDS = 60_000
const STANDARD_CONTEXT_WINDOW_TOKENS = 200_000
const LARGE_CONTEXT_WINDOW_TOKENS = 1_000_000
const LARGE_WINDOW_MODEL_PATTERN = /fable|mythos|opus-5|\[1m\]/

let sessionQuery: SessionQuery = { processIds: [] }
let gitBinary = "git"
let ghBinary = ""
let configuredContextWindowTokens: number | undefined
let paneStatusFollower: PaneStatusFollower | undefined

let session: SessionRecord | null = null
let transcript: TranscriptFollower | null = null
let summary = new TranscriptReader().summary()
let git: GitState | null | undefined
let branchPullRequests: PullRequest[] = []
let devServers: DevServer[] = []
let pullRequestLookup: OverviewState["pullRequestLookup"] = "unavailable"
let links: LinkRow[] = []
let selectedLinkUrl: string | undefined
let statusMessage = ""
let gitReadAt = 0
let pullRequestReadAt = 0
let repositoryGeneration = 0

// A model's window is not in the transcript, so it is guessed from the model's name.
// Past 200k tokens it can only be the large one.
function contextWindowTokens(): number {
  if (configuredContextWindowTokens) return configuredContextWindowTokens
  const usesLargeWindow =
    LARGE_WINDOW_MODEL_PATTERN.test(summary.model ?? "") || summary.contextTokens > STANDARD_CONTEXT_WINDOW_TOKENS
  return usesLargeWindow ? LARGE_CONTEXT_WINDOW_TOKENS : STANDARD_CONTEXT_WINDOW_TOKENS
}

// Until a link is chosen, the branch's own pull request is selected, or else the first
// link that is not the repository.
function selectedLinkIndex(): number {
  const chosenIndex = links.findIndex((row) => row.url === selectedLinkUrl)
  if (chosenIndex >= 0) return chosenIndex
  const preferredIndex = links.findIndex((row) => row.isOnCurrentBranch)
  return Math.max(0, preferredIndex >= 0 ? preferredIndex : links.findIndex((row) => row.kind !== "repository"))
}

function render() {
  links = buildLinkRows(summary, branchPullRequests, git?.repositoryUrl, devServers, repositoryDirectory())
  const lines = renderScreen(
    {
      session,
      programStatus: paneStatusFollower?.paneStatus.current() ?? null,
      summary,
      git,
      pullRequestLookup,
      links,
      selectedLinkIndex: selectedLinkIndex(),
      contextWindowTokens: contextWindowTokens(),
      statusMessage,
      now: Date.now(),
    },
    process.stdout.columns,
    process.stdout.rows,
  )
  process.stdout.write(`\x1b[?2026h\x1b[H\x1b[2J${lines.join("\r\n")}\x1b[?2026l`)
}

function repositoryDirectory(): string | undefined {
  return summary.workingDirectory ?? session?.cwd
}

async function refreshGit() {
  const directory = repositoryDirectory()
  if (!directory) return
  const generation = repositoryGeneration
  gitReadAt = Date.now()
  const gitState = await readGitState(gitBinary, directory)
  if (generation !== repositoryGeneration) return
  const branchChanged = gitState?.branch !== git?.branch
  git = gitState
  if (branchChanged) void refreshPullRequest()
  render()
}

async function refreshDevServers() {
  const directory = repositoryDirectory()
  if (!directory) return
  const generation = repositoryGeneration
  const foundDevServers = await readDevServers(directory)
  if (generation !== repositoryGeneration) return
  devServers = foundDevServers
  render()
}

async function refreshPullRequest() {
  const directory = repositoryDirectory()
  if (!directory || !ghBinary) return
  const generation = repositoryGeneration
  pullRequestReadAt = Date.now()
  const foundPullRequests = git === null ? [] : await readBranchPullRequests(ghBinary, directory)
  if (generation !== repositoryGeneration) return
  branchPullRequests = foundPullRequests
  pullRequestLookup = "done"
  render()
}

function followSession() {
  const foundSession = findSessionRecord(session ? { processIds: [], sessionId: session.sessionId } : sessionQuery)
  if (!foundSession) {
    if (session) statusMessage = "the session has ended"
    return
  }
  session = foundSession
  if (!transcript) {
    const transcriptPath = findTranscriptPath(foundSession.sessionId)
    if (transcriptPath) transcript = new TranscriptFollower(transcriptPath)
  }
  if (transcript?.readNewLines()) {
    const previousDirectory = repositoryDirectory()
    summary = transcript.reader.summary()
    if (repositoryDirectory() !== previousDirectory) {
      repositoryGeneration += 1
      gitReadAt = 0
      pullRequestReadAt = 0
    }
  }
}

function tick() {
  followSession()
  if (session) {
    const now = Date.now()
    if (now - gitReadAt >= GIT_POLL_MILLISECONDS) {
      void refreshGit()
      void refreshDevServers()
    } else if (now - pullRequestReadAt >= PULL_REQUEST_POLL_MILLISECONDS) void refreshPullRequest()
  }
  render()
}

function refresh() {
  statusMessage = `updated ${new Date().toTimeString().slice(0, 5)}`
  gitReadAt = 0
  pullRequestReadAt = 0
  tick()
}

function moveSelection(step: number) {
  if (links.length === 0) return
  const targetIndex = (selectedLinkIndex() + step + links.length) % links.length
  selectedLinkUrl = links[targetIndex]?.url
}

function selectLinkAt(linkIndex: number) {
  selectedLinkUrl = links.at(linkIndex)?.url
}

function copyToClipboard(text: string, copiedMessage: string) {
  const clipboardCommand = process.platform === "darwin" ? "pbcopy" : "wl-copy"
  void runQuietly([clipboardCommand], text).then((isCopied) => {
    statusMessage = isCopied ? copiedMessage : `could not run ${clipboardCommand}`
    render()
  })
}

function openSelectedLink() {
  const selectedLink = links[selectedLinkIndex()]
  if (!selectedLink) {
    statusMessage = "no link to open"
    return
  }
  void openInBrowser(selectedLink.url).then((isOpened) => {
    statusMessage = isOpened ? `opened ${selectedLink.url}` : `could not run ${BROWSER_COMMAND}`
    render()
  })
}

function copySelectedLink() {
  const selectedLink = links[selectedLinkIndex()]
  if (selectedLink) copyToClipboard(selectedLink.url, "copied the link")
  else statusMessage = "no link to copy"
}

function quit() {
  paneStatusFollower?.stop()
  process.stdout.write(LEAVE_SCREEN)
  process.stdin.setRawMode(false)
  process.exit(0)
}

function handleKey(key: string) {
  switch (key) {
    case "q":
    case "\x1b":
    case "\x03":
      return quit()
    case "j":
    case "\t":
    case "\x1b[B":
    case "\x1bOB":
      return moveSelection(1)
    case "k":
    case "\x1b[Z":
    case "\x1b[A":
    case "\x1bOA":
      return moveSelection(-1)
    case "g":
      return selectLinkAt(0)
    case "G":
      return selectLinkAt(-1)
    case "\r":
    case "o":
      return openSelectedLink()
    case "y":
      return copySelectedLink()
    case "i":
      if (session) copyToClipboard(session.sessionId, "copied the session id")
      return
    case "r":
      return refresh()
  }
}

export function startOverview(options: OverviewOptions) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("rexysesh needs a terminal")
    process.exit(1)
  }
  sessionQuery = options.sessionQuery
  gitBinary = options.gitBinary
  ghBinary = options.ghBinary
  configuredContextWindowTokens = options.contextWindowTokens
  pullRequestLookup = ghBinary ? "loading" : "unavailable"

  process.stdout.write(ENTER_SCREEN)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on("data", (chunk: Buffer) => {
    for (const key of chunk.toString("utf8").match(KEY_PATTERN) ?? []) handleKey(key)
    render()
  })
  process.stdout.on("resize", render)
  process.on("SIGTERM", quit)
  process.on("SIGHUP", quit)
  setInterval(tick, SESSION_POLL_MILLISECONDS)
  tick()
  if (options.rexPane) {
    const { rexBinary, sessionId, blockId } = options.rexPane
    paneStatusFollower = followPaneStatus(rexBinary, sessionId, blockId, render)
  }
}
