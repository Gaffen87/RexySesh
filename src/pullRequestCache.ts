// Keeps the pull requests of a directory's branch on disk. Asking GitHub takes most of a
// second, so the link picker shows the kept ones at once and has them renewed for next time.
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { PullRequest } from "./git.ts"

type CachedPullRequests = { directory: string; branch: string; pullRequests: PullRequest[] }

function cacheDirectory(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "rexysesh", "pull-requests")
}

function cachePathOf(directory: string): string {
  return join(cacheDirectory(), `${createHash("sha1").update(directory).digest("hex")}.json`)
}

// Undefined means nothing is kept for this branch, which is not the same as no pull request.
export function readCachedPullRequests(directory: string, branch: string): PullRequest[] | undefined {
  try {
    const cached: CachedPullRequests = JSON.parse(readFileSync(cachePathOf(directory), "utf8"))
    const isForBranch = cached.directory === directory && cached.branch === branch
    return isForBranch && Array.isArray(cached.pullRequests) ? cached.pullRequests : undefined
  } catch {
    return undefined
  }
}

// Written beside the file and then renamed, so a reader never sees half a file.
export function writeCachedPullRequests(directory: string, branch: string, pullRequests: PullRequest[]) {
  const cached: CachedPullRequests = { directory, branch, pullRequests }
  const cachePath = cachePathOf(directory)
  const unfinishedPath = `${cachePath}.${process.pid}`
  try {
    mkdirSync(cacheDirectory(), { recursive: true })
    writeFileSync(unfinishedPath, JSON.stringify(cached))
    renameSync(unfinishedPath, cachePath)
  } catch {
    // Without the cache the next lookup only takes longer.
  }
}
