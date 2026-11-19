#!/bin/sh
# Builds the session overview, installs its toggle into Rex's config directory, and reloads Rex.
set -eu

plugin_dir=$(cd -- "$(dirname -- "$0")" && pwd)
init_file=${REX_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/rex/init.lua}
config_dir=$(dirname -- "$init_file")
settings_file=$config_dir/rexysesh.lua
toggle_file=$config_dir/rexysesh_toggle.lua
require_line='require("rexysesh")'

rexysesh_bin=${REXYSESH_BIN:-$plugin_dir/bin/rexysesh}
if [ -z "${REXYSESH_BIN:-}" ]; then
  if command -v bun >/dev/null 2>&1; then
    (cd "$plugin_dir" && bun build src/main.ts --compile --outfile bin/rexysesh >/dev/null)
    echo "built $rexysesh_bin"
  elif [ ! -x "$rexysesh_bin" ]; then
    echo "bun is not on PATH, so the overview cannot be built. Install it (brew install bun)." >&2
    exit 1
  fi
fi

git_bin=${GIT_BIN:-$(command -v git || echo git)}
gh_bin=${GH_BIN:-$(command -v gh || true)}

lua_quoted() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

mkdir -p "$config_dir"

{
  echo "-- install.sh of RexySesh writes this file. Do not edit it. Your settings are in rexysesh.lua."
  echo "local REXYSESH_BIN = \"$(lua_quoted "$rexysesh_bin")\""
  echo "local GIT_BIN = \"$(lua_quoted "$git_bin")\""
  echo "local GH_BIN = \"$(lua_quoted "$gh_bin")\""
  echo
  cat "$plugin_dir/lua/rexysesh_toggle.lua"
} > "$toggle_file"
echo "wrote $toggle_file"

if [ -e "$settings_file" ]; then
  echo "kept your settings in $settings_file"
else
  cp "$plugin_dir/lua/rexysesh.lua" "$settings_file"
  echo "wrote $settings_file with your settings"
fi

if ! grep -qF "$require_line" "$init_file" 2>/dev/null; then
  if [ -s "$init_file" ] && [ -n "$(tail -c 1 "$init_file")" ]; then
    echo >> "$init_file"
  fi
  echo "$require_line" >> "$init_file"
  echo "added $require_line to $init_file"
fi

if rex config reload >/dev/null 2>&1; then
  echo "reloaded Rex's config"
else
  echo "reload Rex's config yourself: rex config reload" >&2
fi
if [ -z "$gh_bin" ]; then
  echo "gh is not on PATH, so pull requests are not looked up. Install it (brew install gh) and run this again."
fi
echo "press cmd+i, or run \"Toggle Claude session overview\" from the command palette"
