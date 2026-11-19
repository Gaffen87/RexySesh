// Finds the Claude Code session of a pane, and follows its transcript as it grows.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { TranscriptReader } from "./transcript.ts"

export type SessionRecord = {
  pid: number
  sessionId: string
  cwd: string
  startedAt?: number
  version?: string
  name?: string
  status?: string
  statusUpdatedAt?: number
}

export type SessionQuery = { processIds: number[]; workingDirectory?: string; sessionId?: string }

const claudeDirectory = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
const sessionsDirectory = join(claudeDirectory, "sessions")
const projectsDirectory = join(claudeDirectory, "projects")

function readSessionRecord(fileName: string): SessionRecord | null {
  try {
    const record = JSON.parse(readFileSync(join(sessionsDirectory, fileName), "utf8"))
    return typeof record?.sessionId === "string" && typeof record.pid === "number" ? record : null
  } catch {
    return null
  }
}

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

function allSessionRecords(): SessionRecord[] {
  let fileNames: string[]
  try {
    fileNames = readdirSync(sessionsDirectory)
  } catch {
    return []
  }
  return fileNames
    .filter((fileName) => /^\d+\.json$/.test(fileName))
    .map(readSessionRecord)
    .filter((record) => record !== null)
}

// Claude Code names each running session's file after its process ID. A pane's process tree
// therefore names its session exactly; the working directory is only a fallback.
export function findSessionRecord(query: SessionQuery): SessionRecord | null {
  if (query.sessionId) {
    return allSessionRecords().find((record) => record.sessionId === query.sessionId) ?? null
  }
  for (const processId of query.processIds) {
    const record = readSessionRecord(`${processId}.json`)
    if (record) return record
  }
  if (!query.workingDirectory) return null
  const runningHere = allSessionRecords()
    .filter((record) => record.cwd === query.workingDirectory && isRunning(record.pid))
    .sort((first, second) => (second.statusUpdatedAt ?? 0) - (first.statusUpdatedAt ?? 0))
  return runningHere[0] ?? null
}

export function findTranscriptPath(sessionId: string): string | null {
  let projectNames: string[]
  try {
    projectNames = readdirSync(projectsDirectory)
  } catch {
    return null
  }
  for (const projectName of projectNames) {
    const transcriptPath = join(projectsDirectory, projectName, `${sessionId}.jsonl`)
    if (existsSync(transcriptPath)) return transcriptPath
  }
  return null
}

export class TranscriptFollower {
  readonly reader = new TranscriptReader()
  private readOffset = 0
  private unfinishedLine = Buffer.alloc(0)

  constructor(readonly transcriptPath: string) {}

  // Returns whether anything new was read.
  readNewLines(): boolean {
    let fileSize: number
    try {
      fileSize = statSync(this.transcriptPath).size
    } catch {
      return false
    }
    if (fileSize <= this.readOffset) return false
    const appended = Buffer.alloc(fileSize - this.readOffset)
    const fileDescriptor = openSync(this.transcriptPath, "r")
    let bytesRead: number
    try {
      bytesRead = readSync(fileDescriptor, appended, 0, appended.length, this.readOffset)
    } finally {
      closeSync(fileDescriptor)
    }
    this.readOffset += bytesRead
    const unread = Buffer.concat([this.unfinishedLine, appended.subarray(0, bytesRead)])
    const lastLineBreak = unread.lastIndexOf(0x0a)
    this.unfinishedLine = unread.subarray(lastLineBreak + 1)
    if (lastLineBreak < 0) return false
    for (const line of unread.subarray(0, lastLineBreak).toString("utf8").split("\n")) {
      this.reader.addLine(line)
    }
    return true
  }
}
