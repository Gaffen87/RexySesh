# RexySesh

See an overview of a [Claude Code](https://claude.com/claude-code) session in a [Rex](https://www.superlogical.com/rex) pane with one key. A sibling of [RexyGit](https://github.com/Gaffen87/RexyGit) and [RexyTask](https://github.com/Gaffen87/RexyTask).

Focus the pane where Claude runs and press <kbd>Cmd</kbd>+<kbd>I</kbd> to open the overview in a floating pane. Press it again to close it.

The overview only reads. It updates every second while it is open.

## What it shows

- **Session**: the session's title, whether Claude is working or waiting for you, the model and effort, the permission mode, when the session started and how long Claude has worked, the number of prompts and tool calls, the tools used most, the directory, and your last prompt.
- **Context**: how full the context window is, how many tokens are left, how many tokens Claude has written, and how often the session was compacted.
- **Git**: the branch, how far it is ahead of or behind its upstream, the number of changed files, and the branch's pull request with its state, checks and review. Pull requests that Claude opened earlier in the session are listed too.
- **Artifacts**: every artifact the session published, with its title, version and link, newest first.
- **Files edited by Claude**: the files Claude wrote or edited, most recent first, with the number of edits.

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
| <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>k</kbd> <kbd>j</kbd> | Select a pull request or an artifact |
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
| `placement` | `"overlay"` | `overlay` (floating), `split`, `zoomed`, `tab` |
| `direction` | `"right"` | `right`, `down` (for `split` and `zoomed`) |
| `ratio` | `0.5` | The share of the split that the overview gets, between 0 and 1 |
| `context_window` | guessed | Your model's context window in tokens |

Claude Code does not record a model's context window, so the overview guesses it from the model's name: 1,000,000 tokens for Fable, Mythos and Opus 5, and 200,000 for other models until a session grows past that. Set `context_window` when the guess is wrong.

The action is also in the command palette as **Toggle Claude session overview**, and takes a one-off placement:

```sh
rex do rexysesh_toggle placement=split
```

## How it works

- `bin/rexysesh` is a terminal app written in TypeScript and compiled with Bun. You can also run it on its own in a project's directory, outside Rex.
- The toggle passes the process IDs of the focused pane to the overview. Claude Code keeps a file per running session in `~/.claude/sessions`, named after the session's process ID, so the overview finds the pane's session exactly. From a pane without Claude, it shows the newest running session of the pane's directory.
- The session's facts come from its transcript in `~/.claude/projects`. The overview reads only what was appended since its last look.
- The branch comes from `git status`, every 5 seconds. The pull request comes from `gh pr view`, every minute.
- `rexysesh.lua` holds your settings. The installer never overwrites it.
- `rexysesh_toggle.lua` holds the action. The installer rewrites it on every run, with the paths of the overview, `git` and `gh` at the top.

## Develop

```sh
bun install
bun test
bun run typecheck
bun run build
```

## License

[MIT](LICENSE)
