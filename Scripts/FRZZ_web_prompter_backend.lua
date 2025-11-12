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
local SEGMENTATION_MODE_KEY = "segmentation_request_mode"
local SEGMENTATION_PRIORITY_KEY = "segmentation_request_priority"
local SEGMENTATION_VIDEO_TOGGLE_KEY = "segmentation_video_toggle"
local SEGMENTATION_MARKERS_TOGGLE_KEY = "segmentation_markers_toggle"
local SEGMENTATION_VIDEO_KEYWORDS_KEY = "segmentation_video_keywords"
local SEGMENTATION_MARKER_PATTERN_KEY = "segmentation_marker_pattern"
local SEGMENTATION_META_KEY = "segmentation_request_meta"

local ALLOWED_VIDEO_EXTENSIONS = {
  avi = true,
  lcf = true,
  mpg = true,
  mpeg = true,
  mjpeg = true,
  mkv = true,
  mov = true,
  qt = true,
  m4v = true,
  mp4 = true,
  webm = true,
  wmv = true
}

local ALLOWED_VIDEO_EXTENSIONS_ARRAY = {
  "avi", "lcf", "mpg", "mpeg", "mjpeg", "mkv",
  "mov", "qt", "m4v", "mp4", "webm", "wmv"
}

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

local read_segmentation_request
local collect_video_segments
local collect_marker_segments

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
  local segmentation_request = read_segmentation_request()
  local video_segments, video_meta = collect_video_segments(segmentation_request)
  local marker_segments, marker_meta = collect_marker_segments(segmentation_request)
  local segmentation_generated_at = now_ms()
  local segmentation_payload = {
    mode = segmentation_request.mode,
    priority = segmentation_request.priority,
    generated_at_ms = segmentation_generated_at,
    requested_at_ms = segmentation_request.requested_at or JSON_NULL,
    request_reason = segmentation_request.request_reason or '',
    SegByVideo = (video_meta.requested and video_segments) or JSON_NULL,
    SegByMarkers = (marker_meta.requested and marker_segments) or JSON_NULL,
    meta = {
      video = {
        requested = video_meta.requested,
        matched = video_meta.matched,
        total = video_meta.total,
        tracks_scanned = video_meta.tracks_scanned
      },
      markers = {
        requested = marker_meta.requested,
        matched = marker_meta.matched,
        total = marker_meta.total
      }
    }
  }
  return {
    version = 1,
    project_name = project_name or JSON_NULL,
    tracks = tracks,
    fps = fps_info or JSON_NULL,
    roles = roles_payload,
    segmentation = segmentation_payload,
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

local function trim(str)
  if not str then return '' end
  return str:match('^%s*(.-)%s*$') or ''
end

local function to_bool(str)
  if not str or str == '' then return false end
  local normalized = string.lower(str)
  return normalized == '1' or normalized == 'true' or normalized == 'yes' or normalized == 'on'
end

local function get_media_source_path(source)
  if not source then return '' end
  local path = reaper.GetMediaSourceFileName(source)
  if type(path) ~= 'string' then
    return ''
  end
  return path
end

local function build_keyword_patterns(raw)
  local patterns = {}
  if not raw or raw == '' then return patterns end
  for token in string.gmatch(raw, '[^,;\r\n]+') do
    local cleaned = trim(token)
    if cleaned ~= '' then
      local lowered = string.lower(cleaned)
      local has_wildcards = lowered:find('[%*%?]') ~= nil
      local entry = {
        token = cleaned,
        lowered = lowered,
        is_pattern = has_wildcards,
        pattern = nil
      }
      if has_wildcards then
        local escaped = lowered:gsub('([%%%^%$%(%)%.%[%]%+%-%?])', '%%%1')
        escaped = escaped:gsub('%*', '.*'):gsub('%?', '.')
        entry.pattern = '^' .. escaped .. '$'
      end
      patterns[#patterns + 1] = entry
    end
  end
  return patterns
end

local function keyword_match(patterns, text)
  if not text or text == '' or not patterns or #patterns == 0 then
    return false
  end
  local lowered = string.lower(text)
  for _, entry in ipairs(patterns) do
    if entry.is_pattern then
      if lowered:match(entry.pattern) then
        return true, entry.token
      end
    elseif lowered == entry.lowered then
      return true, entry.token
    end
  end
  return false
end

local function expand_marker_template(template)
  local results = {}
  if not template or template == '' then return results end
  local tokens = {}
  local i = 1
  local len = #template
  while i <= len do
    local ch = template:sub(i, i)
    if ch == '(' then
      local depth = 1
      local j = i + 1
      while j <= len and depth > 0 do
        local c = template:sub(j, j)
        if c == '(' then
          depth = depth + 1
        elseif c == ')' then
          depth = depth - 1
        end
        j = j + 1
      end
      if depth ~= 0 then
        tokens[#tokens + 1] = { type = 'literal', value = template:sub(i) }
        break
      end
      local inner = template:sub(i + 1, j - 2 + 1)
      local options = {}
      for option in inner:gmatch('[^|]+') do
        options[#options + 1] = option
      end
      tokens[#tokens + 1] = { type = 'alt', options = options }
      i = j
    else
      local j = i
      while j <= len and template:sub(j, j) ~= '(' do
        j = j + 1
      end
      tokens[#tokens + 1] = { type = 'literal', value = template:sub(i, j - 1) }
      i = j
    end
  end
  local function build(idx, parts)
    if idx > #tokens then
      results[#results + 1] = table.concat(parts)
      return
    end
    local token = tokens[idx]
    if token.type == 'alt' then
      for _, option in ipairs(token.options) do
        parts[#parts + 1] = option
        build(idx + 1, parts)
        parts[#parts] = nil
      end
    else
      parts[#parts + 1] = token.value
      build(idx + 1, parts)
      parts[#parts] = nil
    end
  end
  build(1, {})
  return results
end

local function compile_marker_patterns(raw)
  local compiled = {}
  if not raw or raw == '' then return compiled end
  local expanded = expand_marker_template(raw)
  local seen = {}
  for _, entry in ipairs(expanded) do
    local cleaned = trim(entry)
    if cleaned ~= '' then
      local lowered = string.lower(cleaned)
      if not seen[lowered] then
        local parts = {}
        local captures_number = false
        local i = 1
        local len = #lowered
        while i <= len do
          local ch = lowered:sub(i, i)
          if ch == '$' and lowered:sub(i + 1, i + 1) == 'n' then
            parts[#parts + 1] = '(%d+)'
            captures_number = true
            i = i + 2
          elseif ch:match('%s') then
            while i + 1 <= len and lowered:sub(i + 1, i + 1):match('%s') do
              i = i + 1
            end
            parts[#parts + 1] = '%s+'
            i = i + 1
          elseif ch == '*' then
            parts[#parts + 1] = '.*'
            i = i + 1
          else
            if ch:match('[%^%$%(%)%%.%[%]%+%-%?]') then
              parts[#parts + 1] = '%' .. ch
            else
              parts[#parts + 1] = ch
            end
            i = i + 1
          end
        end
        compiled[#compiled + 1] = {
          original = cleaned,
          compiled = table.concat(parts),
          captures_number = captures_number
        }
        seen[lowered] = true
      end
    end
  end
  return compiled
end

local function match_marker_name(name, patterns)
  if not name or name == '' or not patterns or #patterns == 0 then
    return false
  end
  local lowered = string.lower(name)
  for _, info in ipairs(patterns) do
    local capture = lowered:match(info.compiled)
    if capture then
      if info.captures_number then
        local numeric = tonumber(capture)
        return true, numeric, info
      end
      return true, nil, info
    end
  end
  return false
end

read_segmentation_request = function()
  local raw_mode = trim(string.lower(reaper.GetExtState(PROJECT_DATA_SECTION, SEGMENTATION_MODE_KEY) or ''))
  if raw_mode ~= 'video' and raw_mode ~= 'markers' and raw_mode ~= 'both' then
    raw_mode = 'none'
  end
  local raw_priority = trim(string.lower(reaper.GetExtState(PROJECT_DATA_SECTION, SEGMENTATION_PRIORITY_KEY) or ''))
  if raw_priority ~= 'markers' then
    raw_priority = 'video'
  end

  local video_toggle_raw = reaper.GetExtState(PROJECT_DATA_SECTION, SEGMENTATION_VIDEO_TOGGLE_KEY) or ''
  local markers_toggle_raw = reaper.GetExtState(PROJECT_DATA_SECTION, SEGMENTATION_MARKERS_TOGGLE_KEY) or ''

  local include_video = nil
  local include_markers = nil

  if video_toggle_raw ~= '' then
    include_video = to_bool(video_toggle_raw)
  end
  if markers_toggle_raw ~= '' then
    include_markers = to_bool(markers_toggle_raw)
  end

  if include_video == nil then
    include_video = (raw_mode == 'video' or raw_mode == 'both')
  end
  if include_markers == nil then
    include_markers = (raw_mode == 'markers' or raw_mode == 'both')
  end
  if raw_mode == 'none' then
    include_video = false
    include_markers = false
  end

  local video_keywords_raw = trim(url_decode(reaper.GetExtState(PROJECT_DATA_SECTION, SEGMENTATION_VIDEO_KEYWORDS_KEY)))
  local marker_pattern_raw = trim(url_decode(reaper.GetExtState(PROJECT_DATA_SECTION, SEGMENTATION_MARKER_PATTERN_KEY)))

  local meta_raw = trim(url_decode(reaper.GetExtState(PROJECT_DATA_SECTION, SEGMENTATION_META_KEY)))
  local request_reason = ''
  local requested_at = nil
  if meta_raw ~= '' then
    local parts = {}
    for chunk in meta_raw:gmatch('[^|]+') do
      parts[#parts + 1] = chunk
    end
    if parts[1] then
      local ts = tonumber(parts[1])
      if ts then requested_at = ts end
    end
    if parts[3] then
      request_reason = parts[3]
    end
  end

  local keyword_patterns = include_video and build_keyword_patterns(video_keywords_raw) or {}
  local marker_patterns = include_markers and compile_marker_patterns(marker_pattern_raw) or {}

  return {
    mode = raw_mode,
    priority = raw_priority,
    include_video = include_video,
    include_markers = include_markers,
    video_keywords_raw = video_keywords_raw,
    marker_pattern_raw = marker_pattern_raw,
    video_keyword_patterns = keyword_patterns,
    marker_patterns = marker_patterns,
    requested_at = requested_at,
    request_reason = request_reason
  }
end

collect_video_segments = function(request)
  local segments = {}
  if not request.include_video then
    return segments, {
      requested = false,
      matched = 0,
      total = 0,
      tracks_scanned = 0
    }
  end
  local meta = {
    requested = true,
    matched = 0,
    tracks_scanned = 0,
    items_scanned = 0
  }
  local keyword_patterns = request.video_keyword_patterns or {}
  local has_keyword_filter = #keyword_patterns > 0
  local track_count = reaper.CountTracks(0)
  meta.tracks_scanned = track_count
  for track_idx = 0, track_count - 1 do
    local track = reaper.GetTrack(0, track_idx)
    local _, track_name = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
    track_name = track_name or ''
  local track_match = keyword_match(keyword_patterns, track_name)
    local item_count = reaper.CountTrackMediaItems(track)
    for item_idx = 0, item_count - 1 do
      meta.items_scanned = meta.items_scanned + 1
      local item = reaper.GetTrackMediaItem(track, item_idx)
      local take = reaper.GetActiveTake(item)
      if take and not reaper.TakeIsMIDI(take) then
        local source = reaper.GetMediaItemTake_Source(take)
        local source_path = get_media_source_path(source)
        if source_path ~= '' then
          local lower_path = string.lower(source_path)
          local ext = lower_path:match('%.([%w]+)$') or ''
          if ext ~= '' and ALLOWED_VIDEO_EXTENSIONS[ext] then
            local include = not has_keyword_filter
            if has_keyword_filter then
              if track_match then
                include = true
              else
                local _, take_name = reaper.GetSetMediaItemTakeInfo_String(take, "P_NAME", "", false)
                take_name = take_name or ''
                local take_match = keyword_match(keyword_patterns, take_name)
                if take_match then
                  include = true
                else
                  local file_name = source_path:match('([^/\\]+)$') or source_path
                  local file_match = keyword_match(keyword_patterns, file_name)
                  if file_match then
                    include = true
                  end
                end
              end
            end
            if include then
              local start_pos = reaper.GetMediaItemInfo_Value(item, "D_POSITION") or 0
              local length = reaper.GetMediaItemInfo_Value(item, "D_LENGTH") or 0
              local end_pos = start_pos + length
              local _, item_guid = reaper.GetSetMediaItemInfo_String(item, "GUID", "", false)
              local _, take_name = reaper.GetSetMediaItemTakeInfo_String(take, "P_NAME", "", false)
              take_name = take_name or ''
              local file_name = source_path:match('([^/\\]+)$') or source_path
              segments[#segments + 1] = {
                item_index = item_idx,
                start = start_pos,
                source = 'video',
                file_name = file_name,
                track_name = track_name
              }
              meta.matched = meta.matched + 1
            end
          end
        end
      end
    end
  end
  table.sort(segments, function(a, b)
    if a.start == b.start then
      return a.item_index < b.item_index
    end
    return a.start < b.start
  end)
  meta.total = #segments
  return segments, meta
end

collect_marker_segments = function(request)
  local segments = {}
  local meta = {
    requested = true,
    pattern = request.marker_pattern_raw,
    matched = 0,
    markers_scanned = 0,
    regions_scanned = 0,
    patterns = request.marker_patterns and #request.marker_patterns or 0
  }
  if not request.include_markers or not request.marker_patterns or #request.marker_patterns == 0 then
    meta.requested = request.include_markers and true or false
    meta.total = 0
    return segments, meta
  end
  local _, num_markers, num_regions = reaper.CountProjectMarkers(0)
  local total = (num_markers or 0) + (num_regions or 0)
  for idx = 0, total - 1 do
    local ok, is_region, pos, rgnend, name, marker_index, color = reaper.EnumProjectMarkers2(0, idx)
    if ok then
      if is_region == 1 then
        meta.regions_scanned = meta.regions_scanned + 1
      else
        meta.markers_scanned = meta.markers_scanned + 1
      end
      local matched = match_marker_name(name or '', request.marker_patterns)
      if matched then
        meta.matched = meta.matched + 1
        local start_pos = pos or 0
        local entry = {
          index = marker_index or idx,
          source = is_region == 1 and 'region' or 'marker',
          name = name or '',
          start = start_pos
        }
        segments[#segments + 1] = entry
      end
    end
  end
  table.sort(segments, function(a, b)
    if a.start == b.start then
      return a.index < b.index
    end
    return a.start < b.start
  end)
  meta.total = #segments
  return segments, meta
end

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