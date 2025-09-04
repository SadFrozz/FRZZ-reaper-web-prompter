import os
import platform
import re
import sys
import socket
import shutil
import time
import threading

# --- КОНФИГУРАЦИЯ ---
ACTION_ID = "FRZZ_WEB_NOTES_READER"
SCRIPT_NAME = "FRZZ_web_prompter_backend.lua"
WEB_INTERFACE_FILENAME = "prompter.html"
ACTION_LINE_TEMPLATE = 'SCR 4 0 {id} "Custom: Web Prompter Backend" {script}'

# --- ОСНОВНЫЕ ФУНКЦИИ ---

def get_base_path():
    """ Возвращает правильный базовый путь, как для скрипта, так и для скомпилированного файла. """
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    else:
        return os.path.dirname(os.path.abspath(sys.argv[0]))

def get_prompter_title():
    """ Считывает название и версию из <title> тега в prompter.html. """
    default_title = "ИНТЕРАКТИВНЫЙ ТЕКСТОВЫЙ МОНИТОР для REAPER" # <-- Исправлено
    try:
        html_path = os.path.join(get_base_path(), 'reaper_www_root', 'prompter.html')
        if not os.path.exists(html_path): return default_title
        with open(html_path, 'r', encoding='utf-8') as f: content = f.read()
        match = re.search(r'<title>(.*?)</title>', content, re.IGNORECASE)
        return match.group(1).strip() if match else default_title
    except Exception:
        return default_title

def copy_script_files(resource_path):
    """ Копирует содержимое папок Scripts и reaper_www_root в папку ресурсов REAPER. """
    print("\n---\n🔎 Шаг 0: Копирование файлов...")
    try:
        base_dir = get_base_path()
        source_scripts_dir = os.path.join(base_dir, 'Scripts')
        source_www_dir = os.path.join(base_dir, 'reaper_www_root')
        if not os.path.isdir(source_scripts_dir) or not os.path.isdir(source_www_dir):
            print(f"⛔️ Ошибка: Не найдены папки Scripts или reaper_www_root рядом с установщиком!"); return False
        
        dest_scripts_dir = os.path.join(resource_path, 'Scripts')
        dest_www_dir = os.path.join(resource_path, 'reaper_www_root') # <-- ИСПРАВЛЕН ПУТЬ

        print(f"Копирую содержимое из '{source_scripts_dir}' в '{dest_scripts_dir}'...")
        shutil.copytree(source_scripts_dir, dest_scripts_dir, dirs_exist_ok=True)
        print(f"Копирую содержимое из '{source_www_dir}' в '{dest_www_dir}'...")
        shutil.copytree(source_www_dir, dest_www_dir, dirs_exist_ok=True)
        print("✅ Файлы успешно скопированы."); return True
    except Exception as e:
        print(f"⛔️ Произошла критическая ошибка при копировании файлов: {e}"); return False

def get_reaper_resource_path():
    """ Определяет путь к ресурсам REAPER, предлагая пользователю выбор. """
    system = platform.system()
    default_path = ""
    if system == "Windows": default_path = os.path.join(os.environ['APPDATA'], 'REAPER')
    elif system == "Darwin": default_path = os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'REAPER')
    if os.path.isdir(default_path) and os.path.exists(os.path.join(default_path, 'reaper.ini')):
        print(f"✅ Папка конфигурации REAPER найдена: {default_path}")
        print("\n   => Нажмите любую клавишу для продолжения с этой папкой.")
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

def process_keymap_file(resource_path):
    """ Проверяет и исправляет/добавляет строку действия в reaper-kb.ini. """
    keymap_path = os.path.join(resource_path, 'reaper-kb.ini')
    action_line = ACTION_LINE_TEMPLATE.format(id=ACTION_ID, script=SCRIPT_NAME)
    print("\n---\n🔎 Шаг 1: Проверка файла горячих клавиш (reaper-kb.ini)...")
    if not os.path.exists(keymap_path):
        print(f"⚠️ Файл {keymap_path} не найден. Создаю новый...");
        with open(keymap_path, 'w', encoding='utf-8') as f: f.write(action_line + '\n')
        print("✅ Файл reaper-kb.ini создан и обновлен."); return
    try:
        with open(keymap_path, 'r', encoding='utf-8') as f: lines = f.readlines()
        modified = False; found_by_filename_idx = -1; found_by_id_idx = -1
        for i, line in enumerate(lines):
            if SCRIPT_NAME in line: found_by_filename_idx = i
            if ACTION_ID in line: found_by_id_idx = i
        if found_by_filename_idx != -1:
            if ACTION_ID not in lines[found_by_filename_idx]:
                print(f"Найден скрипт '{SCRIPT_NAME}', но у него некорректный ID. Исправляю..."); lines[found_by_filename_idx] = action_line + '\n'; modified = True
            else: print("✅ Действие для текстового монитора уже корректно прописано.") # <-- Исправлено
        elif found_by_id_idx != -1:
            print(f"Найден ID '{ACTION_ID}' со старым именем скрипта. Обновляю..."); lines[found_by_id_idx] = action_line + '\n'; modified = True
        else:
            print(f"Действие для текстового монитора не найдено. Добавляю новую запись..."); lines.append(action_line + '\n'); modified = True # <-- Исправлено
        if modified:
            with open(keymap_path, 'w', encoding='utf-8') as f: f.writelines(lines)
            print("✅ Файл reaper-kb.ini успешно обновлен.")
    except Exception as e:
        print(f"⛔️ Произошла ошибка при работе с файлом reaper-kb.ini: {e}")

def get_local_ip():
    """ Возвращает локальный IP-адрес компьютера. """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try: s.connect(('10.255.255.255', 1)); IP = s.getsockname()[0]
    except Exception: IP = '127.0.0.1'
    finally: s.close()
    return IP

def process_web_interface_settings(resource_path):
    """ Проверяет и настраивает reaper.ini: csurfrate и веб-интерфейс. """
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
    """ Отображает сообщение о завершении и ждет ввода пользователя с тайм-аутом. """
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
        prompt_to_close(30)
    else:
        print("Не удалось определить папку ресурсов REAPER. Установка прервана.")
        input("\nНажмите Enter для выхода.")