import { expect, test } from "bun:test"
import { parseListeningSockets, parseWorkingDirectories, processNameOf } from "./devServers.ts"
import { parseProxyRoutes } from "./pitchfork.ts"
import { displayWidth, hyperlink } from "./text.ts"
import { TranscriptReader } from "./transcript.ts"
import {
  buildLinkRows,
  formatDuration,
  formatTokens,
  panelHeights,
  renderScreen,
  scrollOffsetFor,
  type OverviewState,
} from "./view.ts"

const NOW = Date.parse("2026-11-19T10:00:00Z")

function stateWith(artifactCount: number, overrides: Partial<OverviewState> = {}): OverviewState {
  const summary = new TranscriptReader().summary()
  summary.title = "Session overview plugin"
  summary.model = "claude-fable-5-2"
  summary.lastPrompt = "make a pane plugin\nthat shows the session 🙂 with a long prompt that has to wrap around"
  summary.contextTokens = 90_000
  summary.artifacts = Array.from({ length: artifactCount }, (_unused, artifactIndex) => ({
    url: `https://claude.ai/artifact/${artifactIndex}`,
    title: `Artifact ${artifactIndex}`,
    version: artifactIndex + 1,
  }))
  const pullRequest = {
    url: "https://github.com/acme/app/pull/7",
    number: 7,
    title: "Add the overview",
    state: "OPEN",
    isDraft: false,
    reviewDecision: "APPROVED",
    passedCheckCount: 11,
    failedCheckCount: 0,
    pendingCheckCount: 0,
  }
  const devServer = { url: "http://localhost:5173", port: 5173, processName: "vite", directory: "/work/app/web" }
  return {
    session: { pid: 1, sessionId: "c265e554", cwd: "/work/app", startedAt: NOW - 3_600_000, status: "busy", statusUpdatedAt: NOW - 120_000 },
    programStatus: null,
    summary,
    git: { branch: "feature/overview", upstream: "origin/feature/overview", aheadCount: 1, behindCount: 0, changedFileCount: 2 },
    pullRequestLookup: "done",
    links: buildLinkRows(summary, [pullRequest], "https://github.com/acme/app", [devServer], "/work/app"),
    selectedLinkIndex: 0,
    contextWindowTokens: 200_000,
    statusMessage: "updated 10:00",
    now: NOW,
    ...overrides,
  }
}

test("every line is exactly as wide as the terminal, at any size", () => {
  const sizes: [width: number, height: number][] = [[40, 10], [60, 14], [80, 24], [109, 30], [110, 30], [200, 60]]
  for (const artifactCount of [0, 2, 30]) {
    for (const [width, height] of sizes) {
      for (const selectedLinkIndex of [0, artifactCount]) {
        const lines = renderScreen(stateWith(artifactCount, { selectedLinkIndex }), width, height)
        expect(lines.length).toBe(height)
        for (const line of lines) expect(displayWidth(line)).toBe(width)
      }
    }
  }
})

test("the screen without a session or a repository still fills the terminal", () => {
  const withoutSession = renderScreen(stateWith(0, { session: null }), 80, 24)
  const withoutRepository = renderScreen(stateWith(0, { git: null, links: [] }), 120, 30)
  for (const line of withoutSession) expect(displayWidth(line)).toBe(80)
  for (const line of withoutRepository) expect(displayWidth(line)).toBe(120)
  expect(withoutSession.join("\n")).toContain("No Claude Code session")
  expect(withoutRepository.join("\n")).toContain("Not a git repository")
})

test("the screen shows the branch, the pull request, the context and the artifacts", () => {
  const screen = renderScreen(stateWith(2), 140, 40).join("\n")
  for (const expected of [
    "feature/overview",
    "acme/app",
    "https://github.com/acme/app ",
    "#7 Add the overview",
    "https://github.com/acme/app/pull/7",
    "✓ 11 checks · approved",
    "45%",
    "90k of 200k tokens · 110k left",
    "Artifact 1",
    "https://claude.ai/artifact/1",
    "localhost:5173",
    "vite · web",
    "http://localhost:5173 ",
    "● working for 2m",
  ]) {
    expect(screen).toContain(expected)
  }
})

