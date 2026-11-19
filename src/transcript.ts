// Reduces the lines of a Claude Code transcript (a .jsonl file) to the facts the overview shows.
// Lines are added one at a time, so a growing transcript is only ever read once.

export type Artifact = { url: string; title: string; version?: number; updatedAt?: string }
export type PullRequestLink = { url: string; number: number; repository?: string }
export type TouchedFile = { path: string; editCount: number }

export type TranscriptSummary = {
  title?: string
  lastPrompt?: string
  permissionMode?: string
  model?: string
  effort?: string
  workingDirectory?: string
  contextTokens: number
  outputTokens: number
  compactionCount: number
  promptCount: number
  subagentCount: number
  workedMilliseconds: number
  lastActivityAt?: string
  toolCounts: Map<string, number>
  artifacts: Artifact[]
  pullRequestLinks: PullRequestLink[]
  touchedFiles: TouchedFile[]
}

const ARTIFACT_URL_PATTERN = /^https:\/\/claude\.ai\/(code\/)?artifact\//
const FILE_EDITING_TOOLS = new Set(["Edit", "Write", "NotebookEdit"])
const SKIPPED_LINE_PREFIX = '{"type":"api-request'

type JsonObject = Record<string, any>

export class TranscriptReader {
  private title: string | undefined
  private agentName: string | undefined
  private lastPrompt: string | undefined
  private permissionMode: string | undefined
  private model: string | undefined
  private effort: string | undefined
  private workingDirectory: string | undefined
  private lastActivityAt: string | undefined
  private contextTokens = 0
  private compactionCount = 0
  private promptCount = 0
  private subagentCount = 0
  private workedMilliseconds = 0
  private readonly outputTokensByMessageId = new Map<string, number>()
  private readonly toolCounts = new Map<string, number>()
  private readonly artifactToolUseIds = new Set<string>()
  private readonly artifactsByUrl = new Map<string, Artifact>()
  private readonly pullRequestLinksByUrl = new Map<string, PullRequestLink>()
  private readonly editCountsByPath = new Map<string, number>()

  addLine(line: string) {
    if (!line || line.startsWith(SKIPPED_LINE_PREFIX)) return
    let record: JsonObject
    try {
      record = JSON.parse(line)
    } catch {
      return
    }
    if (typeof record !== "object" || record === null) return
    if (typeof record.timestamp === "string") this.lastActivityAt = record.timestamp
    if (typeof record.cwd === "string" && !record.isSidechain) this.workingDirectory = record.cwd

    switch (record.type) {
      case "ai-title":
        this.title = record.aiTitle ?? this.title
        break
      case "agent-name":
        this.agentName = record.agentName ?? this.agentName
        break
      case "last-prompt":
        this.lastPrompt = record.lastPrompt ?? this.lastPrompt
        break
      case "permission-mode":
        this.permissionMode = record.permissionMode ?? this.permissionMode
        break
      case "pr-link":
        if (typeof record.prUrl === "string") {
          this.pullRequestLinksByUrl.set(record.prUrl, {
            url: record.prUrl,
            number: record.prNumber,
            repository: record.prRepository,
          })
        }
        break
      case "frame-link":
        this.addArtifact(record.frameUrl, record.title, undefined, record.timestamp)
        break
      case "system":
        if (record.subtype === "compact_boundary") this.compactionCount += 1
        if (record.subtype === "turn_duration" && !record.isSidechain) {
          this.workedMilliseconds += Number(record.durationMs) || 0
        }
        break
      case "assistant":
        if (!record.isSidechain) this.addAssistantRecord(record)
        break
      case "user":
        if (!record.isSidechain) this.addUserRecord(record)
        break
    }
  }

  private addAssistantRecord(record: JsonObject) {
    const message: JsonObject = record.message ?? {}
    if (typeof message.model === "string" && !message.model.startsWith("<")) {
      this.model = message.model
      this.effort = record.effort ?? this.effort
      const usage: JsonObject | undefined = message.usage
      if (usage) {
        this.contextTokens =
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0)
        // One message is written as several records, each repeating the message's usage.
        if (typeof message.id === "string") {
          this.outputTokensByMessageId.set(message.id, usage.output_tokens ?? 0)
        }
      }
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue
      this.toolCounts.set(block.name, (this.toolCounts.get(block.name) ?? 0) + 1)
      if (block.name === "Agent") this.subagentCount += 1
      if (block.name === "Artifact") this.artifactToolUseIds.add(block.id)
      const editedPath = block.input?.file_path ?? block.input?.notebook_path
      if (FILE_EDITING_TOOLS.has(block.name) && typeof editedPath === "string") {
        const editCount = this.editCountsByPath.get(editedPath) ?? 0
        this.editCountsByPath.delete(editedPath)
        this.editCountsByPath.set(editedPath, editCount + 1)
      }
    }
  }

  private addUserRecord(record: JsonObject) {
    const content = record.message?.content
    const toolResult = Array.isArray(content)
      ? content.find((block: JsonObject) => block?.type === "tool_result")
      : undefined
    if (!toolResult) {
      if (!record.isMeta) this.promptCount += 1
      return
    }
    const result = record.toolUseResult
    if (this.artifactToolUseIds.has(toolResult.tool_use_id) && result && typeof result === "object") {
      this.addArtifact(result.url, result.title, result.seq, record.timestamp)
    }
  }

  private addArtifact(url: unknown, title: unknown, version: unknown, updatedAt: unknown) {
    if (typeof url !== "string" || !ARTIFACT_URL_PATTERN.test(url)) return
    const known = this.artifactsByUrl.get(url)
    this.artifactsByUrl.delete(url)
    this.artifactsByUrl.set(url, {
      url,
      title: typeof title === "string" && title ? title : (known?.title ?? "Untitled artifact"),
      version: typeof version === "number" ? version : known?.version,
      updatedAt: typeof updatedAt === "string" ? updatedAt : known?.updatedAt,
    })
  }

  // Artifacts and files come newest first: each map keeps its latest change last.
  summary(): TranscriptSummary {
    let outputTokens = 0
    for (const messageOutputTokens of this.outputTokensByMessageId.values()) outputTokens += messageOutputTokens
    return {
      title: this.title ?? this.agentName,
      lastPrompt: this.lastPrompt,
      permissionMode: this.permissionMode,
      model: this.model,
      effort: this.effort,
      workingDirectory: this.workingDirectory,
      contextTokens: this.contextTokens,
      outputTokens,
      compactionCount: this.compactionCount,
      promptCount: this.promptCount,
      subagentCount: this.subagentCount,
      workedMilliseconds: this.workedMilliseconds,
      lastActivityAt: this.lastActivityAt,
      toolCounts: new Map(this.toolCounts),
      artifacts: [...this.artifactsByUrl.values()].reverse(),
      pullRequestLinks: [...this.pullRequestLinksByUrl.values()],
      touchedFiles: [...this.editCountsByPath].map(([path, editCount]) => ({ path, editCount })).reverse(),
    }
  }
}
