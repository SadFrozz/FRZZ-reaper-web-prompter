// --- НАСТРОЙКИ ПО УМОЛЧАНИЮ ---
const defaultSettings = {
    fontSize: 2,
    lineHeight: 1.4,
    navigationPanelPosition: 'bottom',
    frameRate: 24,
    autoScroll: true,
    scrollSpeed: 60,
    theme: 'dark',
    lineSpacing: 50,
    fontFamily: "'-apple-system', BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    // New base = 200 (represents 100% actual). Slider range 50..300 => 25%..150% relative to old base 100.
    // Baseline logic remains: 200 == 100% visual. Default now 100 (i.e. 50% of previous default visual size).
    uiScale: 100,
    titleMode: 'placeholder',
    customTitleText: 'Мой суфлер',
    autoFindTrack: true,
    autoFindKeywords: "сабы, субтитры, sub, subs, subtitle, текст",
    enableColorSwatches: true,
    processRoles: true,
    roleDisplayStyle: 'column_with_swatch',
    autoHideEmptyColumn: true,
    roleColumnScale: 100,
    swapColumns: false,
    roleFontColorEnabled: true,
    deduplicateRoles: true, // ++ НОВАЯ НАСТРОЙКА ++
    checkerboardEnabled: false,
    checkerboardMode: 'by_role',
    checkerboardBg1: 'rgba(34, 34, 34, 1)',
    checkerboardFont1: 'rgba(238, 238, 238, 1)',
    checkerboardBg2: 'rgba(42, 42, 42, 1)',
    checkerboardFont2: 'rgba(238, 238, 238, 1)',
    highlightCurrentBg: 'rgba(80, 80, 0, 0.4)',
    highlightCurrentRoleEnabled: true,
    highlightCurrentRoleBg: 'rgba(80, 80, 0, 0.4)',
    highlightPauseBg: 'rgba(0, 80, 120, 0.3)',
    highlightClickEnabled: true,
    highlightClickBg: 'rgba(120, 0, 120, 0.4)',
    highlightClickDuration: 800,
    progressBarColor: 'rgba(255, 193, 7, 1)'
};
let settings = {};
let currentProjectName = '';
let animationFrameId = null;
let wwr_is_enabled = false;

