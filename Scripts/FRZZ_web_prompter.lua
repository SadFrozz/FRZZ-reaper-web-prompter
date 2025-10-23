-- FRZZ_web_prompter.lua
-- Автоопределение порта HTTP WebUI (csurf HTTP) по содержимому REAPER.ini, чтобы не фиксировать 8100 вручную.
-- Логика:
-- 1. Считываем %APPDATA%/REAPER/REAPER.ini
-- 2. Находим секцию [reaper]
-- 3. Получаем значение csurf_cnt (кол-во записей контроллеров csurf_X)
-- 4. Перебираем csurf_0 .. csurf_{cnt-1}, анализируя строки формата
--    csurf_N=HTTP <flags> <port> '' 'prompter.html' ...
-- 5. Берём первую строку где встречается HTTP и 'prompter.html' (в одинарных кавычках) — извлекаем номер порта.
-- 6. Если не найдено — fallback порт 8100.
-- 7. (Изменено) Если не найдено — выводим ошибку и завершаем без fallback.
-- 8. Дополнительно проверяем наличие command id FRZZ_WEB_NOTES_READER в reaper-kb.ini (должен быть установлен backend).

local sep = package.config:sub(1,1) -- platform-specific path separator

local function read_ini_lines(path)
  local f = io.open(path, 'r')
  if not f then return nil, 'Не удалось открыть файл: '..path end
  local lines = {}
  for line in f:lines() do table.insert(lines, line) end
  f:close()
  return lines
end

local function get_reaper_ini_path()
  -- On different platforms the file is named 'reaper.ini'; historically code sometimes used 'REAPER.ini'.
  -- On case-insensitive FS (Windows) both will work; on macOS with case-sensitive FS only correct case matters.
  local base = reaper.GetResourcePath()
  local candidate1 = base .. sep .. 'reaper.ini'
  local f1 = io.open(candidate1, 'r')
  if f1 then f1:close(); return candidate1 end
  local candidate2 = base .. sep .. 'REAPER.ini'
  local f2 = io.open(candidate2, 'r')
  if f2 then f2:close(); return candidate2 end
  -- Return primary expected lowercase name even if not found (caller will handle error)
  return candidate1
end

local function trim(s) return (s:gsub('^%s+', ''):gsub('%s+$','')) end

local function find_reaper_section(lines)
  local in_section = false
  local section_lines = {}
  for _, line in ipairs(lines) do
    local lower_line = line:lower()
    if lower_line:match('^%[reaper%]') then
      in_section = true
    elseif line:match('^%[') then
      if in_section then break end
      in_section = false
    elseif in_section then
      table.insert(section_lines, line)
    end
  end
  return section_lines
end

local function parse_key_values(section_lines)
  local map = {}
  for _, l in ipairs(section_lines) do
    local key, val = l:match('^([^=]+)=(.*)$')
    if key then map[trim(key)] = trim(val or '') end
  end
  return map
end

local function extract_port_from_csurf(value)
  -- Универсальная попытка выдернуть порт: ищем HTTP и следующую за флагами цифру
  -- Форматы могут плавать, поэтому сначала пробуем строгий токенизированный, затем fallback pattern.
  if not value then return nil end
  if not value:match('^HTTP') then return nil end
  local tokens = {}
  for token in value:gmatch("[^%s]+") do table.insert(tokens, token) end
  -- Стандартно: tokens[1]=HTTP, tokens[2]=flags (число), tokens[3]=порт
  local candidate = tokens[3]
  if candidate and candidate:match('^%d+$') then return tonumber(candidate) end
  -- Fallback: найти первую группу цифр после 'HTTP' и возможного флага
  local p = value:match('HTTP%s+%d+%s+(%d+)') or value:match('HTTP%s+(%d+)')
  if p and p:match('^%d+$') then return tonumber(p) end
  return nil
end

local function detect_port()
  local ini_path = get_reaper_ini_path()
  local lines, err = read_ini_lines(ini_path)
  if not lines then return nil, err end
  local section = find_reaper_section(lines)
  if #section == 0 then return nil, 'Секция [reaper] не найдена' end
  local kv = parse_key_values(section)
  local cnt = tonumber(kv['csurf_cnt']) or 0
  if cnt <= 0 then
    -- Возможно старый формат или ни одного контроллера — fallback
    return nil, 'csurf_cnt=0'
  end
  local lower_target = 'prompter.html'
  -- Основной проход по индексам
  for i = 0, cnt - 1 do
    local key = 'csurf_' .. i
    local v = kv[key]
    if v and v:match('^HTTP') and v:lower():find(lower_target, 1, true) then
      local p = extract_port_from_csurf(v)
      if p then return p, nil end
    end
  end
  -- Fallback: иногда csurf_cnt не совпадает или запись не в диапазоне 0..cnt-1
  for k, v in pairs(kv) do
    if k:match('^csurf_%d+$') and type(v) == 'string' then
      if v:match('^HTTP') and v:lower():find(lower_target, 1, true) then
        local p = extract_port_from_csurf(v)
        if p then return p, nil end
      end
    end
  end
  return nil, 'HTTP контроллер с prompter.html не найден'
end

local port, perr = detect_port()
local resource_path = reaper.GetResourcePath()
local keymap_file = resource_path .. sep .. 'reaper-kb.ini'
local action_id = 'FRZZ_WEB_NOTES_READER'
local action_found = false
do
  local f = io.open(keymap_file, 'r')
  if f then
    for line in f:lines() do
      if line:find(action_id, 1, true) then action_found = true break end
    end
    f:close()
  end
end

if not port or not action_found then
  local reasons = {}
  if not port then table.insert(reasons, 'порт WebUI не найден (csurf_* с prompter.html отсутствует)') end
  if not action_found then table.insert(reasons, 'action "'..action_id..'" не найден в reaper-kb.ini') end
  local msg = 'Запуск текстового монитора невозможен:\n - ' .. table.concat(reasons, '\n - ') .. '\n\nПереустановите компонент (инсталлер) или настройте вручную.'
  reaper.ShowMessageBox(msg, 'Web Prompter — ошибка', 0)
  return
end

local is_mac = (reaper.GetOS() or ''):match('OSX') ~= nil
local host = is_mac and '127.0.0.1' or 'localhost'

if reaper.WEBVIEW_Navigate then
  local url = string.format('http://%s:%d', host, port)
  local params = '{"SetTitle":"NotesReader","InstanceId":"wv_NOTES","ShowPanel":"docker"}'
  reaper.WEBVIEW_Navigate(url, params)
else
  reaper.ShowMessageBox("Функция WEBVIEW_Navigate не найдена! Убедитесь, что плагин Reaper WebView обновлен и установлен корректно.", "Ошибка", 0)
end