local function now_ms()
  return math.floor(reaper.time_precise() * 1000 + 0.5)
end

local function build_status(state, timestamp, detail)
  if timestamp and detail and detail ~= '' then
    return string.format("%s|%d|%s", state, timestamp, detail)
  elseif timestamp then
    return string.format("%s|%d", state, timestamp)
  elseif detail and detail ~= '' then
    return string.format("%s|0|%s", state, detail)
  end
  return state
end

-- File: web_prompter_backend.lua

local sep = package.config:sub(1,1)

local JSON_NULL = {}

local PROJECT_DATA_SECTION = "PROMPTER_WEBUI"
-- Chunking guards extstate length limits when project payload grows large.
local PROJECT_DATA_JSON_KEY = "getProjectDataJson"
local PROJECT_DATA_STATUS_KEY = "getProjectDataStatus"
local PROJECT_DATA_CHUNK_COUNT_KEY = "getProjectDataJson_chunk_count"
local PROJECT_DATA_CHUNK_KEY_PREFIX = "getProjectDataJson_chunk_"
local PROJECT_DATA_CHUNK_SIZE = 1200
local PROJECT_DATA_CHUNK_THRESHOLD = 3600

local function json_escape_string(str)
  local replacements = {
    ['"'] = '\\"',
    ['\\'] = '\\\\',
    [string.char(8)] = '\\b',
    [string.char(12)] = '\\f',
    ['\n'] = '\\n',
    ['\r'] = '\\r',
    ['\t'] = '\\t'
  }
  return str:gsub('[%z\1-\31\\"]', function(char)
    local repl = replacements[char]
    if repl then return repl end
    return string.format('\\u%04X', char:byte())
  end)
end

local function json_encode(val)
  if val == JSON_NULL then
    return "null"
  end
  local json_type = type(val)
  if json_type == "string" then
    return '"' .. json_escape_string(val) .. '"'
  elseif json_type == "number" then
    if val ~= val or val == math.huge or val == -math.huge then
      return "null"
    end
    return string.format('%.14g', val)
  elseif json_type == "boolean" then
    return val and "true" or "false"
  elseif json_type == "table" then
    local is_array = true
    local max_index = 0
    for k, _ in pairs(val) do
      if type(k) ~= "number" or k < 1 or k % 1 ~= 0 then
        is_array = false
        break
      end
      if k > max_index then max_index = k end
    end
    local parts = {}
    if is_array then
      for i = 1, max_index do
        local encoded_item, encode_err = json_encode(val[i])
        if not encoded_item then return nil, encode_err end
        parts[#parts + 1] = encoded_item
      end
      return "[" .. table.concat(parts, ",") .. "]"
    else
      for k, v in pairs(val) do
        if type(k) ~= "string" then return nil, "table key must be a string" end
        local encoded_value, encode_err = json_encode(v)
        if not encoded_value then return nil, encode_err end
        parts[#parts + 1] = '"' .. json_escape_string(k) .. '":' .. encoded_value
      end
      return "{" .. table.concat(parts, ",") .. "}"
    end
  elseif json_type == "nil" then
    return "null"
  end
  return nil, "unsupported type"
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

local function clear_project_data_chunks()
  local count_str = reaper.GetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_CHUNK_COUNT_KEY)
  local count = tonumber(count_str) or 0
  if count > 0 then
    for i = 0, count - 1 do
      local key = PROJECT_DATA_CHUNK_KEY_PREFIX .. i
      reaper.DeleteExtState(PROJECT_DATA_SECTION, key, true)
    end
  end
  reaper.DeleteExtState(PROJECT_DATA_SECTION, PROJECT_DATA_CHUNK_COUNT_KEY, true)
end

local function store_project_data_payload(encoded)
  if not encoded or encoded == '' then
    reaper.SetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_JSON_KEY, '', false)
    reaper.SetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_CHUNK_COUNT_KEY, '0', false)
    clear_project_data_chunks()
    return
  end

  clear_project_data_chunks()

  if #encoded <= PROJECT_DATA_CHUNK_THRESHOLD then
    reaper.SetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_JSON_KEY, encoded, false)
    reaper.SetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_CHUNK_COUNT_KEY, '0', false)
    return
  end

  local total_chunks = math.ceil(#encoded / PROJECT_DATA_CHUNK_SIZE)
  reaper.SetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_JSON_KEY, '__CHUNKED__', false)
  reaper.SetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_CHUNK_COUNT_KEY, tostring(total_chunks), false)

  local start_idx = 1
  for i = 0, total_chunks - 1 do
    local chunk = encoded:sub(start_idx, start_idx + PROJECT_DATA_CHUNK_SIZE - 1)
    reaper.SetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_CHUNK_KEY_PREFIX .. i, chunk or '', false)
    start_idx = start_idx + PROJECT_DATA_CHUNK_SIZE
  end
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

