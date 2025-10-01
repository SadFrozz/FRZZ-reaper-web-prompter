-- File: web_prompter_backend.lua

local sep = package.config:sub(1,1)

local function json_encode(val)
  local json_type = type(val)
  if json_type == "string" then
    return '"' .. val:gsub('[\\"]', {['\\'] = '\\\\', ['"'] = '\\"'}):gsub('[\b]', '\\b'):gsub('[\f]', '\\f'):gsub('[\n]', '\\n'):gsub('[\r]', '\\r'):gsub('[\t]', '\\t') .. '"'
  elseif json_type == "number" or json_type == "boolean" then
    return tostring(val)
  elseif json_type == "table" then
    local is_array = (val[1] ~= nil)
    local parts = {}
    if is_array then
      for i = 1, #val do table.insert(parts, json_encode(val[i])) end
      return "[" .. table.concat(parts, ",") .. "]"
    else -- is object
      for k, v in pairs(val) do
        if type(k) ~= "string" then return nil, "table key must be a string" end
        table.insert(parts, json_encode(k) .. ":" .. json_encode(v))
      end
      return "{" .. table.concat(parts, ",") .. "}"
    end
  elseif json_type == "nil" then return "null"
  else return nil, "unsupported type"
  end
end

-- Base64url encode (no padding) helper
local function b64url_encode(data)
  local b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  local s = {}
  local len = #data
  local i = 1
  while i <= len do
    local a = data:byte(i) or 0; i = i + 1
    local b1 = data:byte(i) or 0; i = i + 1
    local c = data:byte(i) or 0; i = i + 1
    local n = (a << 16) | (b1 << 8) | c
    local c1 = (n >> 18) & 63
    local c2 = (n >> 12) & 63
    local c3 = (n >> 6) & 63
    local c4 = n & 63
    table.insert(s, b:sub(c1+1,c1+1))
    table.insert(s, b:sub(c2+1,c2+1))
    if i-1 > len+1 then
      table.insert(s, '=')
      table.insert(s, '=')
    elseif i-1 > len then
      table.insert(s, b:sub(c3+1,c3+1))
      table.insert(s, '=')
    else
      table.insert(s, b:sub(c3+1,c3+1))
      table.insert(s, b:sub(c4+1,c4+1))
    end
  end
  local out = table.concat(s)
  out = out:gsub('=+$',''):gsub('%+','-'):gsub('/','_')
  return out
end

-- Resolve current project full path and base name
local function get_project_dir_and_base()
  local proj, projfn = reaper.EnumProjects(-1)
  if not projfn or projfn == '' then return nil, nil end
  local dir, file = projfn:match("^(.*)[/\\]([^/\\]+)$")
  if not file or not dir then return nil, nil end
  local base = file:gsub("%.[Rr][Pp][Pp]$", "")
  return dir, base
end

