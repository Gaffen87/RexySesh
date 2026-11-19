// Reads a working directory's branch from git, and its pull request from the GitHub CLI.
import { outputOf } from "./command.ts"

export type GitState = {
  branch: string
  upstream?: string
  repositoryUrl?: string
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
  stack?: StackPlace
}

// Where a pull request sits in a stack made with gh stack, counted from the trunk.
export type StackPlace = { position: number; size: number; isCurrentBranch: boolean; needsRebase: boolean }

export type StackedBranch = {
  branch: string
  isCurrentBranch: boolean
  needsRebase: boolean
  number: number
  url: string
  state: string
}

const PULL_REQUEST_FIELDS = "number,title,url,state,isDraft,reviewDecision,statusCheckRollup"
const PASSED_CHECK_RESULTS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])
const PENDING_CHECK_RESULTS = new Set(["", "PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING"])

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

// Turns a remote's address, in any of git's forms, into the address of its web page.
export function webUrlOfRemote(remoteAddress: string): string | undefined {
  const address = remoteAddress.trim().replace(/\.git$/, "").replace(/\/$/, "")
  const overSsh = address.match(/^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+\/|[:/])(.+)$/)
  const overHttp = address.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/)
  const [, host, repositoryPath] = overHttp ?? overSsh ?? []
  return host && repositoryPath ? `https://${host}/${repositoryPath}` : undefined
}

// Null means the directory is not in a git repository.
export async function readGitState(gitBinary: string, workingDirectory: string): Promise<GitState | null> {
  const statusOutput = await outputOf([gitBinary, "status", "--porcelain=v2", "--branch"], workingDirectory)
  if (statusOutput === null) return null
  const state = parseGitStatus(statusOutput)
  const remoteName = state.upstream?.split("/")[0] ?? "origin"
  const remoteAddress = await outputOf([gitBinary, "remote", "get-url", remoteName], workingDirectory)
  if (remoteAddress) state.repositoryUrl = webUrlOfRemote(remoteAddress)
  return state
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

// Null means there is no such pull request, or the GitHub CLI could not tell.
// Without a number it is the pull request of the directory's branch.
async function readPullRequest(
  ghBinary: string,
  workingDirectory: string,
  pullRequestNumber?: number,
): Promise<PullRequest | null> {
  const selector = pullRequestNumber === undefined ? [] : [String(pullRequestNumber)]
  const command = [ghBinary, "pr", "view", ...selector, "--json", PULL_REQUEST_FIELDS]
  const pullRequestJson = await outputOf(command, workingDirectory)
  return pullRequestJson === null ? null : parsePullRequest(pullRequestJson)
}

// Reads the output of "gh stack view --json": the stack's branches that have a pull request,
// from the trunk upward. A branch outside a stack gives none.
export function parseStack(stackJson: string): StackedBranch[] {
  let stack: Record<string, any>
  try {
    stack = JSON.parse(stackJson)
  } catch {
    return []
  }
  const branches: Record<string, any>[] = Array.isArray(stack?.branches) ? stack.branches : []
  return branches
    .filter((branch) => typeof branch?.pr?.url === "string")
    .map((branch) => ({
      branch: String(branch.name ?? ""),
      isCurrentBranch: !!branch.isCurrent,
      needsRebase: !!branch.needsRebase,
      number: branch.pr.number,
      url: branch.pr.url,
      state: branch.isMerged ? "MERGED" : String(branch.pr.state ?? ""),
    }))
}

// The pull requests of the directory's branch: every one in its stack, from the trunk upward,
// or the branch's own when it is not stacked.
export async function readBranchPullRequests(ghBinary: string, workingDirectory: string): Promise<PullRequest[]> {
  const [branchPullRequest, stackJson] = await Promise.all([
    readPullRequest(ghBinary, workingDirectory),
    outputOf([ghBinary, "stack", "view", "--json"], workingDirectory),
  ])
  const stackedBranches = stackJson === null ? [] : parseStack(stackJson)
  if (stackedBranches.length < 2) return branchPullRequest ? [branchPullRequest] : []
  return Promise.all(
    stackedBranches.map(async (stackedBranch, branchIndex) => {
      const details =
        stackedBranch.number === branchPullRequest?.number
          ? branchPullRequest
          : await readPullRequest(ghBinary, workingDirectory, stackedBranch.number)
      const pullRequest: PullRequest = details ?? {
        url: stackedBranch.url,
        number: stackedBranch.number,
        title: stackedBranch.branch,
        state: stackedBranch.state,
        isDraft: false,
        passedCheckCount: 0,
        failedCheckCount: 0,
        pendingCheckCount: 0,
      }
      return {
        ...pullRequest,
        stack: {
          position: branchIndex + 1,
          size: stackedBranches.length,
          isCurrentBranch: stackedBranch.isCurrentBranch,
          needsRebase: stackedBranch.needsRebase,
        },
      }
    }),
  )
}