local function collect_tracks()
  local tracks_table = {}
  local track_count = reaper.CountTracks(0)
  for i = 0, track_count - 1 do
    local track = reaper.GetTrack(0, i)
    if track then
      local _, track_name = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
      table.insert(tracks_table, { id = i, name = track_name })
    end
  end
  return tracks_table
end

local function collect_project_name()
  local proj_name_full = reaper.GetProjectName(0)
  if not proj_name_full or proj_name_full == '' then
    return nil
  end
  return proj_name_full:gsub("%.[Rr][Pp][Pp]$", "")
end

local function collect_project_fps()
  local proj = select(1, reaper.EnumProjects(-1))
  if not proj then
    return nil
  end
  local fps, dropFrame = reaper.TimeMap_curFrameRate(proj)
  if (not fps) or fps <= 0 then
    fps = reaper.GetSetProjectInfo(proj, "projvideofps", 0, false)
  end
  if not fps or fps <= 0 then
    return nil
  end
  if dropFrame == nil then dropFrame = false end
  local payload = string.format("%.6f", fps)
  payload = payload .. (dropFrame and "|DF" or "|ND")
  return {
    value = fps,
    normalized = fps,
    raw = payload,
    drop_frame = dropFrame
  }
end

local function collect_roles_json()
  local dir, base = get_project_dir_and_base()
  local source = 'missing'
  local file_path
  if dir and base then
    file_path = dir .. sep .. base .. "-roles.json"
    source = 'project'
  else
    file_path = reaper.GetResourcePath() .. sep .. "reaper_www_root" .. sep .. "unsaved-project-roles.json"
    source = 'unsaved_fallback'
  end
  local f = io.open(file_path, 'r')
  if not f then
    return nil, 'missing'
  end
  local content = f:read('*a') or ''
  f:close()
  return content, source
end

local function build_project_data()
  local tracks = collect_tracks()
  local project_name = collect_project_name()
  local fps_info = collect_project_fps()
  local roles_json, roles_source = collect_roles_json()
  local project_dir, project_base = get_project_dir_and_base()
  local roles_payload = JSON_NULL
  if roles_json and roles_json ~= '' then
    local encoded_roles = '__B64__' .. b64url_encode(roles_json)
    roles_payload = {
      source = roles_source or 'file',
      encoding = 'base64url',
      json = encoded_roles,
      decoded_len = #roles_json
    }
  end
  local meta = {
    version = 1,
    generated_at = os.time(),
    generated_at_ms = math.floor(reaper.time_precise() * 1000 + 0.5),
    tracks_count = #tracks,
    roles_source = roles_source or (roles_json and "file" or "missing"),
    drop_frame = fps_info and fps_info.drop_frame or nil,
    has_project = project_name ~= nil,
    project_dir = project_dir or JSON_NULL,
    project_base = project_base or JSON_NULL
  }
  return {
    version = 1,
    project_name = project_name or JSON_NULL,
    tracks = tracks,
    fps = fps_info or JSON_NULL,
    roles = roles_payload,
    meta = meta
  }
