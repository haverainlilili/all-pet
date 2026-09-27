-- Load once before `return config`: require('allpet').setup(config)
local wezterm = require 'wezterm'
local M = {}
function M.setup(config)
  config.status_update_interval = math.min(config.status_update_interval or 1000, 400)
  local dir = wezterm.home_dir .. '/.config/all-pet/terminal-bridge/'
  local replies = {}
  local function read(file)
    local f = io.open(file, 'r'); if not f then return nil end
    local data = f:read(65536); f:close()
    local ok, value = pcall(wezterm.json_parse, data); if ok then return value end
  end
  local function update(window)
    local connection = read(dir .. 'connection.json')
    if not connection then return end
    local id = window:window_id()
    local requestPath = dir .. 'wezterm-request-' .. id .. '.json'
    local request = read(requestPath)
    if request and request.token == connection.token and request.expires >= os.time() * 1000 then
      os.remove(requestPath)
      -- Enumerate this existing GUI window only. Never create/resume/send text.
      for _, tab in ipairs(window:mux_window():tabs()) do
        for _, pane in ipairs(tab:panes()) do
          if pane:pane_id() == request.pane then
            tab:activate(); pane:activate(); window:focus(); replies[id] = request.id
          end
        end
      end
    end
    local panes = {}
    for _, tab in ipairs(window:mux_window():tabs()) do
      for _, pane in ipairs(tab:panes()) do
        local info = pane:get_foreground_process_info()
        if info then table.insert(panes, { id = pane:pane_id(), pid = info.pid, tty = pane:get_tty_name(), ['local'] = true }) end
      end
    end
    local file = dir .. 'wezterm-' .. id .. '.json'
    local f = io.open(file .. '.tmp', 'w')
    if f then
      f:write(wezterm.json_encode({ window = id, focused = window:is_focused(), activePane = window:active_pane():pane_id(), reply = replies[id], panes = panes }))
      f:close(); os.remove(file); os.rename(file .. '.tmp', file)
    end
  end
  wezterm.on('update-status', function(window) pcall(update, window) end)
  wezterm.on('window-focus-changed', function(window) pcall(update, window) end)
end
return M
