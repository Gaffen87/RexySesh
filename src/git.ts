// Reads a working directory's branch from git, and its pull request from the GitHub CLI.

export type GitState = {
  branch: string
  upstream?: string
  aheadCount: number
  behindCount: number
  changedFileCount: number
}

export type PullRequest = {
  url: string
  number: number
  title: string
  state: string
  isDraft: boolean
  reviewDecision?: string
  passedCheckCount: number
  failedCheckCount: number
  pendingCheckCount: number
}

const COMMAND_TIMEOUT_MILLISECONDS = 15_000
const PULL_REQUEST_FIELDS = "number,title,url,state,isDraft,reviewDecision,statusCheckRollup"
const PASSED_CHECK_RESULTS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])
const PENDING_CHECK_RESULTS = new Set(["", "PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING"])

async function outputOf(command: string[], workingDirectory: string): Promise<string | null> {
  try {
    const child = Bun.spawn(command, {
      cwd: workingDirectory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: COMMAND_TIMEOUT_MILLISECONDS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    })
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return exitCode === 0 ? output : null
  } catch {
    return null
  }
}

export function parseGitStatus(statusOutput: string): GitState {
  const state: GitState = { branch: "", aheadCount: 0, behindCount: 0, changedFileCount: 0 }
  for (const line of statusOutput.split("\n")) {
    if (line.startsWith("# branch.head ")) state.branch = line.slice("# branch.head ".length)
    else if (line.startsWith("# branch.upstream ")) state.upstream = line.slice("# branch.upstream ".length)
    else if (line.startsWith("# branch.ab ")) {
      const [aheadPart = "", behindPart = ""] = line.slice("# branch.ab ".length).split(" ")
      state.aheadCount = Math.abs(Number(aheadPart)) || 0
      state.behindCount = Math.abs(Number(behindPart)) || 0
    } else if (line && !line.startsWith("#")) state.changedFileCount += 1
  }
  return state
}

// Null means the directory is not in a git repository.
export async function readGitState(gitBinary: string, workingDirectory: string): Promise<GitState | null> {
  const statusOutput = await outputOf([gitBinary, "status", "--porcelain=v2", "--branch"], workingDirectory)
  return statusOutput === null ? null : parseGitStatus(statusOutput)
}

export function parsePullRequest(pullRequestJson: string): PullRequest | null {
  let fields: Record<string, any>
  try {
    fields = JSON.parse(pullRequestJson)
  } catch {
    return null
  }
  if (typeof fields?.url !== "string") return null
  const pullRequest: PullRequest = {
    url: fields.url,
    number: fields.number,
    title: fields.title ?? "",
    state: fields.state ?? "",
    isDraft: !!fields.isDraft,
    reviewDecision: fields.reviewDecision || undefined,
    passedCheckCount: 0,
    failedCheckCount: 0,
    pendingCheckCount: 0,
  }
  for (const check of Array.isArray(fields.statusCheckRollup) ? fields.statusCheckRollup : []) {
    const result = String(check?.conclusion || check?.state || check?.status || "").toUpperCase()
    if (PASSED_CHECK_RESULTS.has(result)) pullRequest.passedCheckCount += 1
    else if (PENDING_CHECK_RESULTS.has(result)) pullRequest.pendingCheckCount += 1
    else pullRequest.failedCheckCount += 1
  }
  return pullRequest
}

// Null means the branch has no pull request, or the GitHub CLI could not tell.
export async function readPullRequest(ghBinary: string, workingDirectory: string): Promise<PullRequest | null> {
  const pullRequestJson = await outputOf([ghBinary, "pr", "view", "--json", PULL_REQUEST_FIELDS], workingDirectory)
  return pullRequestJson === null ? null : parsePullRequest(pullRequestJson)
}
