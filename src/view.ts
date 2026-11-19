// Draws the whole screen, in the style of lazygit, as lines of exactly the terminal's width.
// It reads no state of its own.
import { homedir } from "node:os"
import type { SessionRecord } from "./claudeSession.ts"
import type { GitState, PullRequest } from "./git.ts"
import type { TranscriptSummary } from "./transcript.ts"
import {
  displayWidth,
  fitToWidth,
  hyperlink,
  plain,
  singleLine,
  style,
  truncateToWidth,
  wrapToWidth,
  type Colorize,
} from "./text.ts"

export type LinkRow = {
  kind: "pullRequest" | "artifact"
  url: string
  title: string
  detail: string
  markerColor: Colorize
}

export type OverviewState = {
  session: SessionRecord | null
  summary: TranscriptSummary
  // Undefined while git is still being asked; null outside a repository.
  git: GitState | null | undefined
  pullRequestLookup: "loading" | "done" | "unavailable"
  links: LinkRow[]
  selectedLinkIndex: number
  contextWindowTokens: number
  statusMessage: string
  now: number
}

type Panel = {
  title: string
  footer?: string
  isFocused: boolean
  // A flexible panel takes the spare lines of a tall column.
  isFlexible: boolean
  // In a short column the panel with the lowest rank gives way first, down to its smallest height.
  yieldRank: number
  smallestHeight: number
  // Scrolling keeps this line in view.
  anchorLineIndex?: number
  contentLines: string[]
}

const KEY_HINTS: [key: string, action: string][] = [
  ["↑↓", "select link"],
  ["enter", "open"],
  ["y", "copy link"],
  ["i", "copy session id"],
  ["r", "refresh"],
  ["q", "quit"],
]
const LABEL_WIDTH = 9
const TWO_COLUMN_WIDTH = 110
const SMALLEST_FRAME_HEIGHT = 3
const COMFORTABLE_LIST_HEIGHT = 6
const SHOWN_TOOL_COUNT = 4

