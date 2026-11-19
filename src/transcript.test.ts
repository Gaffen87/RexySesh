import { expect, test } from "bun:test"
import { parseGitStatus, parsePullRequest, parseStack, webUrlOfRemote } from "./git.ts"
import { TranscriptReader } from "./transcript.ts"

function summaryOf(records: object[]) {
  const reader = new TranscriptReader()
  for (const record of records) reader.addLine(JSON.stringify(record))
  return reader.summary()
}

function assistantRecord(messageId: string, usage: object, content: object[] = [], extra: object = {}) {
  return { type: "assistant", effort: "medium", message: { id: messageId, model: "claude-fable-5-2", usage, content }, ...extra }
}

test("context is the input of the last main-thread message", () => {
  const summary = summaryOf([
    assistantRecord("first", { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90, output_tokens: 5 }),
    assistantRecord("second", { input_tokens: 2, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 3000, output_tokens: 7 }),
    assistantRecord("subagent", { input_tokens: 999_999, output_tokens: 1 }, [], { isSidechain: true }),
  ])
  expect(summary.contextTokens).toBe(83_002)
  expect(summary.model).toBe("claude-fable-5-2")
  expect(summary.effort).toBe("medium")
})

test("a message written as several records counts its output once", () => {
  const usage = { input_tokens: 1, output_tokens: 40 }
  const summary = summaryOf([
    assistantRecord("same", usage, [{ type: "text", text: "hello" }]),
    assistantRecord("same", usage, [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }]),
    assistantRecord("other", { input_tokens: 1, output_tokens: 2 }),
  ])
  expect(summary.outputTokens).toBe(42)
  expect(summary.toolCounts.get("Bash")).toBe(1)
})

test("artifacts come from the results of the Artifact tool, newest first, once per address", () => {
  const publish = (toolUseId: string) =>
    assistantRecord(toolUseId, { input_tokens: 1 }, [{ type: "tool_use", id: toolUseId, name: "Artifact", input: {} }])
  const result = (toolUseId: string, toolUseResult: object) => ({
    type: "user",
    timestamp: "2026-11-19T09:00:00.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Published" }] },
    toolUseResult,
  })
  const summary = summaryOf([
    publish("a"),
    result("a", { url: "https://claude.ai/artifact/one", title: "Plan", seq: 1 }),
    publish("b"),
    result("b", { url: "https://claude.ai/artifact/two", title: "Diagram", seq: 1 }),
    publish("c"),
    result("c", { url: "https://claude.ai/artifact/one", title: "Plan, revised", seq: 2 }),
    result("unrelated", { url: "https://claude.ai/artifact/three", title: "From another tool" }),
    publish("d"),
    result("d", { quickstart: { intent: "other" } }),
  ])
  expect(summary.artifacts.map((artifact) => [artifact.url, artifact.title, artifact.version])).toEqual([
    ["https://claude.ai/artifact/one", "Plan, revised", 2],
    ["https://claude.ai/artifact/two", "Diagram", 1],
  ])
  expect(summary.promptCount).toBe(0)
})

test("pull requests, title, prompts and compactions are collected", () => {
  const prLink = { type: "pr-link", prNumber: 12, prUrl: "https://github.com/acme/app/pull/12", prRepository: "acme/app" }
  const summary = summaryOf([
    { type: "ai-title", aiTitle: "Session overview plugin" },
    { type: "last-prompt", lastPrompt: "make it so" },
    { type: "permission-mode", permissionMode: "auto" },
    { type: "user", cwd: "/work/app", message: { content: "make it so" } },
    { type: "user", isMeta: true, message: { content: "a skill's text" } },
    prLink,
    prLink,
    { type: "system", subtype: "compact_boundary" },
    { type: "system", subtype: "turn_duration", durationMs: 90_000 },
  ])
  expect(summary.title).toBe("Session overview plugin")
  expect(summary.lastPrompt).toBe("make it so")
  expect(summary.permissionMode).toBe("auto")
  expect(summary.promptCount).toBe(1)
  expect(summary.workingDirectory).toBe("/work/app")
  expect(summary.pullRequestLinks).toEqual([{ url: prLink.prUrl, number: 12, repository: "acme/app" }])
  expect(summary.compactionCount).toBe(1)
  expect(summary.workedMilliseconds).toBe(90_000)
})

test("lines that are not records are ignored", () => {
  const reader = new TranscriptReader()
  for (const line of ["", "not json", "42", '{"type":"api-request","params":{}}']) reader.addLine(line)
  expect(reader.summary().contextTokens).toBe(0)
})

test("git status gives the branch, its distance from upstream, and the changed files", () => {
  const statusOutput = [
    "# branch.oid 989e6da",
    "# branch.head feature/overview",
    "# branch.upstream origin/feature/overview",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 abc def src/main.ts",
    "? notes.txt",
    "",
  ].join("\n")
  expect(parseGitStatus(statusOutput)).toEqual({
    branch: "feature/overview",
    upstream: "origin/feature/overview",
    aheadCount: 2,
    behindCount: 1,
    changedFileCount: 2,
  })
})

test("a remote's address becomes the address of its web page", () => {
  const webUrl = "https://github.com/acme/app"
  for (const remoteAddress of [
    "git@github.com:acme/app.git\n",
    "ssh://git@github.com/acme/app.git",
    "ssh://git@github.com:22/acme/app",
    "https://github.com/acme/app.git",
    "https://token@github.com/acme/app/",
  ]) {
    expect(webUrlOfRemote(remoteAddress)).toBe(webUrl)
  }
  expect(webUrlOfRemote("/srv/git/app.git")).toBeUndefined()
})

test("a stack gives its branches with a pull request, from the trunk upward", () => {
  const branch = (name: string, number: number, extra: object = {}) => ({
    name,
    isCurrent: false,
    isMerged: false,
    needsRebase: false,
    pr: { number, url: `https://github.com/acme/app/pull/${number}`, state: "OPEN" },
    ...extra,
  })
  const stackJson = JSON.stringify({
    trunk: "main",
    currentBranch: "layer-2",
    branches: [
      branch("layer-1", 11, { isMerged: true, needsRebase: true }),
      branch("layer-2", 12, { isCurrent: true }),
      { name: "layer-3", isCurrent: false },
    ],
  })
  expect(parseStack(stackJson)).toEqual([
    { branch: "layer-1", isCurrentBranch: false, needsRebase: true, number: 11, url: "https://github.com/acme/app/pull/11", state: "MERGED" },
    { branch: "layer-2", isCurrentBranch: true, needsRebase: false, number: 12, url: "https://github.com/acme/app/pull/12", state: "OPEN" },
  ])
  expect(parseStack("not part of a stack")).toEqual([])
})

test("a pull request's checks are counted as passed, failed or pending", () => {
  const pullRequest = parsePullRequest(
    JSON.stringify({
      number: 7,
      title: "Add the overview",
      url: "https://github.com/acme/app/pull/7",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "",
      statusCheckRollup: [
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
        { status: "IN_PROGRESS", conclusion: "" },
        { state: "SUCCESS" },
      ],
    }),
  )
  expect(pullRequest).toMatchObject({ number: 7, passedCheckCount: 2, failedCheckCount: 1, pendingCheckCount: 1 })
  expect(pullRequest?.reviewDecision).toBeUndefined()
  expect(parsePullRequest("no pull requests found")).toBeNull()
})
