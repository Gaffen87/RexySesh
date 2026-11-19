const COMMAND_TIMEOUT_MILLISECONDS = 15_000

// Null means the command could not run, or failed. lsof fails when any one process it was
// asked about has gone, yet still prints the others, so a caller may accept a failure.
export async function outputOf(
  command: string[],
  workingDirectory: string,
  acceptsFailure = false,
): Promise<string | null> {
  try {
    const child = Bun.spawn(command, {
      cwd: workingDirectory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: COMMAND_TIMEOUT_MILLISECONDS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    })
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return exitCode === 0 || acceptsFailure ? output : null
  } catch {
    return null
  }
}
