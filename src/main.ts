// RexySesh: an overview of a Claude Code session for the terminal, made to run in a Rex pane.
// Without a terminal it can also list the session's links, or open one, for Rex's command palette.
import packageInfo from "../package.json"
import type { SessionQuery } from "./claudeSession.ts"
import { BROWSER_COMMAND, openInBrowser } from "./command.ts"
import { readSessionLinks } from "./links.ts"
import { startOverview } from "./overview.ts"

const commandArguments = process.argv.slice(2)

function optionValue(optionName: string): string | undefined {
  const optionIndex = commandArguments.indexOf(optionName)
  return optionIndex >= 0 ? commandArguments[optionIndex + 1] : undefined
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const paneProcessIds = (optionValue("--pids") ?? "").split(",").map(Number).filter((processId) => processId > 0)
const sessionQuery: SessionQuery = {
  processIds: paneProcessIds,
  workingDirectory: optionValue("--cwd") ?? (paneProcessIds.length === 0 ? process.cwd() : undefined),
  sessionId: optionValue("--session-id"),
}
const gitBinary = optionValue("--git") || "git"
const ghBinary = commandArguments.includes("--no-gh") ? "" : optionValue("--gh") || "gh"
const rexBinary = optionValue("--rex")
const rexSessionId = optionValue("--session")
const rexBlockId = optionValue("--block")

if (commandArguments.includes("--version")) {
  console.log(packageInfo.version)
} else if (commandArguments.includes("--open")) {
  const url = optionValue("--open")
  if (!url || !/^https?:\/\//.test(url)) fail("--open needs an http or https address")
  if (!(await openInBrowser(url))) fail(`could not run ${BROWSER_COMMAND}`)
} else if (commandArguments.includes("--links")) {
  const sessionLinks = await readSessionLinks(sessionQuery, gitBinary, ghBinary)
  if (!sessionLinks) fail("no Claude Code session runs in this pane")
  console.log(JSON.stringify(sessionLinks))
  process.exit(0)
} else {
  startOverview({
    sessionQuery,
    gitBinary,
    ghBinary,
    contextWindowTokens: Number(optionValue("--context-window")) || undefined,
    rexPane:
      rexBinary && rexSessionId && rexBlockId
        ? { rexBinary, sessionId: rexSessionId, blockId: rexBlockId }
        : undefined,
  })
}
