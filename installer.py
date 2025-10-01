import os
import platform
import re
import sys
import socket
import shutil
import time
import threading

# --- КОНФИГУРАЦИЯ ---
ACTION_ID_BACKEND = "FRZZ_WEB_NOTES_READER"  # backend data/script processor
ACTION_ID_LAUNCH  = "FRZZ_NOTES_READER_LAUNCH"  # launcher front script
SCRIPT_BACKEND = "FRZZ_web_prompter_backend.lua"
SCRIPT_LAUNCH  = "FRZZ_web_prompter.lua"
WEB_INTERFACE_FILENAME = "prompter.html"
ACTION_LINE_TEMPLATE_BACKEND = 'SCR 4 0 {id} "Custom: Web Prompter Backend" {script}'
ACTION_LINE_TEMPLATE_LAUNCH  = 'SCR 4 0 {id} "Custom: Web Prompter Launch" {script}'

# --- ОСНОВНЫЕ ФУНКЦИИ ---

def get_base_path():
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    else:
        return os.path.dirname(os.path.abspath(sys.argv[0]))

def get_prompter_title():
    default_title = "ИНТЕРАКТИВНЫЙ ТЕКСТОВЫЙ МОНИТОР для REAPER" #
    try:
        html_path = os.path.join(get_base_path(), 'reaper_www_root', 'prompter.html')
        if not os.path.exists(html_path): return default_title
        with open(html_path, 'r', encoding='utf-8') as f: content = f.read()
        match = re.search(r'<title>(.*?)</title>', content, re.IGNORECASE)
        return match.group(1).strip() if match else default_title
    except Exception:
        return default_title

def copy_script_files(resource_path):
    print("\n---\n🔎 Шаг 0: Копирование файлов (Scripts + reaper_www_root + UserPlugins)...")
    try:
        base_dir = get_base_path()
        source_scripts_dir = os.path.join(base_dir, 'Scripts')
        source_www_dir = os.path.join(base_dir, 'reaper_www_root')
        source_userplugins_dir = os.path.join(base_dir, 'UserPlugins')
        if not os.path.isdir(source_scripts_dir) or not os.path.isdir(source_www_dir):
            print(f"⛔️ Ошибка: Не найдены папки Scripts или reaper_www_root рядом с установщиком!"); return False

        dest_scripts_dir = os.path.join(resource_path, 'Scripts')
        dest_www_dir = os.path.join(resource_path, 'reaper_www_root')
        dest_userplugins_dir = os.path.join(resource_path, 'UserPlugins')

        print(f"Копирую Scripts → {dest_scripts_dir}")
        shutil.copytree(source_scripts_dir, dest_scripts_dir, dirs_exist_ok=True)
        print(f"Копирую WWW → {dest_www_dir}")
        shutil.copytree(source_www_dir, dest_www_dir, dirs_exist_ok=True)

        if os.path.isdir(source_userplugins_dir):
            os.makedirs(dest_userplugins_dir, exist_ok=True)
            copy_userplugins_binaries(source_userplugins_dir, dest_userplugins_dir)
        else:
            print("(Инфо) Папка UserPlugins отсутствует — пропуск копирования плагина Reaper WebView.")

        print("✅ Файлы успешно скопированы."); return True
    except Exception as e:
        print(f"⛔️ Произошла критическая ошибка при копировании файлов: {e}"); return False

def _sha256(path):
    """Return SHA256 hex digest of file or None if error."""
    import hashlib
    try:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(65536), b''):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None

