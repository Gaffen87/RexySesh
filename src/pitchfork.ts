// Reads the routes of a pitchfork reverse proxy: it serves each daemon that has a slug at
// <slug>.localhost on the proxy's port, so that address is the one to open, not the daemon's own.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type ProxyRoute = { slug: string; directory: string; daemonPort?: number }

type TomlTable = Record<string, any>

function parseToml(toml: string): TomlTable {
  try {
    return Bun.TOML.parse(toml) as TomlTable
  } catch {
    return {}
  }
}

// A slug names a daemon and its directory, either directly or through a namespace. The state
// tells which port that daemon listens on.
export function parseProxyRoutes(configToml: string, stateToml: string): ProxyRoute[] {
  const config = parseToml(configToml)
  const runningDaemons: TomlTable[] = Object.values(parseToml(stateToml).daemons ?? {})
  const routes: ProxyRoute[] = []
  for (const [slug, target] of Object.entries<TomlTable>(config.slugs ?? {})) {
    const directory = target?.dir ?? config.namespaces?.[target?.namespace]?.dir
    if (typeof directory !== "string") continue
    const daemonName = target.daemon ?? slug
    const daemon = runningDaemons.find(
      (runningDaemon) => runningDaemon?.dir === directory && String(runningDaemon.id ?? "").split("/").pop() === daemonName,
    )
    const daemonPort = daemon?.active_port
    routes.push({ slug, directory, daemonPort: typeof daemonPort === "number" ? daemonPort : undefined })
  }
  return routes
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

// A supervisor may keep its config and state elsewhere, which only its environment tells.
export function readProxyRoutes(supervisorEnvironment: string): ProxyRoute[] {
  const directoryFrom = (variableName: string, defaultDirectory: string) =>
    supervisorEnvironment.match(new RegExp(`(?:^|\\s)${variableName}=(\\S+)`))?.[1] ?? defaultDirectory
  const configDirectory = directoryFrom("PITCHFORK_CONFIG_DIR", join(homedir(), ".config", "pitchfork"))
  const stateDirectory = directoryFrom("PITCHFORK_STATE_DIR", join(homedir(), ".local", "state", "pitchfork"))
  return parseProxyRoutes(readOrEmpty(join(configDirectory, "config.toml")), readOrEmpty(join(stateDirectory, "state.toml")))
}