test("the status Claude reports to Rex is shown before the session file's", () => {
  const screenWith = (programStatus: OverviewState["programStatus"]) =>
    renderScreen(stateWith(0, { programStatus }), 120, 40).join("\n")
  const since = { stateSince: NOW - 30_000, taskTitles: [] }

  const working = screenWith({ state: "working", message: "Running the tests", stateSince: NOW - 30_000, taskTitles: ["Explore the code"] })
  for (const expected of ["● working for 30s", "Running the tests", "Explore the code"]) expect(working).toContain(expected)
  expect(working).not.toContain("working for 2m")

  expect(screenWith({ state: "blocked", blockedKind: "permission", ...since })).toContain("◆ needs you: permission for 30s")
  expect(screenWith({ state: "blocked", ...since })).toContain("◆ needs you for 30s")
  expect(screenWith({ state: "done", ...since })).toContain("○ waiting for you for 30s")
  expect(screenWith({ state: "error", taskTitles: [] })).toContain("✗ error ")
  expect(screenWith({ state: "working", taskTitles: [] })).toContain("● working for 2m")
  expect(screenWith({ state: "blocked", taskTitles: [] })).toContain("◆ needs you ")
  expect(screenWith(null)).toContain("● working for 2m")
})

test("a pull request the session opened is listed once, after the branch's own", () => {
  const summary = new TranscriptReader().summary()
  summary.pullRequestLinks = [
    { url: "https://github.com/acme/app/pull/7", number: 7, repository: "acme/app" },
    { url: "https://github.com/acme/app/pull/8", number: 8, repository: "acme/app" },
  ]
  const rows = buildLinkRows(summary, [])
  expect(rows.map((row) => row.title)).toEqual(["acme/app#7", "acme/app#8"])
})

test("a stack lists every pull request with its place, and prefers the branch's own", () => {
  const stacked = (number: number, position: number, isCurrentBranch: boolean) => ({
    url: `https://github.com/acme/app/pull/${number}`,
    number,
    title: `Layer ${position}`,
    state: "OPEN",
    isDraft: false,
    passedCheckCount: 3,
    failedCheckCount: 0,
    pendingCheckCount: 0,
    stack: { position, size: 3, isCurrentBranch, needsRebase: position === 1 },
  })
  const summary = new TranscriptReader().summary()
  summary.pullRequestLinks = [{ url: "https://github.com/acme/app/pull/12", number: 12, repository: "acme/app" }]
  const rows = buildLinkRows(summary, [stacked(11, 1, false), stacked(12, 2, true), stacked(13, 3, false)])
  expect(rows.map((row) => [row.title, row.detail, !!row.isOnCurrentBranch])).toEqual([
    ["#11 Layer 1", "1/3 · open · needs rebase · ✓ 3 checks", false],
    ["#12 Layer 2", "2/3 · open · ✓ 3 checks", true],
    ["#13 Layer 3", "3/3 · open · ✓ 3 checks", false],
  ])
})

test("only the pull request of the current branch gets the marker", () => {
  const stacked = (number: number, isCurrentBranch: boolean) => ({
    url: `https://github.com/acme/app/pull/${number}`,
    number,
    title: `Layer ${number}`,
    state: "OPEN",
    isDraft: false,
    passedCheckCount: 0,
    failedCheckCount: 0,
    pendingCheckCount: 0,
    stack: { position: number, size: 2, isCurrentBranch, needsRebase: false },
  })
  const summary = new TranscriptReader().summary()
  const links = buildLinkRows(summary, [stacked(1, false), stacked(2, true)])
  const markedLines = renderScreen(stateWith(0, { links, selectedLinkIndex: 0 }), 100, 40)
    .map((line) => Bun.stripANSI(line))
    .filter((line) => line.includes("▶"))
  expect(markedLines.length).toBe(1)
  expect(markedLines[0]).toContain("▶ #2 Layer 2")
})