def verify_usage_hint(resource_path):
    """Verify that key components were successfully copied (by hash equality) and print usage hint.

    Conditions:
      - Script FRZZ_web_prompter.lua copied (source & destination hashes match)
      - Plugin binary reaper_webview.(dll|dylib) copied and hashes match
      - On Windows only: WebView2Loader.dll copied and hashes match

    If all satisfied -> print the required instruction line in Russian.
    """
    base_dir = get_base_path()
    # Paths
    src_script = os.path.join(base_dir, 'Scripts', SCRIPT_LAUNCH)
    dst_script = os.path.join(resource_path, 'Scripts', SCRIPT_LAUNCH)
    system = platform.system()
    plugin_name = 'reaper_webview.dll' if system == 'Windows' else 'reaper_webview.dylib'
    src_plugin = os.path.join(base_dir, 'UserPlugins', plugin_name)
    dst_plugin = os.path.join(resource_path, 'UserPlugins', plugin_name)
    loader_name = 'WebView2Loader.dll' if system == 'Windows' else None
    if loader_name:
        src_loader = os.path.join(base_dir, 'UserPlugins', loader_name)
        dst_loader = os.path.join(resource_path, 'UserPlugins', loader_name)
    # Compute hashes
    script_ok = os.path.exists(src_script) and os.path.exists(dst_script) and _sha256(src_script) == _sha256(dst_script)
    plugin_ok = os.path.exists(src_plugin) and os.path.exists(dst_plugin) and _sha256(src_plugin) == _sha256(dst_plugin)
    loader_ok = True
    if loader_name:
        loader_ok = os.path.exists(src_loader) and os.path.exists(dst_loader) and _sha256(src_loader) == _sha256(dst_loader)
    if script_ok and plugin_ok and loader_ok:
        print("\nℹ️  Для использования внутри Reaper используйте действие Web Prompter Launch")
        return True
    return False

def get_reaper_resource_path():
    system = platform.system()
    default_path = ""
    if system == "Windows": default_path = os.path.join(os.environ['APPDATA'], 'REAPER')
    elif system == "Darwin": default_path = os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'REAPER')
    if os.path.isdir(default_path) and os.path.exists(os.path.join(default_path, 'reaper.ini')):
        print(f"✅ Папка конфигурации REAPER найдена: {default_path}")
        print("\n   => Нажмите Enter для продолжения с этой папкой.")
        choice = input("   => Или нажмите '1', чтобы указать другой путь: ")
        if choice != '1':
            print("Стандартный путь подтвержден."); return default_path
        else:
            print("\nВыбран ручной ввод пути.")
    else:
        print("❌ Папка конфигурации REAPER не найдена по стандартному пути.")
    while True:
        user_path = input("\nПожалуйста, введите полный путь к папке ресурсов REAPER: ")
        if os.path.isdir(user_path) and os.path.exists(os.path.join(user_path, 'reaper.ini')):
            print(f"✅ Путь принят: {user_path}"); return user_path
        else:
            print("⛔️ Указанный путь некорректен или в нем отсутствует файл 'reaper.ini'. Попробуйте снова.")

def _ensure_action(lines, action_id, script_name, template):
    action_line = template.format(id=action_id, script=script_name)
    modified = False
    found_script_idx = -1
    found_id_idx = -1
    for i, line in enumerate(lines):
        if script_name in line: found_script_idx = i
        if action_id in line: found_id_idx = i
    if found_script_idx != -1:
        if action_id not in lines[found_script_idx]:
            print(f"Исправляю ID для скрипта {script_name} → {action_id}")
            lines[found_script_idx] = action_line + '\n'; modified = True
        else:
            print(f"✅ Action {action_id} для {script_name} уже корректен.")
    elif found_id_idx != -1:
        print(f"Обновляю строку action {action_id} под новый скрипт {script_name}")
        lines[found_id_idx] = action_line + '\n'; modified = True
    else:
        print(f"Добавляю action {action_id} для {script_name}")
        lines.append(action_line + '\n'); modified = True
    return modified

def process_keymap_file(resource_path):
    keymap_path = os.path.join(resource_path, 'reaper-kb.ini')
    print("\n---\n🔎 Шаг 1: Проверка файла горячих клавиш (reaper-kb.ini)...")
    if not os.path.exists(keymap_path):
        print(f"⚠️ Файл {keymap_path} не найден. Создаю новый...")
        with open(keymap_path, 'w', encoding='utf-8') as f:
            f.write(ACTION_LINE_TEMPLATE_BACKEND.format(id=ACTION_ID_BACKEND, script=SCRIPT_BACKEND) + '\n')
            f.write(ACTION_LINE_TEMPLATE_LAUNCH.format(id=ACTION_ID_LAUNCH, script=SCRIPT_LAUNCH) + '\n')
        print("✅ Файл reaper-kb.ini создан и обновлен (2 actions)."); return
    try:
        with open(keymap_path, 'r', encoding='utf-8') as f: lines = f.readlines()
        modified_backend = _ensure_action(lines, ACTION_ID_BACKEND, SCRIPT_BACKEND, ACTION_LINE_TEMPLATE_BACKEND)
        modified_launch  = _ensure_action(lines, ACTION_ID_LAUNCH,  SCRIPT_LAUNCH,  ACTION_LINE_TEMPLATE_LAUNCH)
        if modified_backend or modified_launch:
            with open(keymap_path, 'w', encoding='utf-8') as f: f.writelines(lines)
            print("✅ Файл reaper-kb.ini обновлён.")
    except Exception as e:
        print(f"⛔️ Произошла ошибка при работе с файлом reaper-kb.ini: {e}")