$(document).ready(function() {
    // --- ПЕРЕМЕННЫЕ ---
    const REASCRIPT_ACTION_ID = "_FRZZ_WEB_NOTES_READER";
    const BASE_LINE_SPACING = 0.5;
    const BASE_ROLE_WIDTH = 9.375;
    const BASE_ROLE_FONT_SIZE = 0.9;
    const mainTitle = $('h1');
    const trackSelector = $('#track-selector');
    const textDisplay = $('#text-display');
    const statusIndicator = $('#status-indicator');
    const refreshButton = $('#refresh-button');
    const navigationPanel = $('#navigation-panel');
    const transportStatus = $('#transport-status');
    const transportStateText = $('#transport-state-text');
    const transportTimecode = $('#transport-timecode');
    const saveSettingsButton = $('#save-settings-button');
    const resetSettingsButton = $('#reset-settings-button');
    const titleModeSelect = $('#title-mode');
    const customTitleWrapper = $('#custom-title-wrapper');
    const customTitleText = $('#custom-title-text');
    const autoScrollCheckbox = $('#auto-scroll');
    const uiScaleSlider = $('#ui-scale');
    const uiScaleValue = $('#ui-scale-value');
    const scrollSpeedSlider = $('#scroll-speed');
    const scrollSpeedValue = $('#scroll-speed-value');
    const scrollSpeedCaption = $('#scroll-speed-caption');
    const lineSpacingSlider = $('#line-spacing');
    const lineSpacingValue = $('#line-spacing-value');
    const autoFindTrackCheckbox = $('#auto-find-track');
    const autoFindKeywordsWrapper = $('#auto-find-keywords-wrapper');
    const processRolesCheckbox = $('#process-roles');
    const roleOptionsWrapper = $('#role-options-wrapper');
    const roleDisplayStyleSelect = $('#role-display-style');
    const enableColorSwatchesCheckbox = $('#enable-color-swatches');
    const roleColumnScaleWrapper = $('#role-column-scale-wrapper');
    const roleColumnScaleSlider = $('#role-column-scale');
    const roleColumnScaleValue = $('#role-column-scale-value');
    const checkerboardEnabledCheckbox = $('#checkerboard-enabled');
    const checkerboardOptionsWrapper = $('#checkerboard-options-wrapper');
    const highlightCurrentRoleEnabledCheckbox = $('#highlight-current-role-enabled');
    const highlightClickEnabledCheckbox = $('#highlight-click-enabled');
    const highlightClickOptionsWrapper = $('#highlight-click-options-wrapper');
    const highlightRoleColorWrapper = $('#highlight-role-color-wrapper');
    const roleFontColorEnabledCheckbox = $('#role-font-color-enabled');
    let subtitleData = [];
    let subtitleElements = [];
    let currentLineIndex = -1;
    let latestTimecode = 0;
    const speedSteps = [1];
    for (let i = 10; i <= 200; i += 10) { speedSteps.push(i); }
    speedSteps.push(500);
    scrollSpeedSlider.attr('min', 0).attr('max', speedSteps.length - 1).attr('step', 1);

    // --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
    function isColorLight(color) {
        try {
            let r, g, b;
            if (color.match(/^#/)) {
                const hex = color.replace('#', '');
                if (hex.length === 3) { r = parseInt(hex[0]+hex[0], 16); g = parseInt(hex[1]+hex[1], 16); b = parseInt(hex[2]+hex[2], 16); } 
                else { r = parseInt(hex.substring(0,2), 16); g = parseInt(hex.substring(2,4), 16); b = parseInt(hex.substring(4,6), 16); }
            } else if (color.match(/^rgb/)) {
                const parts = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                if (parts) { r = parseInt(parts[1], 10); g = parseInt(parts[2], 10); b = parseInt(parts[3], 10); }
            }
            if (isNaN(r)) return false;
            return (0.299 * r + 0.587 * g + 0.114 * b) > 149;
        } catch(e) { console.error(e); return false; }
    }

    function lightenColor(hexColor, targetLuminance = 186) { if (!hexColor || hexColor === '#000000') return '#333333'; let hex = hexColor.replace('#', ''); let r = parseInt(hex.substring(0, 2), 16); let g = parseInt(hex.substring(2, 4), 16); let b = parseInt(hex.substring(4, 6), 16); let luminance = (0.299 * r + 0.587 * g + 0.114 * b); if (luminance >= targetLuminance) { return hexColor; } let factor = 0.05; while (luminance < targetLuminance && factor < 1) { r = Math.min(255, r + (255 - r) * factor); g = Math.min(255, g + (255 - g) * factor); b = Math.min(255, b + (255 - b) * factor); luminance = (0.299 * r + 0.587 * g + 0.114 * b); factor += 0.05; } return '#' + Math.round(r).toString(16).padStart(2, '0') + Math.round(g).toString(16).padStart(2, '0') + Math.round(b).toString(16).padStart(2, '0'); }
    
    function formatTimecode(totalSeconds) { const hours = Math.floor(totalSeconds / 3600); const minutes = Math.floor((totalSeconds % 3600) / 60); const seconds = Math.floor(totalSeconds % 60); const frames = Math.floor((totalSeconds - Math.floor(totalSeconds)) * settings.frameRate); return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`; }
    
    function getScrollSpeedCaption(speed) { if (speed === 1) return "Я БЛИТЦ! СКОРОСТЬ БЕЗ ГРАНИЦ"; if (speed >= 10 && speed <= 40) return "Ой, что-то меня укачало"; if (speed >= 50 && speed <= 70) return "Да не укачивает меня, просто резко встал"; if (speed >= 80 && speed <= 100) return "У меня хороший вестибу-бу-булярный аппарат"; if (speed >= 110 && speed <= 150) return "Это по вашему скорость?"; if (speed >= 160 && speed <= 200) return "АМЕРИКАНСКИЕ ГОРКИ! Ю-ХУУУ!!!"; if (speed === 500) return "Вы Борис?"; return ""; }

    function kebabToCamel(s) { return s.replace(/-./g, x => x.charAt(1).toUpperCase()); }

    function updateTitle() {
        $('body').removeClass('title-hidden');
        switch (settings.titleMode) {
            case 'project_name': const displayName = currentProjectName ? `Текущий проект: ${currentProjectName}` : 'Загрузка имени проекта...'; mainTitle.text(displayName); break;
            case 'custom_text': mainTitle.text(settings.customTitleText); break;
            case 'none': $('body').addClass('title-hidden'); break;
            default: mainTitle.text('Интерактивный текстовый монитор'); break;
        }
    }
   
    function updateScaleWrapperVisibility() {
        try {
            const rolesInColumn = processRolesCheckbox.is(':checked') && (roleDisplayStyleSelect.val() === 'column_with_swatch' || roleDisplayStyleSelect.val() === 'column');
            const swatchesEnabled = enableColorSwatchesCheckbox.is(':checked');
            roleColumnScaleWrapper.toggle(rolesInColumn || swatchesEnabled);
        } catch (e) { console.error("Error in updateScaleWrapperVisibility:", e); }
    }

    function initializeColorPickers() {
        const colorInputs = $('input[type="text"]').filter(function() {
            const id = $(this).attr('id');
            return id && defaultSettings.hasOwnProperty(kebabToCamel(id)) && (id.toLowerCase().includes('color') || id.toLowerCase().includes('bg') || id.toLowerCase().includes('font'));
        });
        colorInputs.spectrum({
            type: "component", showPaletteOnly: true, togglePaletteOnly: true, hideAfterPaletteSelect: true,
            showInput: true, showInitial: true, allowEmpty: false, showAlpha: true, preferredFormat: "rgba",
            // Defer applying changes until user presses Save; only update input value.
            change: function(color) { if (color) { $(this).val(color.toRgbString()); } }
        });
    }

    function applySettings() {
        try {
            const tempSettings = {};
            Object.keys(defaultSettings).forEach(key => {
                const id = '#' + key.replace(/([A-Z])/g, "-$1").toLowerCase();
                const el = $(id);
                if (el.length) {
                    if (el.is(':checkbox')) { tempSettings[key] = el.is(':checked'); }
                    else if (el.is('input[type="range"]')) { const val = parseInt(el.val(), 10); tempSettings[key] = key === 'scrollSpeed' ? speedSteps[val] : val; }
                    else if (el.is('input[type="number"]')) { tempSettings[key] = parseInt(el.val(), 10); }
                    else { const color = el.spectrum("get"); if (color && color.toRgbString) { tempSettings[key] = color.toRgbString(); } else { tempSettings[key] = el.val(); } }
                } else { tempSettings[key] = settings[key] || defaultSettings[key]; }
            });
            // Sanitize highlightClickDuration
            if (isNaN(tempSettings.highlightClickDuration) || tempSettings.highlightClickDuration <= 0 || tempSettings.highlightClickDuration > 60000) {
                tempSettings.highlightClickDuration = settings.highlightClickDuration || defaultSettings.highlightClickDuration;
            }

            // Preserve last non-empty keywords while user toggles other options (live preview phase)
            if (!tempSettings.autoFindKeywords || !tempSettings.autoFindKeywords.trim()) {
                tempSettings.autoFindKeywords = settings.autoFindKeywords || defaultSettings.autoFindKeywords;
            }

            // Normalize navigation panel position from checkbox (backward compatibility)
            const navPosCheckbox = $('#navigation-panel-position');
            if (navPosCheckbox.length) {
                tempSettings.navigationPanelPosition = navPosCheckbox.is(':checked') ? 'top' : 'bottom';
            }

            // Map theme-toggle checkbox to theme (light/dark)
            const themeToggle = $('#theme-toggle');
            if (themeToggle.length) {
                tempSettings.theme = themeToggle.is(':checked') ? 'light' : 'dark';
            } else if (!tempSettings.theme) { tempSettings.theme = 'dark'; }

            // Live preview for title mode (previously only applied when project name arrived)
            (function previewTitleMode(ts) {
                $('body').removeClass('title-hidden');
                if (ts.titleMode === 'none') { $('body').addClass('title-hidden'); }
                else if (ts.titleMode === 'custom_text') { mainTitle.text(ts.customTitleText || ''); }
                else if (ts.titleMode === 'project_name') { const displayName = currentProjectName ? `Текущий проект: ${currentProjectName}` : 'Загрузка имени проекта...'; mainTitle.text(displayName); }
                else if (ts.titleMode === 'placeholder') { mainTitle.text('Интерактивный текстовый монитор'); }
            })(tempSettings);

            $('body').toggleClass('light-theme', tempSettings.theme === 'light');
            navigationPanel.toggleClass('top-panel', tempSettings.navigationPanelPosition === 'top');
            $('body').toggleClass('columns-swapped', tempSettings.swapColumns);
            $('body').toggleClass('hide-empty-role-column', tempSettings.autoHideEmptyColumn);
            textDisplay.css({'font-family': tempSettings.fontFamily});

            // Apply UI scale: baseline 100 => 100% root. Additional 0.75 scaling will be applied via CSS on main container.
            let rawScale = tempSettings.uiScale || 100;
            rawScale = Math.min(300, Math.max(50, rawScale));
            rawScale = Math.round((rawScale - 50)/25)*25 + 50; if(rawScale>300) rawScale=300;
            const percent = rawScale; // direct mapping
            $('html').css('font-size', percent + '%').removeClass('ui-scale-clamped');
            
            let settingsStyle = $('#dynamic-settings-styles');
            if (settingsStyle.length === 0) { settingsStyle = $('<style id="dynamic-settings-styles"></style>').appendTo('head'); }
            
            const verticalPadding = (BASE_LINE_SPACING * (tempSettings.lineSpacing / 100));
            let styleText = `.subtitle-container { padding-top: ${verticalPadding}em; padding-bottom: ${verticalPadding}em; }`;
            
            const scale = tempSettings.roleColumnScale / 100;
            const roleWidthRem = BASE_ROLE_WIDTH * scale;
            const roleFontSizeEm = BASE_ROLE_FONT_SIZE * scale;
            styleText += `.subtitle-role { width: ${roleWidthRem}rem; font-size: ${roleFontSizeEm}em; }`;

            if (tempSettings.checkerboardEnabled) {
                styleText += `
                    .subtitle-container.checkerboard-color-1 { background-color: ${tempSettings.checkerboardBg1}; color: ${tempSettings.checkerboardFont1}; }
                    .subtitle-container.checkerboard-color-1 .subtitle-time, .subtitle-container.checkerboard-color-1 .subtitle-role { color: ${tempSettings.checkerboardFont1}; }
                    .subtitle-container.checkerboard-color-2 { background-color: ${tempSettings.checkerboardBg2}; color: ${tempSettings.checkerboardFont2}; }
                    .subtitle-container.checkerboard-color-2 .subtitle-time, .subtitle-container.checkerboard-color-2 .subtitle-role { color: ${tempSettings.checkerboardFont2}; }`;
            }
            
            function generateHighlightRules(className, bgColor, highlightRoleEnabled, roleBgColor) {
                if(!bgColor){
                    // Fallback to defaultSettings mapping by class
                    if(className==='current-line') bgColor = defaultSettings.highlightCurrentBg;
                    else if(className==='pause-highlight') bgColor = defaultSettings.highlightPauseBg;
                    else if(className==='click-highlight') bgColor = defaultSettings.highlightClickBg;
                }
                const mainTextColor = isColorLight(bgColor) ? '#000' : '#fff';
                let rules = `
                    .${className} { background-color: ${bgColor} !important; }
                    .${className}, .${className} .subtitle-time, .${className} .subtitle-text { color: ${mainTextColor} !important; }
                    .${className} .subtitle-separator { background-color: #007acc !important; }`;
                if (highlightRoleEnabled) {
                    const actualRoleBg = roleBgColor || bgColor;
                    const roleTextColor = isColorLight(actualRoleBg) ? '#000' : '#fff';
                    rules += `.${className} .subtitle-role { background-color: ${actualRoleBg} !important; color: ${roleTextColor} !important; }`;
                }
                return rules;
            }
            styleText += generateHighlightRules('current-line', tempSettings.highlightCurrentBg, tempSettings.highlightCurrentRoleEnabled, tempSettings.highlightCurrentRoleBg);
            styleText += generateHighlightRules('pause-highlight', tempSettings.highlightPauseBg, tempSettings.highlightCurrentRoleEnabled, tempSettings.highlightCurrentRoleBg);
            styleText += generateHighlightRules('click-highlight', tempSettings.highlightClickBg, tempSettings.highlightCurrentRoleEnabled, tempSettings.highlightCurrentRoleBg);
            styleText += `.subtitle-progress-bar { background-color: ${tempSettings.progressBarColor}; }`;
            
            settingsStyle.text(styleText);
            // After applying font/UI scale, re-evaluate navigation panel wrapping
            scheduleTransportWrapEvaluation();
        } catch (e) { console.error("Error in applySettings:", e); }
    }

    // ++ НОВАЯ ФУНКЦИЯ: Обновляет весь UI в соответствии с объектом settings ++
    function updateUIFromSettings() {
        const s = settings;
        Object.keys(s).forEach(key => {
            const id = '#' + key.replace(/([A-Z])/g, "-$1").toLowerCase();
            const el = $(id);
            if (el.length) {
                if (el.is(':checkbox')) { el.prop('checked', s[key]); }
                else if (el.is('input[type="range"]')) {
                    if (key === 'scrollSpeed') {
                        const closestIndex = speedSteps.reduce((prev, curr, index) =>
                            (Math.abs(curr - s[key]) < Math.abs(speedSteps[prev] - s[key]) ? index : prev), 0);
                        el.val(closestIndex);
                    } else { el.val(s[key]); }
                } else if (el.is('input[type="number"]')) {
                    el.val(s[key]);
                } else if (el.spectrum) { el.spectrum("set", s[key]); }
                else { el.val(s[key]); }
            }
        });

        // Reflect navigation panel position into checkbox
        const navPosCheckbox = $('#navigation-panel-position');
        if (navPosCheckbox.length) {
            navPosCheckbox.prop('checked', s.navigationPanelPosition === 'top');
        }

        // Reflect theme into theme-toggle checkbox
        const themeToggle = $('#theme-toggle');
        if (themeToggle.length) {
            themeToggle.prop('checked', s.theme === 'light');
        }

        customTitleWrapper.toggle(s.titleMode === 'custom_text');
        autoFindKeywordsWrapper.toggle(s.autoFindTrack);
        $('#scroll-speed-wrapper').toggle(s.autoScroll);
        // Explicitly set value for auto-find keywords input (was missing, causing empty overwrite on save)
        const autoFindKeywordsInput = $('#auto-find-keywords');
        if (autoFindKeywordsInput.length) {
            autoFindKeywordsInput.val(s.autoFindKeywords || defaultSettings.autoFindKeywords);
        }
        roleOptionsWrapper.toggle(s.processRoles);
        checkerboardOptionsWrapper.toggle(s.checkerboardEnabled);
        highlightClickOptionsWrapper.toggle(s.highlightClickEnabled);
        highlightRoleColorWrapper.toggle(s.highlightCurrentRoleEnabled);

        const scrollIndex = parseInt(scrollSpeedSlider.val(), 10);
        const scrollValue = speedSteps[scrollIndex] || 60;
        scrollSpeedValue.text(scrollValue + '%');
        scrollSpeedCaption.text(getScrollSpeedCaption(scrollValue));
    // Display value as entered (no conversion) for user clarity
    uiScaleValue.text(s.uiScale);
        lineSpacingValue.text(s.lineSpacing + '%');
        roleColumnScaleValue.text(s.roleColumnScale + '%');
        updateScaleWrapperVisibility();
    }

    async function loadSettings() {
        // Attempt to read settings.json from REAPER resource web root.
        // Rule: if file exists -> use it (ignore localStorage). If not -> defaults (optionally merge any localStorage overrides later if desired).
        let fileSettings = null;
        try {
            const resp = await fetch('settings.json?_ts=' + Date.now(), { cache: 'no-store' });
            if (resp.ok) {
                fileSettings = await resp.json();
                console.debug('[Prompter][loadSettings] Loaded settings.json');
            } else {
                console.debug('[Prompter][loadSettings] settings.json not found (status', resp.status, ') using defaults');
            }
        } catch(fetchErr) {
            console.debug('[Prompter][loadSettings] settings.json fetch error, using defaults:', fetchErr);
        }
        try {
            if (fileSettings) {
                settings = { ...defaultSettings, ...fileSettings };
            } else {
                // fallback purely to defaults (do NOT pull stale localStorage if file missing per current spec)
                settings = { ...defaultSettings };
            }
            // Migration: previous stored values may have baseline misunderstanding.
            // If value still reflects legacy domain (<=150 interpreted as old 100-base wanting doubling) AND > default.
                if (settings.uiScale > 150) {
                    settings.uiScale = Math.round(settings.uiScale / 2);
            }
                // Sanitize click highlight duration
                if (typeof settings.highlightClickDuration !== 'number' || settings.highlightClickDuration <= 0 || settings.highlightClickDuration > 60000) {
                    settings.highlightClickDuration = defaultSettings.highlightClickDuration;
                }
            // Enforce new bounds & snap
            settings.uiScale = Math.min(300, Math.max(50, settings.uiScale));
            settings.uiScale = Math.round((settings.uiScale - 50)/25)*25 + 50;
            if (settings.uiScale > 300) settings.uiScale = 300;
        } catch(e) {
            console.warn('[Prompter][loadSettings] Error during parse/migration, reverting to defaults:', e);
            settings = { ...defaultSettings };
        }
        // Reflect slider attributes
    $('#ui-scale').attr({ min:50, max:300, step:25 });
    initializeColorPickers();
        updateUIFromSettings();
        applySettings();
        console.debug('[Prompter][loadSettings] Effective settings:', JSON.parse(JSON.stringify(settings)));
    }

    function saveSettings() {
        try {
            const settingsToSave = {};
            Object.keys(defaultSettings).forEach(key => {
                const id = '#' + key.replace(/([A-Z])/g, "-$1").toLowerCase();
                const el = $(id);
                if (el.length) {
                    if (el.is(':checkbox')) { settingsToSave[key] = el.is(':checked'); }
                    else if (el.is('input[type="range"]')) { const val = parseInt(el.val(), 10); settingsToSave[key] = key === 'scrollSpeed' ? speedSteps[val] : val; }
                    else if (el.is('input[type="number"]')) { settingsToSave[key] = parseInt(el.val(), 10); }
                    else { const color = el.spectrum("get"); if (color && color.toRgbString) { settingsToSave[key] = color.toRgbString(); } else { settingsToSave[key] = el.val(); } }
                } else { settingsToSave[key] = settings[key]; }
            });
            if (isNaN(settingsToSave.highlightClickDuration) || settingsToSave.highlightClickDuration <= 0 || settingsToSave.highlightClickDuration > 60000) {
                settingsToSave.highlightClickDuration = defaultSettings.highlightClickDuration;
            }

            // Guard: do not allow empty autoFindKeywords to wipe previous value
            if (!settingsToSave.autoFindKeywords || !settingsToSave.autoFindKeywords.trim()) {
                settingsToSave.autoFindKeywords = settings.autoFindKeywords || defaultSettings.autoFindKeywords;
            }

            // Persist navigation panel position from checkbox
            const navPosCheckbox = $('#navigation-panel-position');
            if (navPosCheckbox.length) {
                settingsToSave.navigationPanelPosition = navPosCheckbox.is(':checked') ? 'top' : 'bottom';
            }

            // Persist theme from theme-toggle
            const themeToggle = $('#theme-toggle');
            if (themeToggle.length) {
                settingsToSave.theme = themeToggle.is(':checked') ? 'light' : 'dark';
            }
            
            settings = settingsToSave;
            localStorage.setItem('teleprompterSettings', JSON.stringify(settings));
            console.debug('[Prompter][saveSettings] Saved settings:', JSON.parse(JSON.stringify(settings)));
            applySettings();
            if (subtitleData.length > 0) handleTextResponse(subtitleData); // Перерисовываем текст
            
            const settingsString = JSON.stringify(settings, null, 2);
            const encodedSettings = encodeURIComponent(settingsString);
            const chunkSize = 500;
            const numChunks = Math.ceil(encodedSettings.length / chunkSize);
            wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_chunks/${numChunks}`);
            for (let i = 0; i < numChunks; i++) {
                wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_data_${i}/${encodedSettings.substr(i * chunkSize, chunkSize)}`);
            }
            wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/SAVE_SETTINGS');
            setTimeout(() => { wwr_req(REASCRIPT_ACTION_ID); }, 150);
        } catch (e) { console.error("Error in saveSettings:", e); }
        finally { $('#settings-modal').hide(); }
    }
    
    function resetSettings() {
        try {
            if (confirm("Вы уверены, что хотите сбросить все настройки к значениям по умолчанию? Это действие нельзя будет отменить.")) {
                settings = { ...defaultSettings };
                localStorage.setItem('teleprompterSettings', JSON.stringify(settings));
                console.debug('[Prompter][resetSettings] Reset to defaults');
                
                updateUIFromSettings();
                applySettings();
                if (subtitleData.length > 0) handleTextResponse(subtitleData);

                const settingsString = JSON.stringify(settings, null, 2);
                const encodedSettings = encodeURIComponent(settingsString);
                const chunkSize = 500;
                const numChunks = Math.ceil(encodedSettings.length / chunkSize);
                wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_chunks/${numChunks}`);
                for (let i = 0; i < numChunks; i++) {
                    wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_data_${i}/${encodedSettings.substr(i * chunkSize, chunkSize)}`);
                }
                wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/SAVE_SETTINGS');
                setTimeout(() => { wwr_req(REASCRIPT_ACTION_ID); }, 150);
            }
        } catch(e) { console.error("Error resetting settings:", e); }
    }
    
    function initialize() {
        try {
            statusIndicator.text('Подключение к REAPER...');
            wwr_start();
            getTracks();
            getProjectName();
            wwr_req_recur("TRANSPORT", 20);
            renderLoop();
            evaluateTransportWrap();
        } catch(e) { console.error("Error in initialize:", e); }
    }

    function getProjectName() {
        wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/GET_PROJECT_NAME');
        setTimeout(() => { wwr_req(REASCRIPT_ACTION_ID); }, 50);
        setTimeout(() => { wwr_req('GET/EXTSTATE/PROMPTER_WEBUI/project_name'); }, 250);
    }

    function getTracks() {
        statusIndicator.text('Запрос списка дорожек...');
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/GET_TRACKS`);
        setTimeout(() => { wwr_req(REASCRIPT_ACTION_ID); }, 50);
        setTimeout(() => { wwr_req('GET/EXTSTATE/PROMPTER_WEBUI/response_tracks'); }, 250);
    }

    function getText(trackId) {
        statusIndicator.text(`Запрос текста с дорожки ${trackId}...`);
        textDisplay.html('<p>Загрузка текста...</p>');
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command_param/${trackId}`);
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/GET_TEXT`);
        setTimeout(() => { wwr_req(REASCRIPT_ACTION_ID); }, 50);
        setTimeout(() => {
            fetch('/subtitles.json?v=' + new Date().getTime())
                .then(response => { if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`); return response.json(); })
                .then(data => handleTextResponse(data))
                .catch(error => {
                    statusIndicator.text('Ошибка загрузки файла субтитров.');
                    textDisplay.html('<p>Не удалось загрузить субтитры. Проверьте, что Reaper запущен и скрипты установлены корректно.</p>');
                    console.error(error);
                });
        }, 500);
    }
    
    wwr_onreply = function(results) {
        if (!results) return;
        const lines = results.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split('\t');
            if (parts[0] === 'EXTSTATE' && parts[1] === 'PROMPTER_WEBUI') {
                if (parts[2] === 'response_tracks') handleTracksResponse(parts.slice(3).join('\t'));
                else if (parts[2] === 'project_name') { currentProjectName = parts.slice(3).join('\t'); updateTitle(); }
            } else if (parts[0] === 'TRANSPORT') handleTransportResponse(parts);
        }
    };

    function handleTracksResponse(jsonData) {
        if (!jsonData) return;
        try {
            const tracks = JSON.parse(jsonData);
            trackSelector.empty();
            tracks.forEach(track => { trackSelector.append(`<option value="${track.id}">${track.id + 1}: ${track.name}</option>`); });
            statusIndicator.text('Список дорожек загружен.');
            autoFindSubtitleTrack();
        } catch (e) {
            statusIndicator.text('Ошибка обработки списка дорожек.');
            console.error(e);
        }
    }

    function renderLoop() {
        try {
            updateTeleprompter(latestTimecode);
            animationFrameId = requestAnimationFrame(renderLoop);
        } catch(e) { console.error("Error in renderLoop:", e); }
    }
    
    function autoFindSubtitleTrack() {
        if (!settings.autoFindTrack || $('#track-selector option').length === 0) {
            if ($('#track-selector option').length > 0) { $('#track-selector option:first').prop('selected', true); getText($('#track-selector').val()); }
            return;
        }
        const keywords = settings.autoFindKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        let found = false;
        $('#track-selector option').each(function() {
            const trackName = $(this).text().toLowerCase();
            const match = keywords.some(keyword => new RegExp(keyword.includes('*') ? keyword.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') : `\\b${keyword}\\b`).test(trackName));
            if (match) { $(this).prop('selected', true); getText($(this).val()); found = true; return false; }
        });
        if (!found) { $('#track-selector option:first').prop('selected', true); getText($('#track-selector').val()); }
    }

    function handleTextResponse(subtitles) {
        try {
            if (!Array.isArray(subtitles)) { throw new Error('Полученные данные не являются массивом субтитров.'); }
            subtitleData = subtitles;
            subtitleElements = [];
            textDisplay.empty();
            if (subtitleData.length === 0) return;
            
            let lineStyles = $('#dynamic-line-styles');
            if (lineStyles.length === 0) { lineStyles = $('<style id="dynamic-line-styles"></style>').appendTo('head'); }
            
            let lastRoleForCheckerboard = null, lastColorForCheckerboard = null, colorIndex = 0, dynamicRoleStyles = "", lastRoleForDeduplication = null;

            subtitleData.forEach((line, index) => {
                let role = '', text = line.text;
                const roleMatch = text.match(/^\[(.*?)\]\s*/);
                if (roleMatch && settings.processRoles) {
                    role = roleMatch[1];
                    if (settings.roleDisplayStyle !== 'inline') { text = text.substring(roleMatch[0].length); }
                }

                // Progress container is always present (space reserved) to avoid layout shift when highlighting current line
                const lineHtml = `<div class="subtitle-container" data-index="${index}"><div class="role-area"><div class="subtitle-color-swatch"></div><div class="subtitle-role">${role}</div><div class="subtitle-separator"></div></div><div class="subtitle-time">${formatTimecode(line.start_time)}</div><div class="subtitle-content"><div class="subtitle-text"></div><div class="subtitle-progress-container"><div class="subtitle-progress-bar"></div></div></div></div>`;
                const lineElement = $(lineHtml);
                const roleElement = lineElement.find('.subtitle-role');
                const swatchElement = lineElement.find('.subtitle-color-swatch');
                lineElement.find('.subtitle-text').text(text);
                
                if (settings.deduplicateRoles && role && role === lastRoleForDeduplication) {
                    roleElement.html('&nbsp;'); // Оставляем пустое пространство
                }
                lastRoleForDeduplication = role || null;

                if (settings.checkerboardEnabled) {
                    if (settings.checkerboardMode === 'unconditional') { lineElement.addClass(`checkerboard-color-${(index % 2) + 1}`); }
                    else if (settings.checkerboardMode === 'by_role') { const currentRole = role || 'no_role'; if (currentRole !== lastRoleForCheckerboard) { colorIndex = 1 - colorIndex; lastRoleForCheckerboard = currentRole; } lineElement.addClass(`checkerboard-color-${colorIndex + 1}`); }
                    else if (settings.checkerboardMode === 'by_color') { const currentColor = line.color || 'no_color'; if (currentColor !== lastColorForCheckerboard) { colorIndex = 1 - colorIndex; lastColorForCheckerboard = currentColor; } lineElement.addClass(`checkerboard-color-${colorIndex + 1}`); }
                }
                
                const hasColor = line.color;
                const showRoleInColumn = settings.processRoles && role && (settings.roleDisplayStyle === 'column' || settings.roleDisplayStyle === 'column_with_swatch');
                const showSwatch = settings.enableColorSwatches && hasColor && settings.roleDisplayStyle !== 'column_with_swatch' && !showRoleInColumn;
                
                // ++ ИЗМЕНЕНО: Используем visibility для сохранения разметки ++
                roleElement.css('visibility', showRoleInColumn ? 'visible' : 'hidden');
                swatchElement.css('visibility', showSwatch ? 'visible' : 'hidden');
                
                if (showRoleInColumn && settings.roleDisplayStyle === 'column_with_swatch' && settings.enableColorSwatches && hasColor) {
                    roleElement.addClass('role-colored-bg').css('visibility', 'visible');
                    let effectiveBgColor = line.color, effectiveTextColor;
                    if (settings.roleFontColorEnabled) { effectiveBgColor = lightenColor(line.color); effectiveTextColor = '#000000'; }
                    else { effectiveTextColor = isColorLight(effectiveBgColor) ? '#000000' : '#ffffff'; }
                    dynamicRoleStyles += `.subtitle-container[data-index="${index}"] .role-colored-bg { background-color: ${effectiveBgColor}; color: ${effectiveTextColor}; }`;
                } else if (showSwatch) { swatchElement.css('background-color', line.color); }
                
                lineElement.find('.role-area').toggleClass('role-area-is-empty', !showRoleInColumn && !showSwatch);
                
                textDisplay.append(lineElement);
                subtitleElements.push(lineElement);
            });
            
            lineStyles.text(dynamicRoleStyles);
            statusIndicator.text(`Текст получен, всего ${subtitleData.length} реплик`);
            applySettings();
        } catch (e) { console.error("Error in handleTextResponse:", e); }
    }
    
    function handleTransportResponse(transportData) {
        try {
            if (transportData.length < 3) return;
            const playState = parseInt(transportData[1], 10);
            latestTimecode = parseFloat(transportData[2]);
            transportTimecode.text(formatTimecode(latestTimecode));
            switch (playState) {
                case 1: transportStatus.removeClass('status-stop status-record').addClass('status-play'); transportStateText.text('Play'); break;
                case 5: transportStatus.removeClass('status-stop status-play').addClass('status-record'); transportStateText.text('Rec'); break;
                default: transportStatus.removeClass('status-play record').addClass('status-stop'); transportStateText.text('Stop'); break;
            }
        } catch(e) { console.error("Error in transport response:", e); }
    }
    
    function updateTeleprompter(currentTime) {
        try {
            let newCurrentLineIndex = -1, inPause = false;
            for (let i = subtitleData.length - 1; i >= 0; i--) {
                if (subtitleData[i].start_time <= currentTime) {
                    newCurrentLineIndex = i;
                    if (currentTime >= subtitleData[i].end_time) { inPause = true; }
                    break;
                }
            }
            if (newCurrentLineIndex !== currentLineIndex) { if (currentLineIndex !== -1 && subtitleElements[currentLineIndex]) { subtitleElements[currentLineIndex].removeClass('current-line pause-highlight'); } }
            if (newCurrentLineIndex !== -1 && subtitleElements[newCurrentLineIndex]) { const newElement = subtitleElements[newCurrentLineIndex]; if (inPause) { if (!newElement.hasClass('pause-highlight')) newElement.removeClass('current-line').addClass('pause-highlight'); } else { if (!newElement.hasClass('current-line')) newElement.removeClass('pause-highlight').addClass('current-line'); } }
            else if (currentLineIndex !== -1 && subtitleElements[currentLineIndex]) { subtitleElements[currentLineIndex].removeClass('current-line pause-highlight'); }
            if (newCurrentLineIndex !== currentLineIndex) {
                if (newCurrentLineIndex !== -1 && subtitleElements[newCurrentLineIndex] && settings.autoScroll) {
                    const newContainer = subtitleElements[newCurrentLineIndex], wrapper = $('#text-display-wrapper'), wrapperHeight = wrapper.height();
                    const lineTop = newContainer.position().top + wrapper.scrollTop(), scrollDuration = 400 / (settings.scrollSpeed / 100);
                    const linePositionInViewport = newContainer.position().top, topThreshold = wrapperHeight * 0.1, bottomThreshold = wrapperHeight * 0.9 - newContainer.outerHeight(true);
                    if (linePositionInViewport < topThreshold || linePositionInViewport > bottomThreshold) wrapper.stop().animate({ scrollTop: lineTop - (wrapperHeight * 0.2) }, scrollDuration);
                }
                currentLineIndex = newCurrentLineIndex;
            }
            if (currentLineIndex !== -1 && subtitleElements[currentLineIndex] && !inPause) {
                const currentSub = subtitleData[currentLineIndex], lineDuration = currentSub.end_time - currentSub.start_time;
                let percentage = lineDuration > 0 ? ((currentTime - currentSub.start_time) / lineDuration) * 100 : 0;
                subtitleElements[currentLineIndex].find('.subtitle-progress-bar').css('transform', `scaleX(${Math.max(0, Math.min(100, percentage)) / 100})`);
            } else if (currentLineIndex !== -1 && subtitleElements[currentLineIndex]) { subtitleElements[currentLineIndex].find('.subtitle-progress-bar').css('transform', 'scaleX(0)'); }
        } catch (e) { console.error("Error in updateTeleprompter:", e); }
    }
    
    // --- ОБРАБОТЧИКИ СОБЫТИЙ ---
    trackSelector.on('change', function() { getText($(this).val()); });
    refreshButton.on('click', getTracks);
    $('#settings-button').on('click', function() { $('#settings-modal').show(); });
    $('.modal-close-button, #settings-modal').on('click', function(event) { if (event.target === this) $('#settings-modal').hide(); });
    saveSettingsButton.on('click', saveSettings);
    resetSettingsButton.on('click', resetSettings);

    // Live preview отключён: изменения применяются только по кнопке Сохранить / Сбросить.
    // Если нужно вернуть мгновенное применение, раскомментировать строку ниже.
    // $('.settings-body').find('input, select').on('change input', applySettings);

    // Обработчики для обновления UI (появление/скрытие блоков)
    titleModeSelect.on('change', function() { customTitleWrapper.toggle($(this).val() === 'custom_text'); });
    autoFindTrackCheckbox.on('change', function() { autoFindKeywordsWrapper.toggle($(this).is(':checked')); });
    autoScrollCheckbox.on('change', function() { $('#scroll-speed-wrapper').toggle($(this).is(':checked')); });
    processRolesCheckbox.on('change', function() { roleOptionsWrapper.toggle($(this).is(':checked')); updateScaleWrapperVisibility(); });
    checkerboardEnabledCheckbox.on('change', function() { checkerboardOptionsWrapper.toggle($(this).is(':checked')); });
    highlightCurrentRoleEnabledCheckbox.on('change', function() { highlightRoleColorWrapper.toggle($(this).is(':checked')); });
    highlightClickEnabledCheckbox.on('change', function() { highlightClickOptionsWrapper.toggle($(this).is(':checked')); });

    // Обработчики для обновления подписей у слайдеров
    scrollSpeedSlider.on('input', function() { const i = parseInt($(this).val(), 10); scrollSpeedValue.text(speedSteps[i] + '%'); scrollSpeedCaption.text(getScrollSpeedCaption(speedSteps[i])); });
    uiScaleSlider.on('input', function() { uiScaleValue.text($(this).val() + '%'); });
    lineSpacingSlider.on('input', function() { lineSpacingValue.text($(this).val() + '%'); });
    roleColumnScaleSlider.on('input', function() { roleColumnScaleValue.text($(this).val() + '%'); });
    
    // Обработчики для более сложных действий
    enableColorSwatchesCheckbox.on('change', updateScaleWrapperVisibility);
    roleDisplayStyleSelect.on('change', updateScaleWrapperVisibility);
    // Отложенное применение: перестраивать разметку ролей будем только после сохранения.
    // roleFontColorEnabledCheckbox.on('change', () => { if (subtitleData.length > 0) handleTextResponse(subtitleData); });
    
    transportTimecode.on('click', function() {
        // Always allow manual centering regardless of autoScroll flag
        let targetIndex = currentLineIndex;
        if (targetIndex === -1 && subtitleData.length > 0) {
            // Find first line whose start_time is >= latestTimecode, fallback to last
            targetIndex = subtitleData.findIndex(l => l.start_time >= latestTimecode);
            if (targetIndex === -1) targetIndex = subtitleData.length - 1;
        }
        if (targetIndex !== -1 && subtitleElements[targetIndex]) {
            const targetElement = subtitleElements[targetIndex];
            targetElement[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (settings.highlightClickEnabled) {
                targetElement.addClass('click-highlight');
                const dur = (typeof settings.highlightClickDuration === 'number' && settings.highlightClickDuration > 0 && settings.highlightClickDuration <= 60000)
                    ? settings.highlightClickDuration
                    : defaultSettings.highlightClickDuration;
                setTimeout(() => targetElement.removeClass('click-highlight'), dur);
            }
        }
    });

    $(document).on('click', '.copy-color-btn', function(e) {
        try {
            const inputToCopy = $(this).closest('.input-with-button').find('input[type="text"]');
            if (inputToCopy.length) {
                navigator.clipboard.writeText(inputToCopy.val()).then(() => {
                    const button = $(e.currentTarget), originalTitle = button.attr('title');
                    button.attr('title', 'Скопировано!');
                    setTimeout(() => button.attr('title', originalTitle), 1500);
                });
            }
        } catch(err) { console.error('Не удалось скопировать цвет: ', err); }
    });
    
    // --- ЗАПУСК ---
    // Async init chain: load settings first, then initialize engine.
    loadSettings().then(() => {
        initialize();
    });
    // Dynamic viewport & safe-area handling (Android/iOS address bar, gesture insets)
    (function setupViewportMetrics(){
        const root = document.documentElement;
        function updateViewportMetrics(){
            try {
                const vv = window.visualViewport;
                const visibleHeight = vv ? vv.height : window.innerHeight; // actual visible portion
                // Store full visible height as custom var (consumed by .container height calc)
                root.style.setProperty('--rvw-vh', visibleHeight + 'px');
                // Extra bottom overlay (browser UI). If layout viewport (innerHeight) bigger than visible, diff is overlay.
                let extraBottom = 0;
                let extraTop = 0;
                if (vv) {
                    const diff = window.innerHeight - vv.height;
                    if (diff > 0) extraBottom = Math.min(180, Math.round(diff));
                    // Some mobile browsers (esp. Chrome Android) shift visual viewport downward when URL bar visible.
                    if (vv.offsetTop > 0) {
                        extraTop = Math.min(160, Math.round(vv.offsetTop));
                    }
                }
                root.style.setProperty('--rvw-safe-bottom-extra', extraBottom + 'px');
                root.style.setProperty('--rvw-safe-top-extra', extraTop + 'px');
                // Apply dynamic inline padding merging static safe-area with extra overlay estimate
                document.body.style.paddingBottom = `calc(1rem + env(safe-area-inset-bottom, 0px) + var(--rvw-safe-bottom-extra))`;
                document.body.style.paddingTop = `calc(1rem + env(safe-area-inset-top, 0px) + var(--rvw-safe-top-extra))`;
                // Top padding already includes env(safe-area-inset-top); if needed could add extra top logic here.
            } catch(e) { /* silent */ }
        }
        // Initial + delayed passes to catch address bar hide/show transitions
        updateViewportMetrics();
        [150,300,600].forEach(t => setTimeout(updateViewportMetrics, t));
        window.addEventListener('resize', updateViewportMetrics, { passive: true });
        if (window.visualViewport){
            window.visualViewport.addEventListener('resize', updateViewportMetrics, { passive: true });
            window.visualViewport.addEventListener('scroll', updateViewportMetrics, { passive: true });
        }
    })();
    // Attach resize observer / listener for dynamic transport wrap
    let transportWrapRaf = null;
    function scheduleTransportWrapEvaluation(){
        if(transportWrapRaf) cancelAnimationFrame(transportWrapRaf);
        transportWrapRaf = requestAnimationFrame(evaluateTransportWrap);
    }
    function evaluateTransportWrap(){
        try {
            const panel = $('.panel-controls');
            if(!panel.length) return;
            panel.removeClass('transport-wrapped');
            const panelEl = panel[0];
            const available = panelEl.clientWidth; if(!available) return;

            // Capture original inline styles to restore later
            const originals = [];
            const kids = panel.children();
            kids.each(function(){ originals.push({ el: this, style: this.getAttribute('style') }); });

            // Force minimal intrinsic widths (disable flex-grow shrink influence)
            kids.each(function(){ this.style.flex = '0 0 auto'; this.style.width = 'auto'; });
            // Specifically ensure transport has no extra expansion
            const transport = document.getElementById('transport-status');
            if(transport){ transport.style.flex = '0 0 auto'; transport.style.width = 'auto'; }

            // Measure required width in this minimal state
            const needed = panelEl.scrollWidth;

            // Restore original styles
            originals.forEach(o => { if(o.style===null) o.el.removeAttribute('style'); else o.el.setAttribute('style', o.style); });

            // Add small tolerance (2px) for sub-pixel rounding
            if(needed > available + 2){ panel.addClass('transport-wrapped'); }
        } catch(err){ console.error('Error evaluating transport wrap:', err); }
    }
    window.addEventListener('resize', scheduleTransportWrapEvaluation);
    // Additional observers (ResizeObserver if available) to catch font/icon late layout shifts
    try {
        if(window.ResizeObserver){
            const ro = new ResizeObserver(()=> scheduleTransportWrapEvaluation());
            const pc = document.querySelector('.panel-controls');
            if(pc) ro.observe(pc);
        }
    } catch(_){}
    // Initial eval after short & longer delays (fonts/icons/layout stabilization)
    [150, 300, 600, 900, 1200].forEach(t => setTimeout(scheduleTransportWrapEvaluation, t));
    // Preview wrap reaction while двигаем ползунок масштаба (без сохранения)
    $('#ui-scale').on('input', scheduleTransportWrapEvaluation);
    
});