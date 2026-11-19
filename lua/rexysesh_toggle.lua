-- install.sh writes this code under lines that set REXYSESH_BIN, GIT_BIN and GH_BIN, the
-- paths of the session overview, git and the GitHub CLI. GH_BIN is empty without the GitHub CLI.

local PLACEMENTS = { split = true, zoomed = true, tab = true, overlay = true }
local SPLIT_DIRECTIONS = { right = "horizontal", down = "vertical" }
local TERMINAL = "com.superlogical.terminal"
local PANE_LABEL = "rexysesh"
local DEFAULT_KEY = "cmd+i"

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

-- Claude Code names a session's file after its process ID, so the process IDs of the
-- focused pane tell the overview exactly which session to show.
local function focused_pane_arguments(focused_block_id)
  if not focused_block_id then return {} end
  local found, process = pcall(function()
    return must(rex.block.call(TERMINAL, "process", { block_id = focused_block_id }))
  end)
  if not found or type(process) ~= "table" then return {} end
  local pane_processes = {}
  if process.foreground then table.insert(pane_processes, process.foreground) end
  for _, ancestor in ipairs(process.ancestors or {}) do table.insert(pane_processes, ancestor) end
  local process_ids, directory = {}, nil
  for _, pane_process in ipairs(pane_processes) do
    if pane_process.pid then table.insert(process_ids, tostring(pane_process.pid)) end
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

local function overview_command(focused_block_id, context_window)
  local command = { REXYSESH_BIN, "--git", GIT_BIN }
  if GH_BIN == "" then
    table.insert(command, "--no-gh")
  else
    table.insert(command, "--gh")
    table.insert(command, GH_BIN)
  end
  if context_window then
    table.insert(command, "--context-window")
    table.insert(command, tostring(context_window))
  end
  for _, argument in ipairs(focused_pane_arguments(focused_block_id)) do
    table.insert(command, argument)
  end
  return command
end

local function open_overview(focused_block_id, window_id, placement, direction, ratio, context_window)
  local pane = rex.layout.block{
    flavor = TERMINAL .. ".shell",
    label = PANE_LABEL,
    options = { command = overview_command(focused_block_id, context_window) },
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
        return open_overview(ctx.block_id, window_id, placement, direction, ratio, context_window)
      end
      for _, pane_id in ipairs(open_pane_ids) do
        must(rex.call("block.close", { session_id = ctx.session_id, block_id = pane_id }))
      end
      return { closed = open_pane_ids }
    end,
  }
  if key then rex.bind(key, "rexysesh_toggle") end
end