def copy_userplugins_binaries(src_dir, dst_dir):
    print("🔧 Копирование бинарей UserPlugins (с проверкой хеша)...")
    import hashlib
    system = platform.system()
    pattern = '.dll' if system == 'Windows' else '.dylib'
    # Собираем список исходных файлов
    src_files = [f for f in os.listdir(src_dir) if f.lower().endswith(pattern)]
    if not src_files:
        print(f"(Инфо) Нет файлов *{pattern} для копирования.")
        return

    def sha256_of(path):
        try:
            h = hashlib.sha256()
            with open(path, 'rb') as fp:
                for chunk in iter(lambda: fp.read(65536), b''):
                    h.update(chunk)
            return h.hexdigest()
        except Exception:
            return None

    for fname in src_files:
        src_path = os.path.join(src_dir, fname)
        dst_path = os.path.join(dst_dir, fname)
        src_hash = sha256_of(src_path)
        dst_hash = sha256_of(dst_path) if os.path.exists(dst_path) else None
        if dst_hash and src_hash == dst_hash:
            print(f"⏭  {fname} — уже актуален (hash совпадает). Пропуск.")
            continue

        while True:
            try:
                shutil.copy2(src_path, dst_path)
                print(f"✅ Скопирован {fname} (hash: {src_hash[:8]}…)")
                break
            except PermissionError:
                print(f"⚠️ Не удалось заменить {fname} — файл занят (возможно, REAPER запущен).")
                choice = input("Закройте REAPER и выберите: [R]etry / [S]kip / [A]bort: ").strip().lower()
                if choice.startswith('r'):
                    continue
                elif choice.startswith('s'):
                    print(f"Пропуск файла {fname} по запросу пользователя.")
                    break
                else:
                    print("Прерывание установки пользователем.")
                    sys.exit(1)
            except Exception as ex:
                print(f"⛔️ Ошибка копирования {fname}: {ex}")
                break

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try: s.connect(('10.255.255.255', 1)); IP = s.getsockname()[0]
    except Exception: IP = '127.0.0.1'
    finally: s.close()
    return IP

