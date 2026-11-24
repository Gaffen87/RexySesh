// Follows the status that Claude Code reports to Rex (OSC 7501) for one pane: a snapshot
// first, then Rex's events, so a change shows the moment Rex hears of it.
import { outputOf } from "./command.ts"

export type ProgramState = "idle" | "working" | "done" | "blocked" | "error"
export type BlockedKind = "permission" | "question" | "auth"

export type ProgramStatus = {
  state: ProgramState
  blockedKind?: BlockedKind
  message?: string
  // When the state last changed, as far as Rex's reports tell.
  stateSince?: number
  ownerProcessId?: number
  taskTitles: string[]
}

type StatusRecord = {
  state?: string
  kind?: string
  effective_app?: string
  title?: string
  msg?: string
  updated_at?: string
  owner?: { pid?: number } | null
}

const CLAUDE_APP = "claude-code"
const ROOT_RECORD_ID = ""
const KNOWN_STATES: ProgramState[] = ["idle", "working", "done", "blocked", "error"]
const BLOCKED_KINDS: BlockedKind[] = ["permission", "question", "auth"]
const ACTIVE_STATES: ProgramState[] = ["working", "blocked"]

// Rex asks that a state it adds later is treated as idle.
function stateOf(record: StatusRecord): ProgramState {
  return KNOWN_STATES.find((knownState) => knownState === record.state) ?? "idle"
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null
}

export class PaneStatus {
  private readonly recordsById = new Map<string, StatusRecord>()
  private shownStateKey = ""
  private stateSince: number | undefined

  constructor(private readonly blockId: string) {}

  // The result of the terminal's program_status method. It tells when the last report came,
  // not when the state began, so the state's start stays unknown until the state changes.
  loadRecords(programStatusJson: string) {
    let records: unknown
    try {
      records = JSON.parse(programStatusJson)?.records
    } catch {
      return
    }
    if (!Array.isArray(records)) return
    this.recordsById.clear()
    for (const record of records) {
      if (isObject(record)) this.recordsById.set(typeof record.id === "string" ? record.id : ROOT_RECORD_ID, record)
    }
    this.noteState(false)
  }

  // One line of "rex events --json". Returns whether the pane's status changed.
  applyEventLine(line: string): boolean {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return false
    }
    const blockEvent = isObject(event) && event.type === "session_event" ? event.payload?.event : event
    if (!isObject(blockEvent) || blockEvent.type !== "block_event") return false
    const { block_id: blockId, name, payload } = blockEvent.payload ?? {}
    if (blockId !== this.blockId || !isObject(payload)) return false
    if (name === "program_status_changed" && typeof payload.id === "string" && isObject(payload.record)) {
      this.recordsById.set(payload.id, payload.record)
    } else if (name === "program_status_removed" && Array.isArray(payload.ids)) {
      for (const removedId of payload.ids) this.recordsById.delete(removedId)
    } else {
      return false
    }
    this.noteState()
    return true
  }

  current(): ProgramStatus | null {
    const claudeEntry = this.claudeEntry()
    if (!claudeEntry) return null
    const [claudeId, record] = claudeEntry
    const state = stateOf(record)
    const taskPrefix = claudeId === ROOT_RECORD_ID ? "" : `${claudeId}/`
    const taskTitles: string[] = []
    for (const [recordId, taskRecord] of this.recordsById) {
      const isTask = recordId !== claudeId && recordId.startsWith(taskPrefix) && taskRecord.effective_app === CLAUDE_APP
      const taskTitle = taskRecord.title ?? taskRecord.msg
      if (isTask && taskTitle && ACTIVE_STATES.includes(stateOf(taskRecord))) taskTitles.push(taskTitle)
    }
    return {
      state,
      blockedKind: state === "blocked" ? BLOCKED_KINDS.find((kind) => kind === record.kind) : undefined,
      message: record.msg || undefined,
      stateSince: this.stateSince,
      ownerProcessId: record.owner?.pid,
      taskTitles,
    }
  }

  // Records are kept sorted by id, so a parent comes before its children.
  private claudeEntry(): [string, StatusRecord] | undefined {
    return [...this.recordsById]
      .sort(([firstId], [secondId]) => (firstId < secondId ? -1 : firstId > secondId ? 1 : 0))
      .find(([, record]) => record.effective_app === CLAUDE_APP)
  }

  // Every report renews updated_at, even one that only changes the message, so the time
  // of the report counts only when the state itself is new.
  private noteState(isNewReport = true) {
    const record = this.claudeEntry()?.[1]
    const stateKey = record ? `${stateOf(record)} ${record.kind ?? ""}` : ""
    if (stateKey === this.shownStateKey) return
    this.shownStateKey = stateKey
    this.stateSince = (isNewReport && record?.updated_at && Date.parse(record.updated_at)) || undefined
  }
}

export type PaneStatusFollower = { paneStatus: PaneStatus; stop: () => void }

export function followPaneStatus(
  rexBinary: string,
  sessionId: string,
  blockId: string,
  onChange: () => void,
): PaneStatusFollower {
  const paneStatus = new PaneStatus(blockId)
  let eventStream: ReturnType<typeof Bun.spawn> | undefined
  let isStopped = false

  async function readEvents() {
    try {
      eventStream = Bun.spawn([rexBinary, "events", "-s", sessionId, "--json"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      })
    } catch {
      return
    }
    const decoder = new TextDecoder()
    let unfinishedLine = ""
    for await (const chunk of eventStream.stdout as ReadableStream<Uint8Array>) {
      const lines = (unfinishedLine + decoder.decode(chunk, { stream: true })).split("\n")
      unfinishedLine = lines.pop() ?? ""
      let hasChanged = false
      for (const line of lines) hasChanged = paneStatus.applyEventLine(line) || hasChanged
      if (hasChanged) onChange()
    }
    // Without its events the snapshot would go stale, so the status is given up.
    if (!isStopped) {
      paneStatus.loadRecords('{"records":[]}')
      onChange()
    }
  }

  async function readSnapshot() {
    const snapshot = await outputOf([rexBinary, "block", "call", "-s", sessionId, "-b", blockId, "program_status"], ".")
    if (snapshot === null || isStopped) return
    paneStatus.loadRecords(snapshot)
    onChange()
  }

  void readEvents()
  void readSnapshot()
  return {
    paneStatus,
    stop() {
      isStopped = true
      eventStream?.kill()
    },
  }
}
