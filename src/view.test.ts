import { expect, test } from "bun:test"
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
  summary.touchedFiles = [{ path: "/work/app/src/main.ts", editCount: 3 }]
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
  return {
    session: { pid: 1, sessionId: "c265e554", cwd: "/work/app", startedAt: NOW - 3_600_000, status: "busy", statusUpdatedAt: NOW - 120_000 },
    summary,
    git: { branch: "feature/overview", upstream: "origin/feature/overview", aheadCount: 1, behindCount: 0, changedFileCount: 2 },
    pullRequestLookup: "done",
    links: buildLinkRows(summary, pullRequest),
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
    "#7 Add the overview",
    "https://github.com/acme/app/pull/7",
    "✓ 11 checks · approved",
    "45%",
    "90k of 200k tokens · 110k left",
    "Artifact 1",
    "https://claude.ai/artifact/1",
    "src/main.ts",
    "● working for 2m",
  ]) {
    expect(screen).toContain(expected)
  }
})

test("a pull request the session opened is listed once, after the branch's own", () => {
  const summary = new TranscriptReader().summary()
  summary.pullRequestLinks = [
    { url: "https://github.com/acme/app/pull/7", number: 7, repository: "acme/app" },
    { url: "https://github.com/acme/app/pull/8", number: 8, repository: "acme/app" },
  ]
  const rows = buildLinkRows(summary, null)
  expect(rows.map((row) => row.title)).toEqual(["acme/app#7", "acme/app#8"])
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
