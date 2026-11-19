-- Settings of RexySesh. install.sh wrote this file and never overwrites it.
-- To change a setting, edit it, then run "rex config reload".
local settings = {
  -- key = "cmd+i", -- the key of the toggle, or false for none
  -- placement = "overlay", -- overlay, split, zoomed, or tab
  -- direction = "right", -- of split and zoomed: right or down
  -- ratio = 0.5, -- the share of the split that RexySesh gets
  -- context_window = 200000, -- your model's context window in tokens, when the guess is wrong
}

local loaded, load_error = pcall(function() require("rexysesh_toggle")(settings) end)
if not loaded then
  rex.action{ name = "rexysesh_toggle", title = "Toggle Claude session overview",
    run = function() error("RexySesh: " .. tostring(load_error), 0) end }
  local key = type(settings) == "table" and settings.key
  if key == nil then key = "cmd+i" end
  if key then rex.bind(key, "rexysesh_toggle") end
end
