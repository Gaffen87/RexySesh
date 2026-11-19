// RexySesh: an overview of a Claude Code session for the terminal, made to run in a Rex pane.
import packageInfo from "../package.json"
import {
  findSessionRecord,
  findTranscriptPath,
  TranscriptFollower,
  type SessionQuery,
  type SessionRecord,
} from "./claudeSession.ts"
import { readGitState, readPullRequest, type GitState, type PullRequest } from "./git.ts"
import { TranscriptReader } from "./transcript.ts"
import { buildLinkRows, renderScreen, type LinkRow, type OverviewState } from "./view.ts"

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l"
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l"
const KEY_PATTERN = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g
const SESSION_POLL_MILLISECONDS = 1_000
const GIT_POLL_MILLISECONDS = 5_000
const PULL_REQUEST_POLL_MILLISECONDS = 60_000
const STANDARD_CONTEXT_WINDOW_TOKENS = 200_000
const LARGE_CONTEXT_WINDOW_TOKENS = 1_000_000
const LARGE_WINDOW_MODEL_PATTERN = /fable|mythos|opus-5|\[1m\]/

const commandArguments = process.argv.slice(2)
if (commandArguments.includes("--version")) {
  console.log(packageInfo.version)
  process.exit(0)
}
if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error("rexysesh needs a terminal")
  process.exit(1)
}

function optionValue(optionName: string): string | undefined {
  const optionIndex = commandArguments.indexOf(optionName)
  return optionIndex >= 0 ? commandArguments[optionIndex + 1] : undefined
}

const paneProcessIds = (optionValue("--pids") ?? "").split(",").map(Number).filter((processId) => processId > 0)
const sessionQuery: SessionQuery = {
  processIds: paneProcessIds,
  workingDirectory: optionValue("--cwd") ?? (paneProcessIds.length === 0 ? process.cwd() : undefined),
  sessionId: optionValue("--session-id"),
}
const gitBinary = optionValue("--git") || "git"
const ghBinary = commandArguments.includes("--no-gh") ? "" : optionValue("--gh") || "gh"
const configuredContextWindowTokens = Number(optionValue("--context-window")) || undefined

let session: SessionRecord | null = null
let transcript: TranscriptFollower | null = null
let summary = new TranscriptReader().summary()
let git: GitState | null | undefined
let pullRequest: PullRequest | null = null
let pullRequestLookup: OverviewState["pullRequestLookup"] = ghBinary ? "loading" : "unavailable"
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

function selectedLinkIndex(): number {
  return Math.max(0, links.findIndex((row) => row.url === selectedLinkUrl))
}

function render() {
  links = buildLinkRows(summary, pullRequest)
  const lines = renderScreen(
    {
      session,
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

async function refreshPullRequest() {
  const directory = repositoryDirectory()
  if (!directory || !ghBinary) return
  const generation = repositoryGeneration
  pullRequestReadAt = Date.now()
  const foundPullRequest = git === null ? null : await readPullRequest(ghBinary, directory)
  if (generation !== repositoryGeneration) return
  pullRequest = foundPullRequest
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
    if (now - gitReadAt >= GIT_POLL_MILLISECONDS) void refreshGit()
    else if (now - pullRequestReadAt >= PULL_REQUEST_POLL_MILLISECONDS) void refreshPullRequest()
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
  const targetIndex = Math.min(links.length - 1, Math.max(0, selectedLinkIndex() + step))
  selectedLinkUrl = links[targetIndex]?.url
}

function runDetached(command: string[], input?: string): boolean {
  try {
    const child = Bun.spawn(command, { stdin: input === undefined ? "ignore" : "pipe", stdout: "ignore", stderr: "ignore" })
    if (input !== undefined && child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
    return true
  } catch {
    return false
  }
}

function copyToClipboard(text: string, copiedMessage: string) {
  const clipboardCommand = process.platform === "darwin" ? ["pbcopy"] : ["wl-copy"]
  statusMessage = runDetached(clipboardCommand, text) ? copiedMessage : `could not run ${clipboardCommand[0]}`
}

function openSelectedLink() {
  const selectedLink = links[selectedLinkIndex()]
  if (!selectedLink) {
    statusMessage = "no link to open"
    return
  }
  const openCommand = process.platform === "darwin" ? "open" : "xdg-open"
  statusMessage = runDetached([openCommand, selectedLink.url]) ? `opened ${selectedLink.url}` : `could not run ${openCommand}`
}

function copySelectedLink() {
  const selectedLink = links[selectedLinkIndex()]
  if (selectedLink) copyToClipboard(selectedLink.url, "copied the link")
  else statusMessage = "no link to copy"
}

function quit() {
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
      return moveSelection(-Number.MAX_SAFE_INTEGER)
    case "G":
      return moveSelection(Number.MAX_SAFE_INTEGER)
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