test("a hyperlink is as wide as its text", () => {
  expect(displayWidth(hyperlink("https://example.com/a/long/address", "link"))).toBe(4)
})

function panelOf(lineCount: number, isFlexible: boolean, yieldRank: number, smallestHeight: number) {
  return {
    title: "",
    isFocused: false,
    isFlexible,
    yieldRank,
    smallestHeight,
    contentLines: Array.from({ length: lineCount }, () => ""),
  }
}

test("spare lines go to the flexible panels", () => {
  const panels = [panelOf(4, false, 1, 5), panelOf(2, true, 2, 4), panelOf(2, true, 0, 0)]
  expect(panelHeights(panels, 20)).toEqual([6, 7, 7])
})

test("a short column trims its lists, then shrinks and drops panels by rank", () => {
  const panels = [panelOf(11, false, 1, 5), panelOf(3, false, 4, 3), panelOf(40, true, 2, 4), panelOf(20, true, 0, 0)]
  expect(panelHeights(panels, 40)).toEqual([13, 5, 11, 11])
  expect(panelHeights(panels, 26)).toEqual([13, 5, 8, 0])
  expect(panelHeights(panels, 16)).toEqual([5, 5, 6, 0])
  expect(panelHeights(panels, 9)).toEqual([0, 3, 6, 0])
  for (const columnHeight of [9, 12, 16, 23, 26, 40, 80]) {
    const heights = panelHeights(panels, columnHeight)
    expect(heights.reduce((total, height) => total + height, 0)).toBe(columnHeight)
    for (const height of heights) expect(height === 0 || height >= 3).toBe(true)
  }
})

test("numbers and durations are short", () => {
  expect(formatTokens(950)).toBe("950")
  expect(formatTokens(90_000)).toBe("90k")
  expect(formatTokens(83_175)).toBe("83.2k")
  expect(formatTokens(1_000_000)).toBe("1M")
  expect(formatDuration(42_000)).toBe("42s")
  expect(formatDuration(3_900_000)).toBe("1h 5m")
  expect(scrollOffsetFor(50, 60, 10)).toBe(45)
})

test("listening sockets, working directories and program names are read from lsof and ps", () => {
  const socketsOutput = ["p24270", "f9", "n127.0.0.1:3002", "p46339", "f10", "n*:3000", "f11", "n[::1]:3000", ""].join("\n")
  expect(parseListeningSockets(socketsOutput)).toEqual([
    { processId: 24270, host: "127.0.0.1", port: 3002 },
    { processId: 46339, host: "*", port: 3000 },
    { processId: 46339, host: "[::1]", port: 3000 },
  ])
  const directoriesOutput = ["p24270", "fcwd", "n/work/app", "p46339", "fcwd", "n/work/other", ""].join("\n")
  expect([...parseWorkingDirectories(directoriesOutput)]).toEqual([[24270, "/work/app"], [46339, "/work/other"]])
  expect(processNameOf("puma 8.0.2 (tcp://127.0.0.1:3002) [app]")).toBe("puma")
  expect(processNameOf("node /work/app/node_modules/.bin/vite --host")).toBe("vite")
  expect(processNameOf("/usr/local/bin/node --inspect server.js")).toBe("node")
})

test("a pitchfork proxy gives a route for each slug, with the port of its daemon", () => {
  const configToml = `
[settings.proxy]
port = 18088

[slugs.app-af1c]
namespace = "app-586c"
daemon = "rails"

[slugs.docs]
dir = "/work/docs"

[namespaces.app-586c]
dir = "/work/app"
`
  const stateToml = `
[daemons."app-586c/css"]
id = "app-586c/css"
dir = "/work/app"

[daemons."app-586c/rails"]
id = "app-586c/rails"
dir = "/work/app"
active_port = 3001
`
  expect(parseProxyRoutes(configToml, stateToml)).toEqual([
    { slug: "app-af1c", directory: "/work/app", daemonPort: 3001 },
    { slug: "docs", directory: "/work/docs", daemonPort: undefined },
  ])
  expect(parseProxyRoutes("not [toml", "")).toEqual([])
})
