// Reads the links of a session once, for the command palette, without a terminal.
import { findSessionRecord, findTranscriptPath, TranscriptFollower, type SessionQuery } from "./claudeSession.ts"
import { readDevServers } from "./devServers.ts"
import { readBranchPullRequests, readGitState } from "./git.ts"
import { TranscriptReader } from "./transcript.ts"
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

// Null means that no session was found.
export async function readSessionLinks(
  sessionQuery: SessionQuery,
  gitBinary: string,
  ghBinary: string,
): Promise<SessionLink[] | null> {
  const session = findSessionRecord(sessionQuery)
  if (!session) return null
  const transcriptPath = findTranscriptPath(session.sessionId)
  const transcript = transcriptPath ? new TranscriptFollower(transcriptPath) : null
  transcript?.readNewLines()
  const summary = (transcript?.reader ?? new TranscriptReader()).summary()
  const directory = summary.workingDirectory ?? session.cwd
  const [git, branchPullRequests, devServers] = await Promise.all([
    readGitState(gitBinary, directory),
    ghBinary ? readBranchPullRequests(ghBinary, directory) : [],
    readDevServers(directory),
  ])
  return toSessionLinks(buildLinkRows(summary, branchPullRequests, git?.repositoryUrl, devServers, directory))
}