def process_web_interface_settings(resource_path):
    reaper_ini_path = os.path.join(resource_path, 'reaper.ini')
    print("\n---\n🔎 Шаг 2: Проверка настроек REAPER (reaper.ini)...")
    if not os.path.exists(reaper_ini_path):
        print(f"⛔️ Критическая ошибка: Файл {reaper_ini_path} не найден!"); return
    try:
        with open(reaper_ini_path, 'r', encoding='utf-8', errors='ignore') as f: lines = f.readlines()
        original_lines = list(lines)
        csurfrate_found = False
        for i, line in enumerate(lines):
            if line.strip().startswith('csurfrate='):
                csurfrate_found = True
                try:
                    value = int(line.strip().split('=')[1])
                    if value < 100: print(f"Значение csurfrate ({value}) ниже 100. Исправляю на 100."); lines[i] = 'csurfrate=100\n'
                except (ValueError, IndexError): print(f"Некорректная строка csurfrate. Исправляю на 100."); lines[i] = 'csurfrate=100\n'
                break
        if not csurfrate_found:
            print("Параметр csurfrate не найден. Добавляю со значением 100.")
            try:
                reaper_section_pos = next(i for i, line in enumerate(lines) if line.strip().lower() == '[reaper]')
                lines.insert(reaper_section_pos + 1, 'csurfrate=100\n')
            except StopIteration: print("⚠️ Секция [REAPER] не найдена. Добавляю csurfrate в конец файла."); lines.append('csurfrate=100\n')
        prompter_interface_exists = False
        search_pattern = f"'{WEB_INTERFACE_FILENAME}'"
        for line in lines:
            if line.strip().startswith('csurf_') and search_pattern in line:
                print("✅ Веб-интерфейс для текстового монитора уже настроен."); prompter_interface_exists = True; break # <-- Исправлено
        if not prompter_interface_exists:
            print(f"Веб-сервер, использующий '{WEB_INTERFACE_FILENAME}', не найден.")
            choice = input("Хотите создать его сейчас? (да/нет): ").lower()
            if choice in ['да', 'д', 'yes', 'y']:
                port = 0
                while not (1024 <= port <= 65535):
                    try: port_str = input("Введите порт для веб-сервера (например, 8080): "); port = int(port_str)
                    except ValueError: print("⛔️ Это не похоже на число. Попробуйте снова.")
                content_for_search = "".join(lines)
                indices = [int(i) for i in re.findall(r'^csurf_(\d+)=', content_for_search, re.MULTILINE)]
                next_index = max(indices) + 1 if indices else 0
                new_count = next_index + 1; count_found = False
                for i, line in enumerate(lines):
                    if line.strip().startswith('csurf_cnt='): lines[i] = f"csurf_cnt={new_count}\n"; count_found = True; break
                new_csurf_line = f"csurf_{next_index}=HTTP 0 {port} '' '{WEB_INTERFACE_FILENAME}' 1 ''\n"
                insert_pos = -1
                if indices:
                    last_csurf_line = f'csurf_{max(indices)}='
                    for i, line in reversed(list(enumerate(lines))):
                        if line.strip().startswith(last_csurf_line): insert_pos = i + 1; break
                if insert_pos != -1: lines.insert(insert_pos, new_csurf_line)
                else:
                    try:
                        reaper_section_pos = next(i for i, line in enumerate(lines) if line.strip().lower() == '[reaper]')
                        if not count_found: lines.insert(reaper_section_pos + 1, f"csurf_cnt={new_count}\n"); lines.insert(reaper_section_pos + 2, new_csurf_line)
                        else: lines.insert(reaper_section_pos + 1, new_csurf_line)
                    except StopIteration:
                        print("⚠️ Секция [REAPER] не найдена. Добавляю настройки в конец файла.")
                        if not count_found: lines.append(f"csurf_cnt={new_count}\n"); lines.append(new_csurf_line)
                local_ip = get_local_ip()
                print("\n" + "="*60); print("✅ Веб-сервер успешно настроен!"); print("ИНТЕРАКТИВНЫЙ ТЕКСТОВЫЙ МОНИТОР будет доступен по адресу:"); print(f"  -> http://localhost:{port}"); print(f"  -> http://{local_ip}:{port} (с любого устройства в вашей локальной сети)"); print("Эта функция будет работать, пока запущен REAPER."); print("="*60)
            else: print("Отменено. Настройка веб-сервера пропущена.")
        if lines != original_lines:
            print("\nСохраняю изменения в reaper.ini...")
            with open(reaper_ini_path, 'w', encoding='utf-8', errors='ignore') as f: f.writelines(lines)
            print("✅ Файл reaper.ini успешно обновлен.")
    except Exception as e: print(f"⛔️ Произошла ошибка при работе с файлом reaper.ini: {e}")

def prompt_to_close(timeout=30):
    def wait_for_input():
        input(); os._exit(0)
    input_thread = threading.Thread(target=wait_for_input, daemon=True)
    input_thread.start()
    print("\n🎉 Настройка завершена! Перезапустите REAPER, чтобы все изменения вступили в силу.")
    print("   Для закрытия окна нажмите Enter...")
    for i in range(timeout, 0, -1):
        sys.stdout.write(f"\r   ...или окно закроется автоматически через {i:02d} секунд. ")
        sys.stdout.flush(); time.sleep(1)
    print("\r   ...время вышло.                                              ")

# --- ТОЧКА ВХОДА В СКРИПТ ---
if __name__ == "__main__":
    title = get_prompter_title()
    print("="*60); print(f"Автоматический установщик для: {title}"); print("="*60)
    
    resource_folder = get_reaper_resource_path()
    
    if resource_folder:
        if not copy_script_files(resource_folder):
             sys.exit("Установка прервана из-за ошибки копирования файлов.")
        process_keymap_file(resource_folder)
        process_web_interface_settings(resource_folder)
        # Показываем подсказку по использованию только если все ключевые файлы корректно скопированы
        verify_usage_hint(resource_folder)
        prompt_to_close(30)
    else:
        print("Не удалось определить папку ресурсов REAPER. Установка прервана.")
        input("\nНажмите Enter для выхода.")