end

local function handle_get_project_data()
  local request_ts = now_ms()
  reaper.SetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_STATUS_KEY, build_status("PENDING", request_ts), false)
  local ok, payload_or_err = pcall(build_project_data)
  if not ok then
    store_project_data_payload('')
    reaper.SetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_STATUS_KEY, build_status("ERROR", now_ms(), tostring(payload_or_err)), false)
    return
  end
  local payload = payload_or_err
  local encoded, encode_err = json_encode(payload)
  if not encoded then
    store_project_data_payload('')
    reaper.SetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_STATUS_KEY, build_status("ERROR", now_ms(), tostring(encode_err)), false)
    return
  end
  local completed_ts = now_ms()
  payload.meta = payload.meta or {}
  payload.meta.status_requested_at_ms = request_ts
  payload.meta.status_completed_at_ms = completed_ts
  store_project_data_payload(encoded)
  reaper.SetExtState(PROJECT_DATA_SECTION, PROJECT_DATA_STATUS_KEY, build_status("OK", completed_ts), false)
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

-- --- НОВАЯ ФУНКЦИЯ ---
-- Функция для декодирования URL-строки
function url_decode(str)
  if not str then return "" end
  str = string.gsub(str, '+', ' ')
  str = string.gsub(str, '%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end)
  return str
end
-- ---------------------

local function parse_query_string(str)
  local result = {}
  if not str or str == '' then return result end
  for pair in string.gmatch(str, '([^&]+)') do
    local key, value = pair:match('([^=]+)=?(.*)')
    if key then
      local decoded_key = url_decode(key)
      local decoded_value = value and url_decode(value) or ''
      result[decoded_key] = decoded_value
    end
  end
  return result
end

local function handle_time_jump(payload)
  if not payload then return end
  local position_ms = tonumber(payload.position_ms) or tonumber(payload.position) or 0
  local position_sec
  if position_ms and position_ms > 0 then
    position_sec = position_ms / 1000
  else
    position_sec = tonumber(payload.position_sec) or tonumber(payload.position_s) or 0
  end
  if not position_sec then position_sec = 0 end
  if position_sec < 0 then position_sec = 0 end
  reaper.SetEditCurPos(position_sec, true, false)
  reaper.UpdateArrange()
  reaper.UpdateTimeline()
end

local function process_event_command()
  local raw_name = reaper.GetExtState(PROJECT_DATA_SECTION, "event_name") or ''
  local raw_payload = reaper.GetExtState(PROJECT_DATA_SECTION, "event_payload") or ''
  if raw_name == '' then
    if raw_payload ~= '' then
      reaper.DeleteExtState(PROJECT_DATA_SECTION, "event_payload", true)
    end
    return
  end
  local event_name = url_decode(raw_name)
  local payload_str = url_decode(raw_payload)
  local payload = parse_query_string(payload_str)
  if event_name == 'time:jump' then
    handle_time_jump(payload)
  end
  reaper.DeleteExtState(PROJECT_DATA_SECTION, "event_name", true)
  if raw_payload ~= '' then
    reaper.DeleteExtState(PROJECT_DATA_SECTION, "event_payload", true)
  end
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

function main()
  local command, _ = reaper.GetExtState("PROMPTER_WEBUI", "command")
  if command == "GET_PROJECT_DATA" then
    handle_get_project_data()
  elseif command == "GET_TEXT" then
    local param, _ = reaper.GetExtState("PROMPTER_WEBUI", "command_param")
    get_text_and_save_to_file(param)
  elseif command == "SAVE_SETTINGS" then
    save_settings()
  elseif command == "SAVE_ROLES" then
    save_roles()
  elseif command == "PROCESS_EVENT" then
    process_event_command()
  end
end

main()
reaper.SetExtState("PROMPTER_WEBUI", "command", "", false)