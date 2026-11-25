// Reads the links of a session once, for the command palette, without a terminal.
import {
  findSessionRecord,
  findTranscriptPath,
  sessionProcessIds,
  TranscriptFollower,
  type SessionQuery,
} from "./claudeSession.ts"
import { readDevServers } from "./devServers.ts"
import { readBranchPullRequests, readGitState, type PullRequest } from "./git.ts"
import { readCachedPullRequests, writeCachedPullRequests } from "./pullRequestCache.ts"
import { TranscriptReader, type TranscriptSummary } from "./transcript.ts"
import { buildLinkRows, type LinkRow } from "./view.ts"

export type SessionLink = {
  kind: LinkRow["kind"]
  url: string
  title: string
  detail: string
  isOnCurrentBranch: boolean
}

// The pull request of the session's branch comes first: it is the likeliest choice.
export function toSessionLinks(rows: LinkRow[]): SessionLink[] {
  const sessionLinks = rows.map((row) => ({
    kind: row.kind,
    url: row.url,
    title: row.title,
    detail: row.detail,
    isOnCurrentBranch: row.kind === "pullRequest" && !!row.isOnCurrentBranch,
  }))
  return [
    ...sessionLinks.filter((sessionLink) => sessionLink.isOnCurrentBranch),
    ...sessionLinks.filter((sessionLink) => !sessionLink.isOnCurrentBranch),
  ]
}

function readSessionSummary(sessionQuery: SessionQuery): { summary: TranscriptSummary; directory: string } | null {
  const session = findSessionRecord(sessionQuery)
  if (!session) return null
  const transcriptPath = findTranscriptPath(session.sessionId)
  const transcript = transcriptPath ? new TranscriptFollower(transcriptPath) : null
  transcript?.readNewLines()
  const summary = (transcript?.reader ?? new TranscriptReader()).summary()
  return { summary, directory: summary.workingDirectory ?? session.cwd }
}

async function askForPullRequests(ghBinary: string, directory: string, branch: string): Promise<PullRequest[]> {
  const pullRequests = await readBranchPullRequests(ghBinary, directory)
  writeCachedPullRequests(directory, branch, pullRequests)
  return pullRequests
}

// Null means that no session was found. The pull requests kept for the branch are used when
// there are any, so that the links come without waiting for GitHub.
export async function readSessionLinks(
  sessionQuery: SessionQuery,
  gitBinary: string,
  ghBinary: string,
): Promise<SessionLink[] | null> {
  const found = readSessionSummary(sessionQuery)
  if (!found) return null
  const { summary, directory } = found
  const [git, devServers] = await Promise.all([
    readGitState(gitBinary, directory),
    readDevServers(directory, sessionProcessIds()),
  ])
  let branchPullRequests: PullRequest[] = []
  if (git && ghBinary) {
    branchPullRequests =
      readCachedPullRequests(directory, git.branch) ?? (await askForPullRequests(ghBinary, directory, git.branch))
  }
  return toSessionLinks(buildLinkRows(summary, branchPullRequests, git?.repositoryUrl, devServers, directory))
}

// Asks GitHub again and keeps the answer for the next call of readSessionLinks.
export async function renewCachedPullRequests(sessionQuery: SessionQuery, gitBinary: string, ghBinary: string) {
  const found = readSessionSummary(sessionQuery)
  if (!found || !ghBinary) return
  const git = await readGitState(gitBinary, found.directory)
  if (git) await askForPullRequests(ghBinary, found.directory, git.branch)
}
