-- install.sh writes this code under lines that set REXYSESH_BIN, GIT_BIN, GH_BIN and REX_BIN,
-- the paths of the session overview, git, the GitHub CLI and Rex's own CLI. GH_BIN and REX_BIN
-- are empty when the program was not found.

local PLACEMENTS = { split = true, zoomed = true, tab = true, overlay = true }
local SPLIT_DIRECTIONS = { right = "horizontal", down = "vertical" }
local TERMINAL = "com.superlogical.terminal"
local PANE_LABEL = "rexysesh"
local DEFAULT_KEY = "cmd+i"
local CLAUDE_APP = "claude-code"
local LINK_ICONS = { repository = "code", pullRequest = "branch", devServer = "server", artifact = "document" }

local function must(result, call_error)
  if call_error ~= nil then error(call_error, 0) end
  return result
end

local function window_of(blocks, block_id)
  for _, block in ipairs(blocks) do
    if block.block_id == block_id then return block.window_id end
  end
  return nil
end

local function open_overview_panes(blocks, window_id)
  local pane_ids = {}
  for _, block in ipairs(blocks) do
    local in_window = window_id == nil or block.window_id == window_id
    if block.creator_name == TERMINAL and in_window and block.label == PANE_LABEL then
      table.insert(pane_ids, block.block_id)
    end
  end
  return pane_ids
end

-- Without this check a missing overview closes the new pane before its error shows.
local function check_overview_runs()
  local result, exec_error = rex.exec({ REXYSESH_BIN, "--version" }, { timeout = 5 })
  if result == nil then error("cannot run " .. REXYSESH_BIN .. ": " .. tostring(exec_error), 0) end
  if not result.ok then error((result.stderr:gsub("%s+$", "")), 0) end
end

local function terminal_call(method, block_id)
  local found, result = pcall(function()
    return must(rex.block.call(TERMINAL, method, { block_id = block_id }))
  end)
  if found and type(result) == "table" then return result end
  return {}
end

-- Claude Code reports its status to Rex, and Rex keeps the process that reported it.
local function claude_process_id(block_id)
  for _, record in ipairs(terminal_call("program_status", block_id).records or {}) do
    if record.effective_app == CLAUDE_APP and type(record.owner) == "table" and record.owner.pid then
      return tostring(record.owner.pid)
    end
  end
  return nil
end

-- Claude Code names a session's file after its process ID, so the process IDs of the
-- focused pane tell the overview exactly which session to show. The process that reported
-- to Rex as Claude comes first; the pane's process tree covers a Claude that reported nothing.
local function focused_pane_arguments(focused_block_id)
  if not focused_block_id then return {} end
  local process = terminal_call("process", focused_block_id)
  local pane_processes = {}
  if process.foreground then table.insert(pane_processes, process.foreground) end
  for _, ancestor in ipairs(process.ancestors or {}) do table.insert(pane_processes, ancestor) end
  local process_ids, directory = { claude_process_id(focused_block_id) }, nil
  for _, pane_process in ipairs(pane_processes) do
    local process_id = pane_process.pid and tostring(pane_process.pid)
    if process_id and process_id ~= process_ids[1] then table.insert(process_ids, process_id) end
    directory = directory or pane_process.cwd
  end
  local arguments = {}
  if #process_ids > 0 then
    table.insert(arguments, "--pids")
    table.insert(arguments, table.concat(process_ids, ","))
  end
  if directory then
    table.insert(arguments, "--cwd")
    table.insert(arguments, directory)
  end
  return arguments
end

local function append_all(list, items)
  for _, item in ipairs(items) do table.insert(list, item) end
end

-- The arguments that tell the overview which session to read, and with which programs.
local function session_command(focused_block_id)
  local command = { REXYSESH_BIN, "--git", GIT_BIN }
  if GH_BIN == "" then
    table.insert(command, "--no-gh")
  else
    append_all(command, { "--gh", GH_BIN })
  end
  append_all(command, focused_pane_arguments(focused_block_id))
  return command
end

-- With the pane's IDs the overview follows the status that Claude reports to Rex.
local function overview_command(ctx, context_window)
  local command = session_command(ctx.block_id)
  if context_window then
    append_all(command, { "--context-window", tostring(context_window) })
  end
  if REX_BIN ~= "" and ctx.session_id and ctx.block_id then
    append_all(command, { "--rex", REX_BIN, "--session", ctx.session_id, "--block", ctx.block_id })
  end
  return command
end

local function run_overview(command, timeout)
  local result, exec_error = rex.exec(command, { timeout = timeout })
  if result == nil then error("cannot run " .. REXYSESH_BIN .. ": " .. tostring(exec_error), 0) end
  if not result.ok then
    local message = (result.stderr:gsub("%s+$", ""))
    if result.timed_out then message = "the session's links took too long to read" end
    error(message, 0)
  end
  return result.stdout
