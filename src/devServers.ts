// Finds the dev servers of a directory: the processes that run in it, listen on a TCP port,
// and answer HTTP there.
import { outputOf } from "./command.ts"
import { readProxyRoutes } from "./pitchfork.ts"

export type DevServer = { url: string; port: number; processName: string; directory: string }
export type ListeningSocket = { processId: number; host: string; port: number }

const LSOF_BINARIES = ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"]
const PS_BINARIES = ["ps", "/bin/ps"]
const PROBE_TIMEOUT_MILLISECONDS = 1_500
const PROXY_SUPERVISOR_NAME = "pitchfork"
const WILDCARD_HOSTS = new Set(["*", "0.0.0.0", "[::]"])
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"])
// A proxy with nothing behind it answers with one of these.
const GATEWAY_FAILURE_STATUSES = new Set([502, 503, 504])
const INTERPRETERS = new Set(["node", "bun", "deno", "ruby", "python", "python3", "php", "tsx", "npx", "bunx", "java"])

const serverUrlsByCandidate = new Map<string, string>()

async function firstOutputOf(binaries: string[], commandArguments: string[]): Promise<string | null> {
  for (const binary of binaries) {
    const output = await outputOf([binary, ...commandArguments], "/", true)
    if (output !== null) return output
  }
  return null
}

// Reads "lsof -Fpn": a line "p<process id>", then a line "n<host>:<port>" for each socket.
export function parseListeningSockets(lsofOutput: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = []
  let processId = 0
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) processId = Number(line.slice(1))
    if (!line.startsWith("n")) continue
    const portSeparatorIndex = line.lastIndexOf(":")
    const port = Number(line.slice(portSeparatorIndex + 1))
    if (processId > 0 && port > 0) sockets.push({ processId, host: line.slice(1, portSeparatorIndex), port })
  }
  return sockets
}

// Reads "lsof -d cwd -Fpn": a line "p<process id>", then a line "n<working directory>".
export function parseWorkingDirectories(lsofOutput: string): Map<number, string> {
  const directoriesByProcessId = new Map<number, string>()
  let processId = 0
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) processId = Number(line.slice(1))
    else if (line.startsWith("n") && processId > 0) directoriesByProcessId.set(processId, line.slice(1))
  }
  return directoriesByProcessId
}

// The name of the program in a command line: of "node node_modules/.bin/vite --host" it is vite.
export function processNameOf(commandLine: string): string {
  const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1)
  const [program = "", firstArgument = ""] = commandLine.trim().split(/\s+/)
  const programName = baseName(program)
  const runsAScript = INTERPRETERS.has(programName) && firstArgument && !firstArgument.startsWith("-")
  return runsAScript ? baseName(firstArgument) : programName
}

function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory.replace(/\/$/, "")}/`)
}

async function answersHttp(address: string): Promise<boolean> {
  try {
    const response = await fetch(address, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS),
      tls: { rejectUnauthorized: false },
    })
    return !GATEWAY_FAILURE_STATUSES.has(response.status)
  } catch {
    return false
  }
}

// A candidate is a socket that may be a dev server, reached under a host name when a proxy
// routes to it by name.
type Candidate = {
  socket: ListeningSocket
  hostName?: string
  // The port of the server behind the proxy, which is then not listed by itself.
  daemonPort?: number
  processName: string
  directory: string
}

// A server that is still starting gives no address yet, so only found addresses are kept.
async function serverUrlOf({ socket, hostName }: Candidate): Promise<string | undefined> {
  const candidateKey = `${socket.processId}:${socket.port}:${hostName ?? ""}`
  const knownUrl = serverUrlsByCandidate.get(candidateKey)
  if (knownUrl) return knownUrl
  const isLocal = WILDCARD_HOSTS.has(socket.host) || LOOPBACK_HOSTS.has(socket.host)
  const linkedHost = hostName ?? (isLocal ? "localhost" : socket.host)
  const probedHost = hostName ?? (WILDCARD_HOSTS.has(socket.host) ? "127.0.0.1" : socket.host)
  for (const scheme of ["http", "https"]) {
    if (await answersHttp(`${scheme}://${probedHost}:${socket.port}/`)) {
      const serverUrl = `${scheme}://${linkedHost}:${socket.port}`
      serverUrlsByCandidate.set(candidateKey, serverUrl)
      return serverUrl
    }
  }
  return undefined
}