local function save_roles()
  local num_chunks_str = reaper.GetExtState("PROMPTER_WEBUI", "roles_chunks")
  local num_chunks = tonumber(num_chunks_str)
  if not num_chunks or num_chunks == 0 then
    reaper.SetExtState("PROMPTER_WEBUI", "roles_status", "NO_CHUNKS", false)
    return
  end
  local encoded = ''
  for i=0, num_chunks-1 do
    local chunk = reaper.GetExtState("PROMPTER_WEBUI", "roles_data_"..i)
    if chunk and chunk ~= '' then encoded = encoded .. chunk end
  end
  local roles_json
  if encoded:sub(1,7) == "__B64__" then
    -- Reuse existing base64url decode logic from settings
    local b64 = encoded:sub(8):gsub('-', '+'):gsub('_', '/')
    local pad = #b64 % 4
    if pad == 2 then b64 = b64 .. '==' elseif pad == 3 then b64 = b64 .. '=' end
    local chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    local decode_map = {}
    for i=1,#chars do decode_map[chars:sub(i,i)] = i-1 end
    local out = {}
    local i = 1
    while i <= #b64 do
      local c1 = decode_map[b64:sub(i,i)] or 0; i=i+1
      local c2 = decode_map[b64:sub(i,i)] or 0; i=i+1
      local c3 = decode_map[b64:sub(i,i)] or 0; i=i+1
      local c4 = decode_map[b64:sub(i,i)] or 0; i=i+1
      local n = c1 * 262144 + c2 * 4096 + c3 * 64 + c4
      local b1 = math.floor(n / 65536) % 256
      local b2 = math.floor(n / 256) % 256
      local b3 = n % 256
      table.insert(out, string.char(b1, b2, b3))
    end
    roles_json = table.concat(out):gsub('%z+$','')
  else
    roles_json = url_decode(encoded)
  end
  local dir, base = get_project_dir_and_base()
  local file_path, status
  if not dir or not base then
    -- Project not saved yet: fallback to resource path temp file
    file_path = reaper.GetResourcePath() .. sep .. "reaper_www_root" .. sep .. "unsaved-project-roles.json"
    status = "NO_PROJECT_SAVED_FALLBACK"
  else
    file_path = dir .. sep .. base .. "-roles.json"
    status = "SUCCESS"
  end
  local ok = false
  local f = io.open(file_path, 'w')
  if f then f:write(roles_json or '') f:close() ok = true else status = "WRITE_ERROR" end
  -- Debug log
  local dbg_path = reaper.GetResourcePath() .. sep .. "reaper_www_root" .. sep .. "debug_roles.log"
  local dbg = io.open(dbg_path, 'a')
  if dbg then
    dbg:write("===== SAVE_ROLES DEBUG =====\n")
    dbg:write("Timestamp: " .. os.date('%Y-%m-%d %H:%M:%S') .. "\n")
    dbg:write("Chunks: " .. tostring(num_chunks) .. "\n")
    dbg:write("EncodedLen: " .. tostring(#encoded) .. " DecodedLen: " .. tostring(roles_json and #roles_json or 0) .. "\n")
    dbg:write("FilePath: " .. tostring(file_path) .. "\n")
    dbg:write("Status: " .. tostring(status) .. "\n")
    dbg:write("First100: " .. (encoded:sub(1,100)) .. "\n")
    dbg:write("============================\n")
    dbg:close()
  end
  reaper.SetExtState("PROMPTER_WEBUI", "roles_status", status, false)
  -- Cleanup extstates
  reaper.DeleteExtState("PROMPTER_WEBUI", "roles_chunks", true)
  for i=0, (num_chunks-1) do
    reaper.DeleteExtState("PROMPTER_WEBUI", "roles_data_"..i, true)
  end
end

local function get_roles()
  local dir, base = get_project_dir_and_base()
  if not dir or not base then
    reaper.SetExtState("PROMPTER_WEBUI", "roles_json_b64", "", false)
    return
  end
  local file_path = dir .. sep .. base .. "-roles.json"
  local f = io.open(file_path, 'r')
  if not f then
    reaper.SetExtState("PROMPTER_WEBUI", "roles_json_b64", "", false)
    return
  end
  local content = f:read('*a')
  f:close()
  local b64 = '__B64__' .. b64url_encode(content)
  reaper.SetExtState("PROMPTER_WEBUI", "roles_json_b64", b64, false)
end

-- --- НОВАЯ ФУНКЦИЯ ---
-- Функция для декодирования URL-строки
function url_decode(str)
  if not str then return "" end
  str = string.gsub(str, '+', ' ')
  str = string.gsub(str, '%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end)
  return str
end
-- ---------------------

function get_and_serialize_tracks()
  local tracks_table = {}
  local track_count = reaper.CountTracks(0)
  for i = 0, track_count - 1 do
    local track = reaper.GetTrack(0, i)
    if track then
      local _, track_name = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
      table.insert(tracks_table, {id = i, name = track_name})
    end
  end
  local encoded, err = json_encode(tracks_table)
  if not encoded then encoded = '[]' end
  reaper.SetExtState("PROMPTER_WEBUI", "response_tracks", encoded, false)
end

function get_text_and_save_to_file(track_id_str)
  local track_id = tonumber(track_id_str)
  if track_id == nil then return end
  local track = reaper.GetTrack(0, track_id)
  if not track then return end
  local item_count = reaper.CountTrackMediaItems(track)
  local subtitles = {}
  for i = 0, item_count - 1 do
    local item = reaper.GetTrackMediaItem(track, i)
    if item then
      local retval, notes = reaper.GetSetMediaItemInfo_String(item, "P_NOTES", "", false)
      if retval and notes ~= "" then
        local item_start = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
        local item_end = item_start + reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
        local item_color_int = reaper.GetMediaItemInfo_Value(item, "I_CUSTOMCOLOR")
        local item_color_hex = nil
        if item_color_int ~= 0 then
          local r, g, b = reaper.ColorFromNative(item_color_int)
          item_color_hex = string.format("#%02x%02x%02x", r, g, b)
        end
        table.insert(subtitles, {start_time = item_start, end_time = item_end, text = notes, color = item_color_hex})
      end
    end
  end
  local file_path = reaper.GetResourcePath() .. sep .. "reaper_www_root" .. sep .. "subtitles.json"
  local file, err = io.open(file_path, "w")
  if file then
    file:write(json_encode(subtitles))
    file:close()
  end
end

-- --- ОБНОВЛЕННАЯ ФУНКЦИЯ ---
function save_settings()
    -- 1. Получаем количество "кусков"
    local num_chunks_str, _ = reaper.GetExtState("PROMPTER_WEBUI", "settings_chunks")
    local num_chunks = tonumber(num_chunks_str)
    
    if not num_chunks or num_chunks == 0 then return end -- Выход, если данных нет

    -- 2. Собираем полную строку из всех "кусков"
    local encoded_settings_string = ""
    for i = 0, num_chunks - 1 do
        local chunk, _ = reaper.GetExtState("PROMPTER_WEBUI", "settings_data_" .. i)
        encoded_settings_string = encoded_settings_string .. (chunk or "")
    end
    
  -- 3. Декодируем строку (поддержка base64url префикса) + диагностика
  local decoded_settings
  local total_encoded_len = reaper.GetExtState("PROMPTER_WEBUI", "settings_total_encoded_len") or ''
  local total_decoded_len = reaper.GetExtState("PROMPTER_WEBUI", "settings_total_decoded_len") or ''
  if encoded_settings_string:sub(1,7) == "__B64__" then
    local b64 = encoded_settings_string:sub(8)
    b64 = b64:gsub('-', '+'):gsub('_', '/')
    local pad = #b64 % 4
    if pad == 2 then b64 = b64 .. '==' elseif pad == 3 then b64 = b64 .. '=' end
    local chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    local decode_map = {}
    for i=1,#chars do decode_map[chars:sub(i,i)] = i-1 end
    local out = {}
    local i = 1
    while i <= #b64 do
      local c1 = decode_map[b64:sub(i,i)] or 0; i=i+1
      local c2 = decode_map[b64:sub(i,i)] or 0; i=i+1
      local c3 = decode_map[b64:sub(i,i)] or 0; i=i+1
      local c4 = decode_map[b64:sub(i,i)] or 0; i=i+1
      local n = c1 * 262144 + c2 * 4096 + c3 * 64 + c4
      local b1 = math.floor(n / 65536) % 256
      local b2 = math.floor(n / 256) % 256
      local b3 = n % 256
      table.insert(out, string.char(b1, b2, b3))
    end
    decoded_settings = table.concat(out):gsub('%z+$','')
  else
    decoded_settings = url_decode(encoded_settings_string)
  end

  -- DEBUG: Запись диагностической информации
  local debug_path = reaper.GetResourcePath() .. sep .. "reaper_www_root" .. sep .. "debug_settings.log"
  local dbg = io.open(debug_path, "a")
  if dbg then
    dbg:write("===== SAVE_SETTINGS DEBUG =====\n")
    dbg:write("Timestamp: " .. os.date('%Y-%m-%d %H:%M:%S') .. "\n")
    dbg:write("NumChunks: " .. tostring(num_chunks) .. "\n")
    dbg:write("EncodedLenReported: " .. total_encoded_len .. " ActualConcatLen: " .. tostring(#encoded_settings_string) .. "\n")
    dbg:write("DecodedLenReported: " .. total_decoded_len .. " ActualDecodedLen: " .. tostring(decoded_settings and #decoded_settings or 0) .. "\n")
    dbg:write("FirstChunk(100): " .. (encoded_settings_string:sub(1,100)) .. "\n")
    if #encoded_settings_string > 120 then
      dbg:write("LastChunk(100): " .. (encoded_settings_string:sub(-100)) .. "\n")
    end
    if decoded_settings then
      dbg:write("DecodedPrefix(200): " .. decoded_settings:sub(1,200) .. "\n")
    end
    dbg:write("================================\n")
    dbg:close()
  end

    -- 4. Записываем в файл
    if decoded_settings ~= "" then
        local file_path = reaper.GetResourcePath() .. sep .. "reaper_www_root" .. sep .. "settings.json"
        local file, err = io.open(file_path, "w")
        if file then
            file:write(decoded_settings)
            file:close()
        end
    end
    
    -- 5. (Опционально) Очищаем временные данные
    reaper.DeleteExtState("PROMPTER_WEBUI", "settings_chunks", true)
    for i = 0, num_chunks - 1 do
        reaper.DeleteExtState("PROMPTER_WEBUI", "settings_data_" .. i, true)
    end
end
-- ---------------------------

function get_project_name()
    local proj = 0
  local proj_name_full = reaper.GetProjectName(proj)
    local proj_name = proj_name_full:gsub("%.[Rr][Pp][Pp]$", "")
    reaper.SetExtState("PROMPTER_WEBUI", "project_name", proj_name, false)
end

function main()
  local command, _ = reaper.GetExtState("PROMPTER_WEBUI", "command")
  if command == "GET_TRACKS" then
    get_and_serialize_tracks()
  elseif command == "GET_TEXT" then
    local param, _ = reaper.GetExtState("PROMPTER_WEBUI", "command_param")
    get_text_and_save_to_file(param)
  elseif command == "SAVE_SETTINGS" then
    save_settings()
  elseif command == "SAVE_ROLES" then
    save_roles()
  elseif command == "GET_ROLES" then
    get_roles()
  elseif command == "GET_PROJECT_NAME" then
    get_project_name()
  end
end

main()
reaper.SetExtState("PROMPTER_WEBUI", "command", "", false)