end

local function link_items(session_links)
  local items = {}
  for _, session_link in ipairs(session_links) do
    table.insert(items, {
      id = session_link.url,
      title = session_link.title,
      subtitle = session_link.url,
      detail = session_link.detail ~= "" and session_link.detail or nil,
      icon = LINK_ICONS[session_link.kind],
    })
  end
  return items
end

-- Called straight from the action's run function: a prompt cannot pause inside pcall.
local function pick_session_link(focused_block_id)
  local command = session_command(focused_block_id)
  table.insert(command, "--links")
  local session_links = rex.json.decode(run_overview(command, 20))
  if type(session_links) ~= "table" or #session_links == 0 then
    error("this Claude session has no links yet", 0)
  end
  local url, reason, detail = rex.ui.pick{
    title = "Claude session links",
    placeholder = "Filter links",
    items = link_items(session_links),
  }
  if url == nil and reason ~= "cancelled" then
    error("could not ask which link to open: " .. tostring(detail or reason), 0)
  end
  return url
end

local function open_overview(ctx, window_id, placement, direction, ratio, context_window)
  local focused_block_id = ctx.block_id
  local pane = rex.layout.block{
    flavor = TERMINAL .. ".shell",
    label = PANE_LABEL,
    options = { command = overview_command(ctx, context_window) },
  }
  if placement == "tab" then
    return must(rex.session.new_window{ window_label = PANE_LABEL, layout = pane })
  elseif placement == "overlay" then
    return must(rex.session.new_layer{
      window_id = window_id,
      bounds = { 0.04, 0.04, 0.92, 0.92 },
      layout = pane,
      focus = true,
    })
  end
  local split = must(rex.session.new_split{
    anchor_id = focused_block_id,
    direction = SPLIT_DIRECTIONS[direction],
    side = "after",
    ratio = 1 - ratio,
    focus = true,
    layout = pane,
  })
  if placement == "zoomed" then
    must(rex.session.zoom_block{ block_id = split.block_ids[1], zoom = true })
  end
  return split
end

return function(settings)
  if type(settings) ~= "table" then
    error("config: settings must be a table, as in: local settings = { }", 0)
  end
  local key = settings.key
  if key == nil then key = DEFAULT_KEY end
  local default_placement = settings.placement or "overlay"
  local direction = settings.direction or "right"
  local ratio = settings.ratio or 0.5
  local context_window = settings.context_window
  if not PLACEMENTS[default_placement] then
    error("config: unknown placement " .. tostring(default_placement)
      .. "; use split, zoomed, tab, or overlay", 0)
  end
  if not SPLIT_DIRECTIONS[direction] then
    error("config: unknown direction " .. tostring(direction) .. "; use right or down", 0)
  end
  if type(ratio) ~= "number" or ratio <= 0 or ratio >= 1 then
    error("config: ratio must be a number between 0 and 1", 0)
  end
  if context_window ~= nil and (type(context_window) ~= "number" or context_window <= 0) then
    error("config: context_window must be a number of tokens, as in 200000", 0)
  end

  rex.action{
    name = "rexysesh_toggle",
    title = "Toggle Claude session overview",
    description = "Open an overview of the focused pane's Claude Code session, or close it",
    category = "RexySesh",
    keywords = "claude session overview context branch pull request pr dev server artifacts info",
    args = { placement = "string?" },
    run = function(ctx, args)
      local placement = args.placement or default_placement
      if not PLACEMENTS[placement] then
        error("unknown placement " .. tostring(placement)
          .. "; use split, zoomed, tab, or overlay", 0)
      end
      local blocks = must(rex.session.list_blocks{}).blocks or {}
      local window_id = window_of(blocks, ctx.block_id)
      local open_pane_ids = open_overview_panes(blocks, window_id)
      if #open_pane_ids == 0 then
        check_overview_runs()
        return open_overview(ctx, window_id, placement, direction, ratio, context_window)
      end
      for _, pane_id in ipairs(open_pane_ids) do
        must(rex.call("block.close", { session_id = ctx.session_id, block_id = pane_id }))
      end
      return { closed = open_pane_ids }
    end,
  }
  if key then rex.bind(key, "rexysesh_toggle") end

  rex.action{
    name = "rexysesh_links",
    title = "Open a Claude session link…",
    description = "Pick a pull request, dev server or artifact of the focused pane's Claude Code session",
    category = "RexySesh",
    keywords = "claude session link pull request pr repository dev server artifact open browser",
    args = { url = "string?" },
    run = function(ctx, args)
      check_overview_runs()
      local url = args.url or pick_session_link(ctx.block_id)
      if url == nil then return end
      run_overview({ REXYSESH_BIN, "--open", url }, 10)
      return { opened = url }
    end,
  }
  if settings.links_key then rex.bind(settings.links_key, "rexysesh_links") end
end
