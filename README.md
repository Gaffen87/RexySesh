# RexySesh

See an overview of a [Claude Code](https://claude.com/claude-code) session in a [Rex](https://www.superlogical.com/rex) pane with one key. A sibling of [RexyGit](https://github.com/Gaffen87/RexyGit) and [RexyTask](https://github.com/Gaffen87/RexyTask).

Focus the pane where Claude runs and press <kbd>Cmd</kbd>+<kbd>I</kbd> to open the overview in a floating pane. Press it again to close it.

The overview only reads. It updates every second while it is open, and at once when Claude's status changes.

To open one of the session's links without the overview, run **Open a Claude session link…** from the command palette. It lists the repository, the pull requests, the dev servers and the artifacts of the focused pane's session, and opens the one you choose in your browser.

## What it shows

- **Session**: the session's title, whether Claude is working, waiting for you, or needs your permission, an answer or a sign-in, what Claude is doing right now, the model and effort, the permission mode, when the session started and how long Claude has worked, the number of prompts and tool calls, the tools used most, the directory, and your last prompt.
- **Context**: how full the context window is, how many tokens are left, how many tokens Claude has written, and how often the session was compacted.
- **Git**: the branch, how far it is ahead of or behind its upstream, the number of changed files, a link to the repository, and the branch's pull request with its state, checks and review. When the branch is part of a stack made with [gh stack](https://github.com/github/gh-stack), every pull request of the stack is listed from the trunk upward, with its place in the stack. `▶` and a bold title mark the pull request of the branch the session is on. Pull requests that Claude opened earlier in the session are listed too.
- **Dev servers**: a link to every dev server that runs in the session's directory, with the name of its program.
- **Artifacts**: every artifact the session published, with its title, version and link, newest first.

## Install

You need [Bun](https://bun.sh) to build the overview. Pull requests need the [GitHub CLI](https://cli.github.com), signed in.

```sh
./install.sh
```

The installer builds `bin/rexysesh`, copies two Lua files into Rex's config directory (`~/.config/rex` by default), adds `require("rexysesh")` to `init.lua`, and reloads Rex. Run it again after you pull an update, or after you move this folder.

To remove everything: `./uninstall.sh`.

## Keys

| Key | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>k</kbd> <kbd>j</kbd> | Select the repository, a pull request, a dev server or an artifact. The selection wraps around at either end |
| <kbd>g</kbd> <kbd>G</kbd> | Select the first or last link |
| <kbd>Enter</kbd> or <kbd>o</kbd> | Open the selected link in your browser |
| <kbd>y</kbd> | Copy the selected link |
| <kbd>i</kbd> | Copy the session's ID, for `claude --resume` |
| <kbd>r</kbd> | Ask git and GitHub again now |
| <kbd>q</kbd> or <kbd>Esc</kbd> | Quit |

Links are also terminal hyperlinks, so you can click them.

## Settings

Edit `~/.config/rex/rexysesh.lua`, then run `rex config reload`.

| Setting | Default | Values |
| --- | --- | --- |
| `key` | `"cmd+i"` | Any Rex key, or `false` for no key |
| `links_key` | none | Any Rex key, for **Open a Claude session link…** |
| `placement` | `"overlay"` | `overlay` (floating), `split`, `zoomed`, `tab` |
| `direction` | `"right"` | `right`, `down` (for `split` and `zoomed`) |
| `ratio` | `0.5` | The share of the split that the overview gets, between 0 and 1 |
| `context_window` | guessed | Your model's context window in tokens |

Claude Code does not record a model's context window, so the overview guesses it from the model's name: 1,000,000 tokens for Fable, Mythos and Opus 5, and 200,000 for other models until a session grows past that. Set `context_window` when the guess is wrong.

The action is also in the command palette as **Toggle Claude session overview**, and takes a one-off placement:

```sh
rex do rexysesh_toggle placement=split
```

**Open a Claude session link…** is the action `rexysesh_links`. With an address it opens that address without asking:

```sh
rex do rexysesh_links
rex do rexysesh_links url=https://github.com/Gaffen87/RexySesh
```

## How it works

- `bin/rexysesh` is a terminal app written in TypeScript and compiled with Bun. You can also run it on its own in a project's directory, outside Rex.
- The toggle passes the process IDs of the focused pane to the overview. Claude Code keeps a file per running session in `~/.claude/sessions`, named after the session's process ID, so the overview finds the pane's session exactly. From a pane without Claude, it shows the newest running session of the pane's directory.
- Claude Code reports its status to Rex with the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status). The toggle passes the pane's IDs to the overview, which reads the pane's status from Rex and then follows `rex events`, so a permission prompt shows the moment Rex hears of it. Rex also keeps the process that reported the status, which names the session's file. Outside Rex, or when Claude reported nothing, the status comes from the session's file.
- The session's facts come from its transcript in `~/.claude/projects`. The overview reads only what was appended since its last look.
- The branch comes from `git status`, every 5 seconds. The dev servers come from `lsof`, also every 5 seconds: they are the processes that run in the session's directory or below it, listen on a TCP port, and answer HTTP there. A server behind a [pitchfork](https://pitchfork.jdx.dev) proxy is linked by the proxy's address, `<slug>.localhost` on the proxy's port. The pull requests come from `gh pr view` and `gh stack view`, every minute.
- `rexysesh.lua` holds your settings. The installer never overwrites it.
- `rexysesh_toggle.lua` holds the action. The installer rewrites it on every run, with the paths of the overview, `git`, `gh` and `rex` at the top.
- The link picker runs `bin/rexysesh --links`, which prints the session's links as JSON without a terminal, shows them with Rex's `rex.ui.pick`, and opens the chosen one with `bin/rexysesh --open`. Asking GitHub takes most of a second, so the picker lists the pull requests kept from the last lookup in `~/.cache/rexysesh`, and asks GitHub again in the background for the next time. Only the first lookup of a branch waits for GitHub.

## Develop

```sh
bun install
bun test
bun run typecheck
bun run build
```

## License

[MIT](LICENSE)