export function formatTokens(tokenCount: number): string {
  if (tokenCount >= 999_950) return `${(tokenCount / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (tokenCount >= 1_000) return `${(tokenCount / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(tokenCount)
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  if (hours < 24) return `${hours}h ${totalMinutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function countOf(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`
}

function shortenHome(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function pullRequestState(pullRequest: PullRequest): { label: string; color: Colorize } {
  if (pullRequest.state === "MERGED") return { label: "merged", color: style.magenta }
  if (pullRequest.state === "CLOSED") return { label: "closed", color: style.red }
  if (pullRequest.isDraft) return { label: "draft", color: style.dim }
  return { label: "open", color: style.green }
}

function pullRequestDetail(pullRequest: PullRequest): string {
  const parts = [pullRequestState(pullRequest).label]
  if (pullRequest.failedCheckCount > 0) parts.push(`✗ ${countOf(pullRequest.failedCheckCount, "check")}`)
  else if (pullRequest.pendingCheckCount > 0) parts.push(`… ${countOf(pullRequest.pendingCheckCount, "check")}`)
  else if (pullRequest.passedCheckCount > 0) parts.push(`✓ ${countOf(pullRequest.passedCheckCount, "check")}`)
  if (pullRequest.reviewDecision) parts.push(pullRequest.reviewDecision.toLowerCase().replace(/_/g, " "))
  return parts.join(" · ")
}

// The branch's pull request comes first, then any others the session opened, then the artifacts.
export function buildLinkRows(summary: TranscriptSummary, pullRequest: PullRequest | null): LinkRow[] {
  const rows: LinkRow[] = []
  if (pullRequest) {
    rows.push({
      kind: "pullRequest",
      url: pullRequest.url,
      title: `#${pullRequest.number} ${singleLine(pullRequest.title)}`,
      detail: pullRequestDetail(pullRequest),
      markerColor: pullRequestState(pullRequest).color,
    })
  }
  for (const link of summary.pullRequestLinks) {
    if (link.url === pullRequest?.url) continue
    rows.push({
      kind: "pullRequest",
      url: link.url,
      title: `${link.repository ?? "Pull request "}#${link.number}`,
      detail: "opened in this session",
      markerColor: style.dim,
    })
  }
  for (const artifact of summary.artifacts) {
    rows.push({
      kind: "artifact",
      url: artifact.url,
      title: singleLine(artifact.title),
      detail: artifact.version ? `v${artifact.version}` : "",
      markerColor: style.cyan,
    })
  }
  return rows
}

function highlight(line: string, isSelected: boolean): string {
  return isSelected ? style.blueBackground(style.bold(line)) : line
}

function field(name: string, value: string, width: number, color: Colorize = plain): string {
  return style.cyan(fitToWidth(name, LABEL_WIDTH)) + color(fitToWidth(value, width - LABEL_WIDTH))
}

function dimLine(text: string, width: number): string {
  return style.dim(fitToWidth(text, width))
}

function linkLines(row: LinkRow, isSelected: boolean, width: number): string[] {
  const detailWidth = row.detail ? displayWidth(row.detail) + 2 : 0
  const showsDetail = width - 2 - detailWidth >= 12
  const title = fitToWidth(row.title, width - 2 - (showsDetail ? detailWidth : 0))
  const detail = showsDetail && row.detail ? `  ${style.dim(row.detail)}` : ""
  const address = hyperlink(row.url, style.dim(fitToWidth(row.url, width - 2)))
  return [
    highlight(`${row.markerColor("◆")} ${title}${detail}`, isSelected),
    highlight(`  ${address}`, isSelected),
  ]
}

function statusLabel(session: SessionRecord, now: number): { text: string; color: Colorize } {
  const since = session.statusUpdatedAt ? ` for ${formatDuration(now - session.statusUpdatedAt)}` : ""
  if (session.status === "busy") return { text: `● working${since}`, color: style.yellow }
  if (session.status === "idle") return { text: `○ waiting for you${since}`, color: style.green }
  return { text: session.status ? `${session.status}${since}` : "unknown", color: plain }
}

function sessionPanel(state: OverviewState, session: SessionRecord, width: number): Panel {
  const { summary, now } = state
  const title = singleLine(summary.title ?? session.name ?? "Claude session")
  const status = statusLabel(session, now)
  const lines = [style.bold(fitToWidth(title, width)), " ".repeat(width)]
  lines.push(field("Status", status.text, width, status.color))
  if (summary.model) {
    lines.push(field("Model", summary.effort ? `${summary.model} · ${summary.effort} effort` : summary.model, width))
  }
  if (summary.permissionMode) lines.push(field("Mode", summary.permissionMode, width))
  if (session.startedAt) {
    const startedTime = new Date(session.startedAt).toTimeString().slice(0, 5)
    const worked = summary.workedMilliseconds > 0 ? ` · worked ${formatDuration(summary.workedMilliseconds)}` : ""
    lines.push(field("Started", `${startedTime} · ${formatDuration(now - session.startedAt)} ago${worked}`, width))
  }
  const toolCallCount = [...summary.toolCounts.values()].reduce((total, count) => total + count, 0)
  const activity = [countOf(summary.promptCount, "prompt"), countOf(toolCallCount, "tool call")]
  if (summary.subagentCount > 0) activity.push(countOf(summary.subagentCount, "subagent"))
  lines.push(field("Activity", activity.join(" · "), width))
  const busiestTools = [...summary.toolCounts]
    .sort(([, firstCount], [, secondCount]) => secondCount - firstCount)
    .slice(0, SHOWN_TOOL_COUNT)
    .map(([toolName, count]) => `${toolName} ${count}`)
  if (busiestTools.length > 0) lines.push(field("Tools", busiestTools.join(" · "), width))
  lines.push(field("Dir", shortenHome(summary.workingDirectory ?? session.cwd), width))
  if (summary.lastPrompt) {
    const promptLines = wrapToWidth(singleLine(summary.lastPrompt), width - LABEL_WIDTH).slice(0, 2)
    promptLines.forEach((promptLine, lineIndex) => {
      lines.push(field(lineIndex === 0 ? "Prompt" : "", promptLine, width))
    })
  }
  lines.push(field("Session", session.sessionId, width, style.dim))
  return { title: "Session", isFocused: false, isFlexible: false, yieldRank: 1, smallestHeight: 5, contentLines: lines }
}

function contextPanel(state: OverviewState, width: number): Panel {
  const { summary, contextWindowTokens } = state
  const usedShare = Math.min(1, summary.contextTokens / contextWindowTokens)
  const usedPercent = Math.round(usedShare * 100)
  const barColor = usedPercent >= 85 ? style.red : usedPercent >= 60 ? style.yellow : style.green
  const barWidth = Math.max(4, Math.min(40, width - 6))
  const filledWidth = Math.round(usedShare * barWidth)
  const bar = barColor("█".repeat(filledWidth)) + style.dim("░".repeat(barWidth - filledWidth))
  const percentLabel = fitToWidth(` ${usedPercent}%`, width - barWidth)
  const freeTokens = Math.max(0, contextWindowTokens - summary.contextTokens)
  const window = `${formatTokens(summary.contextTokens)} of ${formatTokens(contextWindowTokens)} tokens · ${formatTokens(freeTokens)} left`
  const output = `${formatTokens(summary.outputTokens)} tokens written · ${countOf(summary.compactionCount, "compaction")}`
  return {
    title: "Context",
    isFocused: false,
    isFlexible: false,
    yieldRank: 4,
    smallestHeight: 3,
    contentLines: [bar + style.bold(percentLabel), field("Window", window, width), field("Output", output, width)],
  }
}

function gitPanel(state: OverviewState, width: number): Panel {
  const { git, links, selectedLinkIndex } = state
  const pullRequestRows = links.filter((row) => row.kind === "pullRequest")
  const isFocused = links[selectedLinkIndex]?.kind === "pullRequest"
  const lines: string[] = []
  if (git === undefined) lines.push(dimLine("Asking git…", width))
  else if (git === null) lines.push(dimLine("Not a git repository", width))
  else {
    const distance = [git.aheadCount > 0 && `↑${git.aheadCount}`, git.behindCount > 0 && `↓${git.behindCount}`]
      .filter(Boolean)
      .join(" ")
    const upstream = git.upstream ? `  → ${git.upstream}` : "  (not pushed)"
    lines.push(field("Branch", `${git.branch}${distance ? `  ${distance}` : ""}${upstream}`, width, style.magenta))
    const changes = git.changedFileCount > 0 ? `± ${countOf(git.changedFileCount, "changed file")}` : "✓ clean"
    lines.push(field("Changes", changes, width, git.changedFileCount > 0 ? style.yellow : style.green))
  }
  let anchorLineIndex: number | undefined
  if (pullRequestRows.length > 0) lines.push(" ".repeat(width))
  pullRequestRows.forEach((row) => {
    const isSelected = links[selectedLinkIndex] === row
    if (isSelected) anchorLineIndex = lines.length
    lines.push(...linkLines(row, isSelected, width))
  })
  if (pullRequestRows.length === 0 && git) {
    const message =
      state.pullRequestLookup === "loading"
        ? "Looking for a pull request…"
        : state.pullRequestLookup === "unavailable"
          ? "Pull requests need the GitHub CLI (gh)"
          : "No pull request for this branch"
    lines.push(field("PR", message, width, style.dim))
  }
  return { title: "Git", isFocused, isFlexible: false, yieldRank: 3, smallestHeight: 4, anchorLineIndex, contentLines: lines }
}

function artifactsPanel(state: OverviewState, width: number): Panel {
  const { links, selectedLinkIndex } = state
  const artifactRows = links.filter((row) => row.kind === "artifact")
  const selectedPosition = artifactRows.indexOf(links[selectedLinkIndex]!)
  const lines = artifactRows.flatMap((row, rowIndex) => linkLines(row, rowIndex === selectedPosition, width))
  if (artifactRows.length === 0) lines.push(dimLine("No artifacts published in this session", width))
  return {
    title: "Artifacts",
    footer: selectedPosition >= 0 ? `${selectedPosition + 1} of ${artifactRows.length}` : "",
    isFocused: selectedPosition >= 0,
    isFlexible: true,
    yieldRank: 2,
    smallestHeight: 4,
    anchorLineIndex: selectedPosition >= 0 ? selectedPosition * 2 : undefined,
    contentLines: lines,
  }
}

function filesPanel(state: OverviewState, width: number): Panel {
  const { touchedFiles, workingDirectory } = state.summary
  const directoryPrefix = `${workingDirectory ?? state.session?.cwd ?? ""}/`
  const lines = touchedFiles.map(({ path, editCount }) => {
    const shownPath = path.startsWith(directoryPrefix) ? path.slice(directoryPrefix.length) : shortenHome(path)
    const editLabel = `×${editCount}`
    return fitToWidth(shownPath, width - displayWidth(editLabel) - 1) + " " + style.dim(editLabel)
  })
  if (lines.length === 0) lines.push(dimLine("Claude has edited no files yet", width))
  return {
    title: "Files edited by Claude",
    footer: touchedFiles.length > 0 ? countOf(touchedFiles.length, "file") : "",
    isFocused: false,
    isFlexible: true,
    yieldRank: 0,
    smallestHeight: 0,
    contentLines: lines,
  }
}

// Keeps the anchor line near the middle, so no scroll position needs storing.
export function scrollOffsetFor(anchorLineIndex: number, lineCount: number, visibleCount: number): number {
  const lastOffset = Math.max(0, lineCount - visibleCount)
  return Math.min(lastOffset, Math.max(0, anchorLineIndex - Math.floor(visibleCount / 2)))
}

function framePanel(panel: Panel, width: number, height: number): string[] {
  if (height <= 0) return []
  const focusedStyle: Colorize = (text) => style.green(style.bold(text))
  const border = panel.isFocused ? focusedStyle : style.dim
  const label = panel.isFocused ? focusedStyle : plain
  const innerWidth = width - 2
  const innerHeight = height - 2
  const shownTitle = truncateToWidth(panel.title, innerWidth - 2)
  const shownFooter = truncateToWidth(panel.footer ?? "", innerWidth - 2)
  const topRule = "─".repeat(innerWidth - 1 - displayWidth(shownTitle))
  const bottomRule = "─".repeat(innerWidth - 1 - displayWidth(shownFooter))
  const scrollOffset = scrollOffsetFor(panel.anchorLineIndex ?? 0, panel.contentLines.length, innerHeight)
  const framed = [border("╭─") + label(shownTitle) + border(`${topRule}╮`)]
  for (let lineIndex = 0; lineIndex < innerHeight; lineIndex++) {
    framed.push(border("│") + (panel.contentLines[scrollOffset + lineIndex] ?? " ".repeat(innerWidth)) + border("│"))
  }
  framed.push(border(`╰${bottomRule}`) + label(shownFooter) + border("─╯"))
  return framed.slice(0, height)
}

// Every panel gets the height of its content, and spare lines go to the flexible panels.
// A column that is too short first trims its long lists, then shrinks panels in the order
// of their rank, and at last drops whole panels: a frame of one or two lines shows nothing.
export function panelHeights(panels: Panel[], columnHeight: number): number[] {
  const heights = panels.map((panel) => panel.contentLines.length + 2)
  const flexibleIndexes = panels.flatMap((panel, panelIndex) => (panel.isFlexible ? [panelIndex] : []))
  const growingIndexes = flexibleIndexes.length > 0 ? flexibleIndexes : [panels.length - 1]
  let missingLineCount = heights.reduce((total, height) => total + height, 0) - columnHeight
  for (let turn = 0; missingLineCount < 0; turn++, missingLineCount++) {
    heights[growingIndexes[turn % growingIndexes.length]!]! += 1
  }
  while (missingLineCount > 0) {
    const longestListIndex = flexibleIndexes
      .filter((panelIndex) => heights[panelIndex]! > COMFORTABLE_LIST_HEIGHT)
      .sort((first, second) => heights[second]! - heights[first]!)[0]
    if (longestListIndex === undefined) break
    heights[longestListIndex]! -= 1
    missingLineCount -= 1
  }
  const yieldingIndexes = panels
    .map((_panel, panelIndex) => panelIndex)
    .sort((first, second) => panels[first]!.yieldRank - panels[second]!.yieldRank)
  for (const panelIndex of yieldingIndexes) {
    if (missingLineCount <= 0) break
    const givenLineCount = Math.min(missingLineCount, Math.max(0, heights[panelIndex]! - panels[panelIndex]!.smallestHeight))
    heights[panelIndex]! -= givenLineCount
    missingLineCount -= givenLineCount
    if (heights[panelIndex]! < SMALLEST_FRAME_HEIGHT) {
      missingLineCount -= heights[panelIndex]!
      heights[panelIndex] = 0
    }
  }
  for (const panelIndex of yieldingIndexes) {
    if (missingLineCount <= 0) break
    const keepsAFrame = heights[panelIndex]! - missingLineCount >= SMALLEST_FRAME_HEIGHT
    const givenLineCount = keepsAFrame ? missingLineCount : heights[panelIndex]!
    heights[panelIndex]! -= givenLineCount
    missingLineCount -= givenLineCount
  }
  // Dropping a whole panel can free more lines than were missing.
  const lastShownIndex = heights.findLastIndex((height) => height > 0)
  if (missingLineCount < 0 && lastShownIndex >= 0) heights[lastShownIndex]! -= missingLineCount
  return heights
}

function column(buildPanels: ((innerWidth: number) => Panel)[], width: number, height: number): string[] {
  const panels = buildPanels.map((buildPanel) => buildPanel(width - 2))
  const heights = panelHeights(panels, height)
  const lines = panels.flatMap((panel, panelIndex) => framePanel(panel, width, heights[panelIndex]!))
  const blankLine = " ".repeat(width)
  return Array.from({ length: height }, (_unused, lineIndex) => lines[lineIndex] ?? blankLine)
}

function hintLine(statusMessage: string, width: number): string {
  const status = truncateToWidth(statusMessage, Math.floor(width / 2))
  const availableWidth = width - 3 - displayWidth(status)
  let hints = ""
  let hintsWidth = 0
  for (const [key, action] of KEY_HINTS) {
    const separator = hintsWidth > 0 ? "   " : ""
    const hintWidth = displayWidth(`${separator}${key} ${action}`)
    if (hintsWidth + hintWidth > availableWidth) break
    hints += `${separator}${style.bold(style.cyan(key))} ${style.dim(action)}`
    hintsWidth += hintWidth
  }
  const gap = " ".repeat(Math.max(0, width - 2 - hintsWidth - displayWidth(status)))
  return ` ${hints}${gap}${status} `
}

function noSessionPanel(innerWidth: number): Panel {
  const messages = [
    "No Claude Code session runs in the pane you opened this from.",
    "Focus a pane where Claude runs and press the key again.",
  ]
  const lines = messages.flatMap((message) => wrapToWidth(message, innerWidth).map((line) => dimLine(line, innerWidth)))
  return { title: "Session", isFocused: false, isFlexible: true, yieldRank: 0, smallestHeight: 3, contentLines: lines }
}

export function renderScreen(state: OverviewState, width: number, height: number): string[] {
  if (width < 40 || height < 10) return [truncateToWidth("RexySesh needs a larger pane", width)]
  const panelsHeight = height - 1
  const { session } = state
  const hints = hintLine(state.statusMessage, width)
  if (!session) return [...column([noSessionPanel], width, panelsHeight), hints]

  const overviewPanels = [
    (innerWidth: number) => sessionPanel(state, session, innerWidth),
    (innerWidth: number) => contextPanel(state, innerWidth),
    (innerWidth: number) => gitPanel(state, innerWidth),
  ]
  const listPanels = [
    (innerWidth: number) => artifactsPanel(state, innerWidth),
    (innerWidth: number) => filesPanel(state, innerWidth),
  ]
  if (width < TWO_COLUMN_WIDTH) return [...column([...overviewPanels, ...listPanels], width, panelsHeight), hints]

  const leftWidth = Math.min(Math.floor(width / 2), 76)
  const leftLines = column(overviewPanels, leftWidth, panelsHeight)
  const rightLines = column(listPanels, width - leftWidth, panelsHeight)
  return [...leftLines.map((leftLine, lineIndex) => leftLine + rightLines[lineIndex]), hints]
}
