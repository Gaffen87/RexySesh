import { expect, test } from "bun:test"
import { PaneStatus } from "./rexStatus.ts"

const PANE = "block:pane"
const WORKING_SINCE = "2026-11-23T17:23:10+01:00"

function statusEvent(blockId: string, name: string, payload: object): string {
  return JSON.stringify({
    type: "session_event",
    payload: {
      session_id: "session:one",
      event: { type: "block_event", payload: { block_id: blockId, creator_name: "com.superlogical.terminal", name, payload } },
    },
  })
}

function changed(recordId: string, record: object, blockId = PANE): string {
  return statusEvent(blockId, "program_status_changed", { id: recordId, record, reason: "report" })
}

function paneWithWorkingClaude(): PaneStatus {
  const paneStatus = new PaneStatus(PANE)
  paneStatus.loadRecords(
    JSON.stringify({
      records: [
        {
          state: "working",
          app: "claude-code",
          effective_app: "claude-code",
          msg: "Reading files",
          updated_at: WORKING_SINCE,
          owner: { pid: 89850, name: "2.1.330" },
        },
      ],
    }),
  )
  return paneStatus
}

test("the snapshot gives Claude's state, message and process", () => {
  expect(paneWithWorkingClaude().current()).toEqual({
    state: "working",
    blockedKind: undefined,
    message: "Reading files",
    stateSince: undefined,
    ownerProcessId: 89850,
    taskTitles: [],
  })
})

test("a pane without a report from Claude has no status", () => {
  const paneStatus = new PaneStatus(PANE)
  expect(paneStatus.current()).toBeNull()
  paneStatus.loadRecords(JSON.stringify({ records: [{ state: "working", effective_app: "cargo", updated_at: WORKING_SINCE }] }))
  expect(paneStatus.current()).toBeNull()
})

test("a report replaces the record, and only a new state renews its start", () => {
  const paneStatus = paneWithWorkingClaude()
  const laterReport = { state: "working", effective_app: "claude-code", msg: "Running tests", updated_at: "2026-11-23T17:25:00+01:00" }
  expect(paneStatus.applyEventLine(changed("", laterReport))).toBe(true)
  expect(paneStatus.current()?.message).toBe("Running tests")
  expect(paneStatus.current()?.stateSince).toBeUndefined()

  const blockedSince = "2026-11-23T17:26:00+01:00"
  paneStatus.applyEventLine(changed("", { state: "blocked", kind: "permission", effective_app: "claude-code", updated_at: blockedSince }))
  expect(paneStatus.current()).toMatchObject({ state: "blocked", blockedKind: "permission", stateSince: Date.parse(blockedSince) })
  expect(paneStatus.current()?.message).toBeUndefined()
})

test("the records below Claude's own are its tasks, while they are active", () => {
  const paneStatus = paneWithWorkingClaude()
  paneStatus.applyEventLine(changed("agent-1", { state: "working", effective_app: "claude-code", title: "Explore the code", updated_at: WORKING_SINCE }))
  paneStatus.applyEventLine(changed("agent-2", { state: "done", effective_app: "claude-code", title: "Run the tests", updated_at: WORKING_SINCE }))
  expect(paneStatus.current()?.taskTitles).toEqual(["Explore the code"])
})

test("a removal drops the records, and the status with them", () => {
  const paneStatus = paneWithWorkingClaude()
  expect(paneStatus.applyEventLine(statusEvent(PANE, "program_status_removed", { ids: [""], reason: "child_exited" }))).toBe(true)
  expect(paneStatus.current()).toBeNull()
})

test("events of other panes, other events and broken lines change nothing", () => {
  const paneStatus = paneWithWorkingClaude()
  const idleReport = { state: "idle", effective_app: "claude-code", updated_at: WORKING_SINCE }
  expect(paneStatus.applyEventLine(changed("", idleReport, "block:other"))).toBe(false)
  expect(paneStatus.applyEventLine(statusEvent(PANE, "bell", {}))).toBe(false)
  expect(paneStatus.applyEventLine('{"type":"session_event","payload":{"event":{"type":"session_view_changed"}}}')).toBe(false)
  expect(paneStatus.applyEventLine("{not json")).toBe(false)
  expect(paneStatus.current()?.state).toBe("working")
})

test("a state Rex adds later counts as idle", () => {
  const paneStatus = paneWithWorkingClaude()
  paneStatus.applyEventLine(changed("", { state: "dreaming", effective_app: "claude-code", updated_at: WORKING_SINCE }))
  expect(paneStatus.current()?.state).toBe("idle")
})