async function processNamesOf(processIds: number[]): Promise<Map<number, string>> {
  const psOutput = (await firstOutputOf(PS_BINARIES, ["-o", "pid=,args=", "-p", processIds.join(",")])) ?? ""
  const namesByProcessId = new Map<number, string>()
  for (const line of psOutput.split("\n")) {
    const [, processId, commandLine] = line.match(/^\s*(\d+)\s+(.+)$/) ?? []
    if (processId && commandLine) namesByProcessId.set(Number(processId), processNameOf(commandLine))
  }
  return namesByProcessId
}

// The sockets of a pitchfork supervisor are its proxy. Each of its routes into the directory
// becomes a candidate under the route's host name.
async function proxiedCandidates(
  supervisorSockets: ListeningSocket[],
  directory: string,
  nameOfPort: (port: number) => string,
): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  const seenAddresses = new Set<string>()
  for (const socket of supervisorSockets) {
    const environment = await firstOutputOf(PS_BINARIES, ["eww", "-o", "command=", "-p", String(socket.processId)])
    for (const route of readProxyRoutes(environment ?? "")) {
      const address = `${route.slug}:${socket.port}`
      if (!isInside(route.directory, directory) || seenAddresses.has(address)) continue
      seenAddresses.add(address)
      candidates.push({
        socket,
        hostName: `${route.slug}.localhost`,
        daemonPort: route.daemonPort,
        processName: route.daemonPort ? nameOfPort(route.daemonPort) : "",
        directory: route.directory,
      })
    }
  }
  return candidates
}

// The servers come in the order of their ports, one per port. A server behind a proxy is
// listed by the proxy's address only.
export async function readDevServers(directory: string): Promise<DevServer[]> {
  const socketsOutput = await firstOutputOf(LSOF_BINARIES, ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
  const sockets = parseListeningSockets(socketsOutput ?? "")
  if (sockets.length === 0) return []
  const listeningProcessIds = [...new Set(sockets.map((socket) => socket.processId))]
  const [directoriesOutput, namesByProcessId] = await Promise.all([
    firstOutputOf(LSOF_BINARIES, ["-a", "-p", listeningProcessIds.join(","), "-d", "cwd", "-Fpn"]),
    processNamesOf(listeningProcessIds),
  ])
  const directoriesByProcessId = parseWorkingDirectories(directoriesOutput ?? "")
  const nameOfSocket = (socket: ListeningSocket) => namesByProcessId.get(socket.processId) ?? ""
  const nameOfPort = (port: number) => {
    const socketOfPort = sockets.find((socket) => socket.port === port)
    return socketOfPort ? nameOfSocket(socketOfPort) : ""
  }
  const supervisorSockets = sockets.filter((socket) => nameOfSocket(socket) === PROXY_SUPERVISOR_NAME)
  const proxied = await proxiedCandidates(supervisorSockets, directory, nameOfPort)
  const proxiedDaemonPorts = new Set(proxied.map((candidate) => candidate.daemonPort))

  const directByPort = new Map<number, Candidate>()
  for (const socket of sockets) {
    const processDirectory = directoriesByProcessId.get(socket.processId)
    const isListed = directByPort.has(socket.port) || supervisorSockets.includes(socket)
    if (!processDirectory || !isInside(processDirectory, directory) || isListed) continue
    directByPort.set(socket.port, { socket, processName: nameOfSocket(socket), directory: processDirectory })
  }
  const candidates = [...directByPort.values()]
    .filter((candidate) => !proxiedDaemonPorts.has(candidate.socket.port))
    .concat(proxied)
    .sort((first, second) => first.socket.port - second.socket.port)
  const serverUrls = await Promise.all(candidates.map(serverUrlOf))
  return candidates.flatMap((candidate, candidateIndex) => {
    const serverUrl = serverUrls[candidateIndex]
    if (!serverUrl) return []
    return [{ url: serverUrl, port: candidate.socket.port, processName: candidate.processName, directory: candidate.directory }]
  })
}
