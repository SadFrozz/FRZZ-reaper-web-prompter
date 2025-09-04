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
  reaper.SetExtState("PROMPTER_WEBUI", "response_tracks", json_encode(tracks_table), false)
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
    
    -- 3. Декодируем строку
    local decoded_settings = url_decode(encoded_settings_string)

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
    local proj_name_full = reaper.GetProjectName(proj, "")
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
  elseif command == "GET_PROJECT_NAME" then
    get_project_name()
  end
end

main()
reaper.SetExtState("PROMPTER_WEBUI", "command", "", false)