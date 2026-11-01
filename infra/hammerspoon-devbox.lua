-- Devbox clipboard bridge, mac side. Two shortcuts in Warp:
--   ⌘V  with an IMAGE on the clipboard → Ctrl+V (native cc image paste, served by the xclip shim).
--        Text/files are left alone (⌘V = normal terminal paste).
--   ⌘⇧V with a FILE on the clipboard (⌘C in Finder) → stages the file into the SHARED devbox
--        /inbox (mounted in every container) and TYPES the container path /inbox/<name> into
--        the prompt → cc reads the file. The path is uniform → no target session to resolve.
--
-- Installation (one-time):
--   brew install --cask hammerspoon
--   echo 'dofile("' .. path to repo .. '/infra/hammerspoon-devbox.lua")' >> ~/.hammerspoon/init.lua
--   start Hammerspoon, allow Accessibility, enable Launch at login.

local WARP_BUNDLE = "dev.warp.Warp-Stable"
-- devbox-paste sits next to this lua (infra/); find it via this file's path.
local PASTE_SCRIPT = (debug.getinfo(1, "S").source:sub(2):match("(.*/)") or "") .. "devbox-paste"

-- File on the clipboard = public.file-url in contentTypes (⌘C in Finder).
local function clipboardHasFile()
  local ok, cts = pcall(hs.pasteboard.contentTypes)
  if not ok or type(cts) ~= "table" then return false end
  for _, t in ipairs(cts) do
    if t == "public.file-url" then return true end
  end
  return false
end

-- Global variables on purpose — local eventtaps would be garbage collected.

-- ⌘V + image on the clipboard → Ctrl+V (cc image paste).
devboxClipboardPaste = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(e)
  if not e:getFlags():containExactly({ "cmd" }) then return false end
  if e:getKeyCode() ~= hs.keycodes.map.v then return false end
  local app = hs.application.frontmostApplication()
  if not app or app:bundleID() ~= WARP_BUNDLE then return false end
  local types = hs.pasteboard.typesAvailable()
  if not (types and types.image) then return false end -- text → normal ⌘V
  -- On ⌘C Finder adds a preview icon (com.apple.icns), so a clipboard with a
  -- FILE looks like an image. Ctrl+V would then paste that icon into cc instead of the file —
  -- files belong to ⌘⇧V, here we let them through to the normal ⌘V.
  if clipboardHasFile() then return false end
  hs.eventtap.keyStroke({ "ctrl" }, "v", 0)
  return true
end)
devboxClipboardPaste:start()

-- ⌘⇧V + file on the clipboard → stage into the shared /inbox, then paste the path.
devboxPasteFile = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(e)
  if not e:getFlags():containExactly({ "cmd", "shift" }) then return false end
  if e:getKeyCode() ~= hs.keycodes.map.v then return false end
  local app = hs.application.frontmostApplication()
  if not app or app:bundleID() ~= WARP_BUNDLE then return false end
  if not clipboardHasFile() then
    hs.notify.new({ title = "Devbox paste", informativeText = "No file on the clipboard — ⌘C in Finder" }):send()
    return true
  end
  -- async (network call); the script returns the container path on stdout and also leaves it on the clipboard.
  -- We TYPE the path character by character: Warp ignores a synthetic ⌘V as its own shortcut
  -- (Ctrl+V gets through, ⌘V does not), so the paste was silently lost and the prompt stayed empty.
  hs.task.new("/bin/sh", function(code, stdout)
    if code ~= 0 then return end
    local path = (stdout or ""):match("^%s*(.-)%s*$")
    if path == "" then path = (hs.pasteboard.getContents() or ""):match("^%s*(.-)%s*$") end
    -- We type KEYS into the terminal, so anything unexpected (say a newline in an error
    -- response) would mean Enter. Only the shape devd returns is let through.
    if not path:match("^/inbox/[%w._%-]+$") then
      hs.notify.new({ title = "Devbox paste", informativeText = "Unexpected devd response — path not pasted" }):send()
      return
    end
    hs.eventtap.keyStrokes(path)
  end, { PASTE_SCRIPT }):start()
  return true
end)
devboxPasteFile:start()
