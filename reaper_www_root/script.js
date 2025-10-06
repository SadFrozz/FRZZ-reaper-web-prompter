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
    progressBarColor: 'rgba(255, 193, 7, 1)',
    // Actors coloring
    actorRoleMappingText: '', // Raw multiline text user enters
    actorColors: {} // { actorName: colorString }
};
let settings = {};
let currentProjectName = '';
let animationFrameId = null;
let wwr_is_enabled = false;
// Removed initialLoad flag: applySettings now, by default, uses in-memory `settings` object (source of truth)
const ORIGINAL_DOCUMENT_TITLE = document.title;
// High-contrast actor color palette (distinct hues for quick recognition)
const ACTOR_BASE_COLORS = [
    'rgba(255, 0, 0, 0.9)',       // Red
    'rgba(0, 140, 255, 0.9)',     // Bright Azure
    'rgba(0, 200, 70, 0.9)',      // Vivid Green
    'rgba(255, 200, 0, 0.9)',     // Strong Yellow
    'rgba(180, 0, 255, 0.9)',     // Vivid Purple
    'rgba(255, 90, 0, 0.9)',      // Deep Orange
    'rgba(0, 230, 220, 0.9)',     // Cyan/Teal
    'rgba(255, 0, 160, 0.9)'      // Magenta
];
// Conservative chunk size for Web Remote extstate path (shorter to avoid transport truncation)
const SETTINGS_CHUNK_SIZE = 250; // was 700
const ROLES_CHUNK_SIZE = 250; // chunk size for roles.json transfer

$(document).ready(function() {
    // --- ПЕРЕМЕННЫЕ ---
    const REASCRIPT_ACTION_ID = "_FRZZ_WEB_NOTES_READER";
    const BASE_LINE_SPACING = 0.5;
    const BASE_ROLE_WIDTH = 9.375;
    const BASE_ROLE_FONT_SIZE = 0.9;
    const mainTitle = $('h1');
    const trackSelector = $('#track-selector');
    const textDisplay = $('#text-display');
    const textDisplayWrapper = $('#text-display-wrapper');
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
    // rAF id for render loop
    // Move transportWrapRaf early to avoid TDZ error when scheduleTransportWrapEvaluation runs during applySettings
    let transportWrapRaf = null;
    // When roles.json is successfully loaded, prefer actor colors over per-line color entirely
    let rolesLoaded = false;
    // Guards to avoid duplicate loads
    let subtitleLoadInFlight = false;
    let subtitleLoadTrackId = null;
    let subtitlesLoadedOnce = false;
    let currentLineIndex = -1;
    let latestTimecode = 0;
    // Enable passive listeners for common scroll-blocking events registered via jQuery (.on)
    (function enableJQueryPassive(){
        try {
            if ($.event && $.event.special) {
                const evts = ['wheel','mousewheel','touchstart','touchmove','scroll'];
                evts.forEach(evt => {
                    const special = $.event.special[evt] = $.event.special[evt] || {};
                    const setupOrig = special.setup;
                    special.setup = function(_, ns, handle){
                        this.addEventListener(evt, handle, { passive: true });
                        return false; // prevent jQuery from adding non-passive fallback
                    };
                    // Also ensure teardown removes our listener
                    const teardownOrig = special.teardown;
                    special.teardown = function(_, ns){
                        // jQuery passes the same handler
                        // We can't access it here reliably; fallback to allow default teardown
                        if (teardownOrig) return teardownOrig.apply(this, arguments);
                        return false;
                    };
                });
                console.debug('[Prompter][perf] jQuery passive listeners enabled for wheel/touch/scroll');
            }
        } catch(e) { console.warn('[Prompter][perf] failed to enable jQuery passive listeners', e); }
    })();

    console.info('[Prompter] document ready init start');

    // Actor coloring runtime caches
    let roleToActor = {}; // role -> actor
    let actorToRoles = {}; // actor -> Set(roles)
    const speedSteps = [1];
    for (let i = 10; i <= 200; i += 10) { speedSteps.push(i); }
    speedSteps.push(500);
    scrollSpeedSlider.attr('min', 0).attr('max', speedSteps.length - 1).attr('step', 1);

    // --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
    // Simple debounce helper
    function debounce(fn, ms) {
        let t = null;
        return function(...args){
            if (t) clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), ms);
        };
    }
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
    // Generic lightener for rgba/hex input returning bg + contrasting text color.
    function lightenGeneric(colorStr, forceLightBg = true) {
        try {
            if (!colorStr) return { bg: '#666', text: '#000' };
            let r,g,b,a = 1;
            if (colorStr.startsWith('#')) {
                let hex = colorStr.replace('#','');
                if (hex.length === 3) hex = hex.split('').map(c=>c+c).join('');
                r = parseInt(hex.substring(0,2),16); g = parseInt(hex.substring(2,4),16); b = parseInt(hex.substring(4,6),16);
            } else if (/^rgba?/i.test(colorStr)) {
                const m = colorStr.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\)/i);
                if (m) { r=+m[1]; g=+m[2]; b=+m[3]; if(m[4]!==undefined) a=+m[4]; }
            } else { return { bg: colorStr, text: '#000' }; }
            const lum = 0.299*r + 0.587*g + 0.114*b;
            if (forceLightBg && lum < 186) {
                // brighten progressively
                let factor = 0.05;
                while ((0.299*r + 0.587*g + 0.114*b) < 186 && factor < 1) {
                    r = Math.min(255, r + (255-r)*factor);
                    g = Math.min(255, g + (255-g)*factor);
                    b = Math.min(255, b + (255-b)*factor);
                    factor += 0.05;
                }
            }
            const outLum = 0.299*r + 0.587*g + 0.114*b;
            const text = outLum > 149 ? '#000000' : '#ffffff';
            if (a !== 1) return { bg: `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`, text };
            return { bg: `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`, text };
        } catch(e){ console.warn('lightenGeneric failed', e); return { bg: colorStr || '#666', text:'#000'}; }
    }
    
    function formatTimecode(totalSeconds) { const hours = Math.floor(totalSeconds / 3600); const minutes = Math.floor((totalSeconds % 3600) / 60); const seconds = Math.floor(totalSeconds % 60); const frames = Math.floor((totalSeconds - Math.floor(totalSeconds)) * settings.frameRate); return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`; }
    
    function getScrollSpeedCaption(speed) { if (speed === 1) return "Я БЛИТЦ! СКОРОСТЬ БЕЗ ГРАНИЦ"; if (speed >= 10 && speed <= 40) return "Ой, что-то меня укачало"; if (speed >= 50 && speed <= 70) return "Да не укачивает меня, просто резко встал"; if (speed >= 80 && speed <= 100) return "У меня хороший вестибу-бу-булярный аппарат"; if (speed >= 110 && speed <= 150) return "Это по вашему скорость?"; if (speed >= 160 && speed <= 200) return "АМЕРИКАНСКИЕ ГОРКИ! Ю-ХУУУ!!!"; if (speed === 500) return "Вы Борис?"; return ""; }

    function kebabToCamel(s) { return s.replace(/-./g, x => x.charAt(1).toUpperCase()); }

    // Emulation mode detection: enabled if ?emumode present and not explicitly 0/false
    function isEmuMode() {
        try {
            const sp = new URLSearchParams(window.location.search);
            if (!sp.has('emumode')) return false;
            const v = sp.get('emumode');
            if (v == null || v === '') return true;
            if (/^(0|false)$/i.test(v)) return false;
            return true;
        } catch (_) { return false; }
    }

    function updateTitle() {
        console.debug('[Prompter][title] updateTitle', { titleMode: settings.titleMode, currentProjectName });
        // Centralized title logic (window + H1). Prevent other functions from mutating document.title directly.
        $('body').removeClass('title-hidden');
        let docTitle = ORIGINAL_DOCUMENT_TITLE;
        switch (settings.titleMode) {
            case 'project_name': {
                const displayName = currentProjectName ? `Текущий проект: ${currentProjectName}` : 'Загрузка имени проекта...';
                mainTitle.text(displayName);
                if (currentProjectName) docTitle = `${currentProjectName} – ${ORIGINAL_DOCUMENT_TITLE}`;
                break;
            }
            case 'custom_text': {
                mainTitle.text(settings.customTitleText || '');
                if (settings.customTitleText) docTitle = `${settings.customTitleText} – ${ORIGINAL_DOCUMENT_TITLE}`;
                break;
            }
            case 'none': {
                $('body').addClass('title-hidden');
                break;
            }
            default: {
                mainTitle.text('Интерактивный текстовый монитор');
                break;
            }
        }
        document.title = docTitle;
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

    function applySettings(options) {
        try {
            console.debug('[Prompter][applySettings] applying', { fromDom: !!(options && options.fromDom) });
            const fromDom = !!(options && options.fromDom);
            let tempSettings;
            if (!fromDom) {
                // Use in-memory settings (authoritative)
                tempSettings = { ...settings };
            } else {
                // Explicit DOM snapshot (used during live preview in future or if needed)
                tempSettings = {};
                Object.keys(defaultSettings).forEach(key => {
                    const id = '#' + key.replace(/([A-Z])/g, "-$1").toLowerCase();
                    const el = $(id);
                    if (el.length) {
                        if (el.is(':checkbox')) { tempSettings[key] = el.is(':checked'); }
                        else if (el.is('input[type="range"]')) { const val = parseInt(el.val(), 10); tempSettings[key] = key === 'scrollSpeed' ? speedSteps[val] : val; }
                        else if (el.is('input[type="number"]')) { tempSettings[key] = parseInt(el.val(), 10); }
                        else {
                            const color = el.spectrum && el.spectrum("get");
                            if (color && color.toRgbString) { tempSettings[key] = color.toRgbString(); }
                            else { tempSettings[key] = el.val(); }
                        }
                    } else { tempSettings[key] = settings[key] || defaultSettings[key]; }
                });
            }
            // Sanitize highlightClickDuration
            if (isNaN(tempSettings.highlightClickDuration) || tempSettings.highlightClickDuration <= 0 || tempSettings.highlightClickDuration > 60000) {
                tempSettings.highlightClickDuration = settings.highlightClickDuration || defaultSettings.highlightClickDuration;
            }
            // Keep authoritative settings in sync with sanitized value (prevents modal showing stale invalid value)
            if (settings.highlightClickDuration !== tempSettings.highlightClickDuration) {
                settings.highlightClickDuration = tempSettings.highlightClickDuration;
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

            // Apply persistent settings (do not mutate global settings here, only visual application)

            $('body').toggleClass('light-theme', tempSettings.theme === 'light');
            // Expose role display style for CSS-based adjustments
            document.body.setAttribute('data-role-style', tempSettings.roleDisplayStyle || '');
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
            // Ensure visual title reflects authoritative settings + currentProjectName
            updateTitle();
            console.debug('[Prompter][applySettings] done');
        } catch (e) { console.error("Error in applySettings:", e); }
    }

    // ++ НОВАЯ ФУНКЦИЯ: Обновляет весь UI в соответствии с объектом settings ++
    function updateUIFromSettings() {
        const s = settings;
        // Helper to ensure a select reflects a value even if option missing (inject fallback)
        function ensureSelectValue($sel, val){
            if(!$sel || !$sel.length) return;
            if($sel.find(`option[value="${val}"]`).length === 0){
                // Inject fallback without localization (raw value) to avoid losing state
                $sel.append(`<option value="${val}">${val}</option>`);
            }
            $sel.val(val);
        }
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

        // Explicit sync for select fields that might have dynamic options or be out of DOM iteration order
        // titleMode
        if (titleModeSelect && titleModeSelect.length) { ensureSelectValue(titleModeSelect, s.titleMode); customTitleWrapper.toggle(s.titleMode === 'custom_text'); }
        // roleDisplayStyle
        if (roleDisplayStyleSelect && roleDisplayStyleSelect.length) { ensureSelectValue(roleDisplayStyleSelect, s.roleDisplayStyle); }
        // checkerboard mode
        const checkerboardModeSelect = $('#checkerboard-mode');
        if (checkerboardModeSelect.length) { ensureSelectValue(checkerboardModeSelect, s.checkerboardMode || defaultSettings.checkerboardMode); }
        // font family select
        const fontFamilySelect = $('#font-family');
        if (fontFamilySelect.length) { ensureSelectValue(fontFamilySelect, s.fontFamily || defaultSettings.fontFamily); }

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

    // (Handled above for reliability)
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
        const t0 = performance.now();
        console.info('[Prompter][loadSettings] start', { emu: isEmuMode() });
        if (isEmuMode()) {
            // In EMU mode we do NOT fetch root settings.json, rely on defaults; reference/settings.json will be applied in loadEmuData
            settings = { ...defaultSettings };
            $('#ui-scale').attr({ min:50, max:300, step:25 });
            initializeColorPickers();
            updateUIFromSettings();
            applySettings();
            console.info('[Prompter][loadSettings] EMU: skip root settings.json; defaults applied');
            const t1 = performance.now();
            console.info('[Prompter][loadSettings] done', { ms: Math.round(t1 - t0) });
            return;
        }
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
        const t1 = performance.now();
        console.info('[Prompter][loadSettings] done', { ms: Math.round(t1 - t0) });
    }

    // Save visual/settings (actors excluded, stored separately)
    function saveSettings() {
        try {
            // Snapshot actor-related data to preserve across visual settings rebuild
            const actorMappingSnapshot = settings.actorRoleMappingText;
            const actorColorsSnapshot = settings.actorColors;
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
            
            // Reinstate actor mapping/colors (they have no controls inside settings modal)
            settingsToSave.actorRoleMappingText = actorMappingSnapshot;
            settingsToSave.actorColors = actorColorsSnapshot;

            // Track previous role mapping size to detect sudden loss (diagnostic)
            const prevRoleMapSize = Object.keys(roleToActor || {}).length;
            settings = settingsToSave;
            localStorage.setItem('teleprompterSettings', JSON.stringify(settings));
            console.debug('[Prompter][saveSettings] Saved settings:', JSON.parse(JSON.stringify(settings)));
            applySettings();

            // Determine whether we really need full subtitle re-render
            const impactingKeys = [
                'processRoles','roleDisplayStyle','enableColorSwatches','checkerboardEnabled','checkerboardMode',
                'checkerboardBg1','checkerboardFont1','checkerboardBg2','checkerboardFont2','roleFontColorEnabled',
                'highlightCurrentRoleEnabled'
            ];
            let needRerender = false;
            for (const k of impactingKeys) {
                if (k in settingsToSave && settingsToSave[k] !== undefined) { needRerender = true; break; }
            }
            if (needRerender && subtitleData.length > 0) {
                handleTextResponse(subtitleData);
                const newRoleMapSize = Object.keys(roleToActor || {}).length;
                if (prevRoleMapSize > 0 && newRoleMapSize === 0) {
                    console.warn('[Prompter][saveSettings] Actor role mapping lost after save; will rely on roles file integration to restore colors.');
                }
            }
            
            const settingsForFile = { ...settings };
            delete settingsForFile.actorRoleMappingText;
            delete settingsForFile.actorColors;
            const settingsString = JSON.stringify(settingsForFile, null, 2);
            // Pretty JSON for human readability in settings.json (indent=2)
            function toBase64Url(str){
                try {
                    const bytes = new TextEncoder().encode(str);
                    let bin = '';
                    for (let b of bytes) bin += String.fromCharCode(b);
                    const b64 = btoa(bin).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
                    return b64;
                } catch(err){ console.error('toBase64Url failed', err); return ''; }
            }
            function chunk(str, size){ const out=[]; for(let i=0;i<str.length;i+=size) out.push(str.substring(i,i+size)); return out; }
            const b64url = '__B64__'+toBase64Url(settingsString);
            const encodedChunks = chunk(b64url, SETTINGS_CHUNK_SIZE);
            // Диагностические метаданные для backend
            wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_total_encoded_len/${b64url.length}`);
            wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_total_decoded_len/${settingsString.length}`);
            wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_chunks/${encodedChunks.length}`);
            encodedChunks.forEach((ch, idx)=> wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_data_${idx}/${ch}`));
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

                const settingsForFile = { ...settings };
                delete settingsForFile.actorRoleMappingText;
                delete settingsForFile.actorColors;
                // Pretty JSON for human readability in settings.json (indent=2)
                const settingsString = JSON.stringify(settingsForFile, null, 2);
                function toBase64Url(str){
                    try {
                        const bytes = new TextEncoder().encode(str);
                        let bin='';
                        for (let b of bytes) bin += String.fromCharCode(b);
                        const b64 = btoa(bin).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
                        return b64;
                    } catch(err){ console.error('toBase64Url reset failed', err); return ''; }
                }
                function chunk(str,size){ const out=[]; for(let i=0;i<str.length;i+=size) out.push(str.substring(i,i+size)); return out; }
                const b64url='__B64__'+toBase64Url(settingsString);
                const encodedChunks = chunk(b64url, SETTINGS_CHUNK_SIZE);
                wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_total_encoded_len/${b64url.length}`);
                wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_total_decoded_len/${settingsString.length}`);
                wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_chunks/${encodedChunks.length}`);
                encodedChunks.forEach((ch, idx)=> wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_data_${idx}/${ch}`));
                wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/SAVE_SETTINGS');
                setTimeout(() => { wwr_req(REASCRIPT_ACTION_ID); }, 150);
            }
        } catch(e) { console.error("Error resetting settings:", e); }
    }

    // =====================
    // ROLES (actors) PERSISTENCE
    // =====================
    // NOTE: Actor/role data теперь хранится в отдельном файле $project-roles.json (пер-проектно).
    // JS отправляет закодированные chunk-и через EXTSTATE (base64url с префиксом __B64__),
    // backend (Lua) собирает, декодирует и пишет файл. Обратная загрузка: backend кодирует весь
    // файл в один ключ roles_json_b64 (дополнительно может менять в будущем на chunk-и — тогда адаптируем).

    function rolesToBase64Url(str){
        try {
            const bytes = new TextEncoder().encode(str);
            let bin='';
            for (let b of bytes) bin += String.fromCharCode(b);
            return btoa(bin).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
        } catch(err){ console.error('[Prompter][roles] rolesToBase64Url failed', err); return ''; }
    }
    function rolesFromBase64Url(b64){
        try {
            if(!b64) return '';
            // remove prefix if present
            if (b64.startsWith('__B64__')) b64 = b64.substring(7);
            let pad = b64.length % 4; if (pad) b64 += '='.repeat(4-pad);
            b64 = b64.replace(/-/g,'+').replace(/_/g,'/');
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
            return new TextDecoder().decode(bytes);
        } catch(err){ console.error('[Prompter][roles] rolesFromBase64Url failed', err); return ''; }
    }
    function chunkString(str,size){ const out=[]; for(let i=0;i<str.length;i+=size) out.push(str.substring(i,i+size)); return out; }

    function saveRoles(){
        try {
            const rolesPayload = {
                actorRoleMappingText: settings.actorRoleMappingText || '',
                actorColors: settings.actorColors || {}
            };
            const jsonPretty = JSON.stringify(rolesPayload, null, 2);
            const b64url = '__B64__' + rolesToBase64Url(jsonPretty);
            const parts = chunkString(b64url, ROLES_CHUNK_SIZE);
            console.debug('[Prompter][roles][saveRoles] encoded', { encoded_len: b64url.length, decoded_len: jsonPretty.length, chunks: parts.length });
            wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/roles_total_encoded_len/${b64url.length}`);
            wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/roles_total_decoded_len/${jsonPretty.length}`);
            wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/roles_chunks/${parts.length}`);
            parts.forEach((ch, idx)=> wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/roles_data_${idx}/${ch}`));
            wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/SAVE_ROLES');
            setTimeout(()=> { wwr_req(REASCRIPT_ACTION_ID); }, 120);
            // query status later
            setTimeout(()=> { wwr_req('GET/EXTSTATE/PROMPTER_WEBUI/roles_status'); }, 400);
        } catch(err){ console.error('[Prompter][roles] saveRoles failed', err); }
    }

    function requestRoles(){
        try {
            console.debug('[Prompter][roles][requestRoles] requesting roles file');
            wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/GET_ROLES');
            setTimeout(()=> { wwr_req(REASCRIPT_ACTION_ID); }, 60);
            // backend после обработки выставит roles_json_b64 -> запросим его чуть позже
            setTimeout(()=> { wwr_req('GET/EXTSTATE/PROMPTER_WEBUI/roles_json_b64'); }, 260);
        } catch(err){ console.error('[Prompter][roles] requestRoles failed', err); }
    }

    function integrateLoadedRoles(jsonText){
        try {
            if(!jsonText) return;
            const parsed = JSON.parse(jsonText);
            if (parsed && typeof parsed === 'object') {
                console.info('[Prompter][roles][integrateLoadedRoles] parsed', { hasMapping: !!parsed.actorRoleMappingText, colors: parsed.actorColors ? Object.keys(parsed.actorColors).length : 0 });
                if (typeof parsed.actorRoleMappingText === 'string') settings.actorRoleMappingText = parsed.actorRoleMappingText;
                if (parsed.actorColors && typeof parsed.actorColors === 'object') settings.actorColors = parsed.actorColors;
                console.debug('[Prompter][roles][integrateLoadedRoles] applied roles data');
                rolesLoaded = true;
                // Rebuild maps and optionally re-render existing subtitles
                buildActorRoleMaps();
                if (subtitleData.length > 0) {
                    // Only re-render if current mapping is empty OR actor colors exist (to refresh)
                    const currentMapSize = Object.keys(roleToActor||{}).length;
                    if (currentMapSize === 0 || Object.keys(settings.actorColors||{}).length > 0) {
                        handleTextResponse(subtitleData);
                    }
                }
            }
        } catch(err){ console.error('[Prompter][roles] integrateLoadedRoles failed', err); }
    }
    
    function initialize() {
        try {
            const t0 = performance.now();
            console.info('[Prompter] initialize (REAPER mode)');
            statusIndicator.text('Подключение к REAPER...');
            wwr_start();
            getTracks();
            getProjectName();
            requestRoles(); // запрос отдельного файла ролей
            wwr_req_recur("TRANSPORT", 20);
            renderLoop();
            evaluateTransportWrap();
            const t1 = performance.now();
            console.info('[Prompter] initialize done', { ms: Math.round(t1 - t0) });
        } catch(e) { console.error("Error in initialize:", e); }
    }

    function getProjectName(retry=0) {
        const MAX_RETRIES = 6;
        const BASE_DELAY = 160; // ms
        console.debug('[Prompter][projectName] request');
        wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/GET_PROJECT_NAME');
        setTimeout(()=> { wwr_req(REASCRIPT_ACTION_ID); }, 40 + retry*15);
        setTimeout(()=> {
            wwr_req('GET/EXTSTATE/PROMPTER_WEBUI/project_name');
            setTimeout(()=> {
                if(!currentProjectName && retry < MAX_RETRIES) {
                    console.debug('[Prompter][projectName] retry', retry+1);
                    getProjectName(retry+1);
                }
            }, 60 + retry*35);
        }, BASE_DELAY + retry*70);
    }

    function getTracks() {
        if (isEmuMode()) {
            // In emu, just refresh mock tracks list
            console.info('[Prompter][EMU] getTracks mock');
            statusIndicator.text('Эмуляция: загрузка списка дорожек...');
            updateTrackSelector([{ id: 0, name: 'Subtitles' }]);
            return;
        }
        const t0 = performance.now();
        console.debug('[Prompter] getTracks real');
        statusIndicator.text('Запрос списка дорожек...');
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/GET_TRACKS`);
        setTimeout(() => { wwr_req(REASCRIPT_ACTION_ID); }, 50);
        setTimeout(() => { 
            wwr_req('GET/EXTSTATE/PROMPTER_WEBUI/response_tracks');
            const t1 = performance.now();
            console.debug('[Prompter] getTracks request issued', { ms: Math.round(t1 - t0) });
        }, 250);
    }

    function getText(trackId) {
        const t0 = performance.now();
        console.info('[Prompter] getText request', { trackId, emu: isEmuMode(), inFlight: subtitleLoadInFlight, alreadyLoaded: subtitlesLoadedOnce });
        // In emu mode, bypass REAPER and load from reference/<subtitle>.json
        if (isEmuMode()) {
            if (subtitlesLoadedOnce) { console.info('[Prompter][EMU] subtitles already loaded, skip getText'); return; }
            try {
                statusIndicator.text(`(EMU) Загрузка субтитров...`);
                textDisplay.html('<p>Загрузка текста (эмуляция)...</p>');
                const sp = new URLSearchParams(window.location.search);
                const subtitleName = sp.get('subtitle') || 'subtitles';
                const url = `reference/${subtitleName}.json?_ts=${Date.now()}`;
                console.debug('[Prompter][EMU] fetch subtitles', { url });
                const f0 = performance.now();
                fetch(url)
                    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
                    .then(data => { const f1 = performance.now(); console.info('[Prompter][EMU] subtitles loaded', { count: Array.isArray(data)? data.length: 'n/a', ms: Math.round(f1 - f0) }); handleTextResponse(data); })
                    .catch(err => {
                        statusIndicator.text('Ошибка загрузки файла субтитров (EMU).');
                        textDisplay.html('<p>Не удалось загрузить reference/*.json. Проверьте локальные файлы.</p>');
                        console.error('[EMU] subtitles load failed', err);
                    })
                    .finally(() => { const t1 = performance.now(); console.debug('[Prompter] getText (EMU) total', { ms: Math.round(t1 - t0) }); });
            } catch (e) {
                console.error('[EMU] getText failed', e);
            }
            return;
        }
        if (subtitleLoadInFlight && subtitleLoadTrackId === trackId) { console.warn('[Prompter] getText skipped: already in-flight for track', trackId); return; }
        subtitleLoadInFlight = true; subtitleLoadTrackId = trackId;
        statusIndicator.text(`Запрос текста с дорожки ${trackId}...`);
        textDisplay.html('<p>Загрузка текста...</p>');
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command_param/${trackId}`);
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/GET_TEXT`);
        setTimeout(() => { wwr_req(REASCRIPT_ACTION_ID); }, 50);
        setTimeout(() => {
            const f0 = performance.now();
            fetch('/subtitles.json?v=' + new Date().getTime())
                .then(response => { if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`); return response.json(); })
                .then(data => { const f1 = performance.now(); console.info('[Prompter] subtitles loaded (real)', { count: Array.isArray(data)? data.length : 'n/a', ms: Math.round(f1 - f0) }); handleTextResponse(data); })
                .catch(error => {
                    statusIndicator.text('Ошибка загрузки файла субтитров.');
                    textDisplay.html('<p>Не удалось загрузить субтитры. Проверьте, что Reaper запущен и скрипты установлены корректно.</p>');
                    console.error(error);
                })
                .finally(() => { subtitleLoadInFlight = false; const t1 = performance.now(); console.debug('[Prompter] getText (real) total', { ms: Math.round(t1 - t0) }); });
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
                else if (parts[2] === 'roles_json_b64') {
                    const payload = parts.slice(3).join('\t');
                    console.debug('[Prompter][roles][onreply] received roles_json_b64 length', payload.length);
                    const decoded = rolesFromBase64Url(payload);
                    integrateLoadedRoles(decoded);
                } else if (parts[2] === 'roles_status') {
                    const status = parts.slice(3).join('\t');
                    console.debug('[Prompter][roles][status]', status);
                }
            } else if (parts[0] === 'TRANSPORT') handleTransportResponse(parts);
        }
    };

    function handleTracksResponse(jsonData) {
        if (!jsonData) return;
        try {
            console.debug('[Prompter] handleTracksResponse');
            const tracks = JSON.parse(jsonData);
            trackSelector.empty();
            tracks.forEach(track => { trackSelector.append(`<option value="${track.id}">${track.id + 1}: ${track.name}</option>`); });
            statusIndicator.text('Список дорожек загружен.');
            autoFindSubtitleTrack();
            // Removed auto-retry to avoid double loading
            console.debug('[Prompter] tracks parsed', { count: Array.isArray(tracks) ? tracks.length : 0 });
        } catch (e) {
            statusIndicator.text('Ошибка обработки списка дорожек.');
            console.error(e);
        }
    }

    let nextUpdateAt = 0;
    function renderLoop() {
        try {
            const now = performance.now();
            if (now >= nextUpdateAt) {
                nextUpdateAt = now + 50; // ~20 FPS
                updateTeleprompter(latestTimecode);
            }
            animationFrameId = requestAnimationFrame(renderLoop);
        } catch(e) { console.error("Error in renderLoop:", e); }
    }

    // ===== EMULATION SUPPORT (isolated, no REAPER calls) =====
    function updateTrackSelector(tracks) {
        try {
            trackSelector.empty();
            (tracks || []).forEach(t => {
                trackSelector.append(`<option value="${t.id}">${t.id + 1}: ${t.name}</option>`);
            });
            statusIndicator.text('Список дорожек (эмуляция) загружен.');
            console.debug('[Prompter][EMU] updateTrackSelector', { count: (tracks||[]).length });
        } catch (e) { console.error('[EMU] updateTrackSelector failed', e); }
    }
    function getStartSecondsFromQuery() {
        try {
            const sp = new URLSearchParams(window.location.search);
            const mm = parseFloat(sp.get('time'));
            if (Number.isFinite(mm) && mm >= 0) return mm * 60;
        } catch (_) {}
        return 0;
    }
    function getStartStatusFromQuery() {
        try {
            const sp = new URLSearchParams(window.location.search);
            const st = parseInt(sp.get('status'), 10);
            if (Number.isFinite(st)) return st; // 1 play, 0 stop, 5 rec
        } catch (_) {}
        return 1;
    }
    let transportEmuTimer = null;
    function startTransportEmu(intervalMs = 50) {
        try {
            if (transportEmuTimer) { clearInterval(transportEmuTimer); transportEmuTimer = null; }
            let playState = getStartStatusFromQuery();
            let current = getStartSecondsFromQuery();
            latestTimecode = current;
            let lastWall = performance.now();
            console.info('[EMU][transport] start', { intervalMs, startAtSec: current, status: playState });
            transportEmuTimer = setInterval(() => {
                const now = performance.now();
                const dt = (now - lastWall) / 1000;
                lastWall = now;
                if (playState === 1) current += dt;
                handleTransportResponse(['TRANSPORT', String(playState), String(current)]);
            }, intervalMs);
        } catch (err) { console.error('[EMU][transport] failed to start', err); }
    }
    async function loadEmuData() {
        try {
            // Settings first (optional)
            const T0 = performance.now();
            // 1) Roles first
            try {
                const r0 = performance.now();
                const rr = await fetch('reference/roles.json?_ts=' + Date.now());
                if (rr.ok) {
                    const rolesObj = await rr.json();
                    integrateLoadedRoles(JSON.stringify(rolesObj));
                    regenerateActorColorListUI();
                    const r1 = performance.now();
                    console.info('[EMU] roles.json loaded from reference', { ms: Math.round(r1 - r0) });
                } else {
                    const r1 = performance.now();
                    console.debug('[EMU] roles.json not found', { status: rr.status, ms: Math.round(r1 - r0) });
                }
            } catch (e) { console.debug('[EMU] roles.json not loaded', e); }
            // 2) Then settings (visual only)
            try {
                const s0 = performance.now();
                const rs = await fetch('reference/settings.json?_ts=' + Date.now());
                if (rs.ok) {
                    const fileSettings = await rs.json();
                    settings = { ...defaultSettings, ...fileSettings };
                    updateUIFromSettings();
                    applySettings();
                    const s1 = performance.now();
                    console.info('[EMU] settings.json loaded from reference', { ms: Math.round(s1 - s0) });
                } else {
                    const s1 = performance.now();
                    console.debug('[EMU] settings.json not found', { status: rs.status, ms: Math.round(s1 - s0) });
                }
            } catch (e) { console.debug('[EMU] settings.json not loaded', e); }
            // Tracks + project (mock)
            const tracks = [{ id: 0, name: 'Subtitles' }];
            updateTrackSelector(tracks);
            currentProjectName = currentProjectName || 'EMU Project';
            updateTitle();
            // Subtitles
            const sp = new URLSearchParams(window.location.search);
            const subtitleName = sp.get('subtitle') || 'subtitles';
            const url = `reference/${subtitleName}.json?_ts=${Date.now()}`;
            const f0 = performance.now();
            console.info('[EMU] loading subtitles', { url });
            statusIndicator.text('(EMU) Загрузка субтитров...');
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            await handleTextResponse(data);
            statusIndicator.text(`(EMU) Текст получен, всего ${Array.isArray(data) ? data.length : 0} реплик`);
            const f1 = performance.now();
            const T1 = performance.now();
            console.info('[EMU] subtitles loaded + rendered', { fetchAndRenderMs: Math.round(f1 - f0), totalMs: Math.round(T1 - T0), count: Array.isArray(data) ? data.length : 0 });
        } catch (err) {
            console.error('[EMU] loadEmuData failed', err);
            statusIndicator.text('Ошибка эмуляции данных');
        }
    }
    
    function autoFindSubtitleTrack() {
        const t0 = performance.now();
        console.debug('[Prompter] autoFindSubtitleTrack start');
        if (!settings.autoFindTrack || $('#track-selector option').length === 0) {
            if ($('#track-selector option').length > 0) { $('#track-selector option:first').prop('selected', true); getText($('#track-selector').val()); }
            const t1 = performance.now();
            console.debug('[Prompter] autoFindSubtitleTrack done', { found: $('#track-selector option').length > 0, ms: Math.round(t1 - t0) });
            return;
        }
        const rawKw = (settings.autoFindKeywords || '').trim();
        const keywords = rawKw.length ? rawKw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];
        if (keywords.length === 0) {
            // Нет ключевых слов — просто берём первый трек
            $('#track-selector option:first').prop('selected', true); getText($('#track-selector').val());
            const t1 = performance.now();
            console.debug('[Prompter] autoFindSubtitleTrack done', { found: true, ms: Math.round(t1 - t0) });
            return;
        }
        let found = false;
        $('#track-selector option').each(function() {
            const trackName = $(this).text().toLowerCase();
            const match = keywords.some(keyword => new RegExp(keyword.includes('*') ? keyword.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') : `\\b${keyword}\\b`).test(trackName));
            if (match) { $(this).prop('selected', true); getText($(this).val()); found = true; return false; }
        });
        if (!found) { $('#track-selector option:first').prop('selected', true); getText($('#track-selector').val()); }
        const t1 = performance.now();
        console.debug('[Prompter] autoFindSubtitleTrack done', { found, ms: Math.round(t1 - t0) });
    }

    function handleTextResponse(subtitles) {
        try {
            const t0 = performance.now();
            console.info('[Prompter] handleTextResponse start', { type: Array.isArray(subtitles)? 'array':'invalid', count: Array.isArray(subtitles)? subtitles.length : 0 });
            if (!Array.isArray(subtitles)) { throw new Error('Полученные данные не являются массивом субтитров.'); }
            subtitleData = subtitles;
            subtitlesLoadedOnce = true;
            subtitleElements = [];
            textDisplay.empty();
            if (subtitleData.length === 0) return;
            // After loading subtitles we may need to refresh stats button visibility
            scheduleStatsButtonEvaluation();
            
            let lineStyles = $('#dynamic-line-styles');
            if (lineStyles.length === 0) { lineStyles = $('<style id="dynamic-line-styles"></style>').appendTo('head'); }
            
            let lastRoleForCheckerboard = null, lastColorForCheckerboard = null, colorIndex = 0, dynamicRoleStyles = "", lastRoleForDeduplication = null;

            // Build role->actor map once per render based on settings
            const tMap0 = performance.now();
            buildActorRoleMaps();
            const tMap1 = performance.now();

            // Build all rows in one pass
            const tBuild0 = performance.now();
            subtitleData.forEach((line, index) => {
                let role = '', text = line.text;
                const roleMatch = text.match(/^\[(.*?)\]\s*/);
                if (roleMatch && settings.processRoles) {
                    role = roleMatch[1];
                    if (settings.roleDisplayStyle !== 'inline') { text = text.substring(roleMatch[0].length); }
                }
                const lineHtml = `<div class="subtitle-container" data-index="${index}"><div class="role-area"><div class="subtitle-color-swatch"></div><div class="subtitle-role">${role}</div><div class="subtitle-separator"></div></div><div class="subtitle-time">${formatTimecode(line.start_time)}</div><div class="subtitle-content"><div class="subtitle-text"></div><div class="subtitle-progress-container"><div class="subtitle-progress-bar"></div></div></div></div>`;
                const lineElement = $(lineHtml);
                const roleElement = lineElement.find('.subtitle-role');
                const swatchElement = lineElement.find('.subtitle-color-swatch');
                lineElement.find('.subtitle-text').text(text);

                if (settings.deduplicateRoles && role) {
                    const prev = index>0 ? subtitleData[index-1] : null;
                    if (prev) {
                        const m = prev.text.match(/^\[(.*?)\]\s*/);
                        const prevRole = m ? m[1] : null;
                        if (prevRole && prevRole === role) roleElement.html('&nbsp;');
                    }
                }

                if (settings.checkerboardEnabled) {
                    if (settings.checkerboardMode === 'unconditional') { lineElement.addClass(`checkerboard-color-${(index % 2) + 1}`); }
                    else if (settings.checkerboardMode === 'by_role') { const currentRole = role || 'no_role'; if (currentRole !== lastRoleForCheckerboard) { colorIndex = 1 - colorIndex; lastRoleForCheckerboard = currentRole; } lineElement.addClass(`checkerboard-color-${colorIndex + 1}`); }
                    else if (settings.checkerboardMode === 'by_color') { const currentColor = line.color || 'no_color'; if (currentColor !== lastColorForCheckerboard) { colorIndex = 1 - colorIndex; lastColorForCheckerboard = currentColor; } lineElement.addClass(`checkerboard-color-${colorIndex + 1}`); }
                }

                // If roles were loaded, we ignore item line color completely as per requirement
                const itemColor = rolesLoaded ? null : (line.color || null);
                const actor = role && roleToActor[role] ? roleToActor[role] : null;
                const actorColor = actor && settings.actorColors ? settings.actorColors[actor] : null;
                const finalRoleColor = actorColor || itemColor || null;
                const isColumn = settings.roleDisplayStyle === 'column';
                const isColumnWithSwatch = settings.roleDisplayStyle === 'column_with_swatch';
                const showRoleInColumn = settings.processRoles && role && (isColumn || isColumnWithSwatch);
                // swatch visibility rules
                let showSwatch = false;
                if (settings.enableColorSwatches && !!finalRoleColor) {
                    if (isColumn) showSwatch = true; else if (!isColumnWithSwatch && !showRoleInColumn) showSwatch = true;
                }
                roleElement.css('visibility', showRoleInColumn ? 'visible' : 'hidden');
                swatchElement.css('visibility', showSwatch ? 'visible' : 'hidden');
                if (showSwatch && !showRoleInColumn) lineElement.addClass('has-inline-swatch');

                if (finalRoleColor) {
                    let effectiveBg = finalRoleColor; let effectiveText;
                    if (settings.roleFontColorEnabled) { const adj = lightenGeneric(finalRoleColor, true); effectiveBg = adj.bg; effectiveText = '#000000'; }
                    else { effectiveText = isColorLight(effectiveBg) ? '#000000' : '#ffffff'; }
                    if (showRoleInColumn && settings.roleDisplayStyle === 'column_with_swatch' && settings.enableColorSwatches) {
                        roleElement.addClass('role-colored-bg').css('visibility', 'visible');
                        dynamicRoleStyles += `.subtitle-container[data-index="${index}"] .role-colored-bg { background-color: ${effectiveBg}; color: ${effectiveText}; }`;
                    } else if (showSwatch) {
                        swatchElement.css('background-color', effectiveBg);
                    }
                    if (actor) roleElement.attr('title', actor);
                }
                lineElement.find('.role-area').toggleClass('role-area-is-empty', !(showRoleInColumn || showSwatch));
                textDisplay.append(lineElement);
                subtitleElements.push(lineElement);
            });
            const tBuild1 = performance.now();
            
            lineStyles.text(dynamicRoleStyles);
            const tStyles = performance.now();
            statusIndicator.text(`Текст получен, всего ${subtitleData.length} реплик`);
            const tApply0 = performance.now();
            applySettings();
            const tApply1 = performance.now();
            const t1 = performance.now();
            console.info('[Prompter] handleTextResponse done', {
                msTotal: Math.round(t1 - t0),
                msMap: Math.round(tMap1 - tMap0),
                msBuildAppend: Math.round(tBuild1 - tBuild0),
                msStyles: Math.round(tStyles - tBuild1),
                msApply: Math.round(tApply1 - tApply0),
                total: subtitleData.length
            });
            // Снимаем обработчики виртуализации если были
            try {
                if (window.__vwinScrollHandler) { textDisplayWrapper[0].removeEventListener('scroll', window.__vwinScrollHandler); window.__vwinScrollHandler = null; }
                if (window.__vwinResizeHandler) { window.removeEventListener('resize', window.__vwinResizeHandler); window.__vwinResizeHandler = null; }
                if (window.__vwinWheelHandler) { textDisplayWrapper[0].removeEventListener('wheel', window.__vwinWheelHandler); window.__vwinWheelHandler = null; }
                if (window.__vwinTouchHandler) { textDisplayWrapper[0].removeEventListener('touchmove', window.__vwinTouchHandler); window.__vwinTouchHandler = null; }
            } catch(_){}
        } catch (e) { console.error("Error in handleTextResponse:", e); }
    }

    // removed unused createSubtitleElement (legacy from virtualization)

    // === Actor Coloring Utilities ===
    function parseActorRoleMapping(rawText) {
        // Each line: ACTOR (space|comma|colon) ROLE1, ROLE2, ROLE3
        const map = {}; // actor -> Set(roles)
        const lines = (rawText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            const m = line.match(/^([^:,]+?)\s*(?:[:\-,])\s*(.+)$/);
            if (m) {
                const actor = m[1].trim();
                const rolesPart = m[2].trim();
                const roles = rolesPart.split(/[,;]+|\s+/).map(r => r.trim()).filter(Boolean);
                if (actor && roles.length) {
                    if (!map[actor]) map[actor] = new Set();
                    roles.forEach(r => map[actor].add(r));
                }
            }
        }
        const result = {};
        Object.keys(map).forEach(a => { result[a] = Array.from(map[a]); });
        return result;
    }

    function buildActorRoleMaps() {
        roleToActor = {};
        actorToRoles = {};
        const parsed = parseActorRoleMapping(settings.actorRoleMappingText || '');
        Object.keys(parsed).forEach(actor => {
            const roles = parsed[actor];
            actorToRoles[actor] = new Set(roles);
            roles.forEach(role => {
                if (!roleToActor[role]) roleToActor[role] = actor; // first mapping wins
            });
        });
        assignDefaultActorColors();
    }

    function assignDefaultActorColors(){
        if(!settings.actorColors) settings.actorColors = {};
        const existing = settings.actorColors;
        let idx = 0;
        Object.keys(actorToRoles).forEach(actor => {
            if(!existing[actor]){
                existing[actor] = ACTOR_BASE_COLORS[idx % ACTOR_BASE_COLORS.length];
                idx++;
            }
        });
    }

    function regenerateActorColorListUI() {
        const container = $('#actor-color-list');
        if (!container.length) return;
        container.empty();
        buildActorRoleMaps();
        const actors = Object.keys(actorToRoles).sort((a,b)=> a.localeCompare(b,'ru'));
        actors.forEach(actor => {
            const roles = Array.from(actorToRoles[actor]).join(', ');
            const colorVal = (settings.actorColors && settings.actorColors[actor]) || 'rgba(60,60,60,0.6)';
            const row = $(`
                <div class="actor-color-item" data-actor="${actor}">
                    <div class="actor-color-item-label">${actor}</div>
                    <div class="actor-color-item-roles">${roles}</div>
                    <input type="text" class="actor-color-input" value="${colorVal}" />
                    <button class="delete-actor-color" title="Удалить актёра">✕</button>
                </div>`);
            container.append(row);
        });
        // Initialize Spectrum on newly added inputs
        container.find('.actor-color-input').each(function(){
            $(this).spectrum({
                type: "component", showPaletteOnly: true, togglePaletteOnly: true, hideAfterPaletteSelect: true,
                showInput: true, showInitial: true, allowEmpty: false, showAlpha: true, preferredFormat: "rgba",
                change: function(color){ if(color){ $(this).val(color.toRgbString()); } }
            });
        });
        updateUnassignedRolesUI();
        scheduleStatsButtonEvaluation();
    }

    // Compute roles present in subtitleData but not mapped to any actor
    function computeUnassignedRoles() {
        const mappedRoles = new Set(Object.keys(roleToActor));
        const allRoles = new Set();
        if (Array.isArray(subtitleData)) {
            subtitleData.forEach(line => {
                if (!line || !line.text) return;
                const m = line.text.match(/^\[(.*?)\]\s*/);
                if (m && m[1]) { allRoles.add(m[1]); }
            });
        }
        const unassigned = [];
        allRoles.forEach(r => { if (!mappedRoles.has(r)) unassigned.push(r); });
        unassigned.sort((a,b)=> a.localeCompare(b,'ru'));
        return unassigned;
    }

    function updateUnassignedRolesUI() {
        const list = $('#unassigned-roles-list');
        if (!list.length) return;
        const roles = computeUnassignedRoles();
        list.empty();
        if (roles.length === 0) {
            list.append('<span class="unassigned-role-chip" style="opacity:0.6">Все роли назначены</span>');
            return;
        }
        roles.forEach(r => {
            list.append(`<span class="unassigned-role-chip" data-role="${r}">${r}</span>`);
        });
    }

    function saveActorsFromUI() {
        const rawMapping = $('#actor-role-mapping-text').val();
        settings.actorRoleMappingText = rawMapping;
        // Collect colors that пользователь явно видел/менял в списке
        const newColors = {};
        $('#actor-color-list .actor-color-item').each(function(){
            const actor = $(this).data('actor');
            const input = $(this).find('.actor-color-input');
            let val = input.val();
            if (input.spectrum && input.spectrum("get")) {
                const c = input.spectrum("get");
                if (c && c.toRgbString) val = c.toRgbString();
            }
            if (actor) newColors[actor] = val;
        });
        // Автогенерация цветов для новых актёров, добавленных в текст мэппинга, но ещё не отображённых в списке (чтобы файл roles не был пустым по цветам).
        try {
            const parsed = parseActorRoleMapping(rawMapping || '');
            const allActors = Object.keys(parsed);
            // Используем уже занятые цвета для смещения индекса
            let idx = 0;
            const usedActors = Object.keys(newColors);
            // Берём стартовый индекс = числу уже известных актёров (стабильный порядок добавления)
            idx = usedActors.length;
            allActors.forEach(actor => {
                if (!newColors[actor]) {
                    const color = ACTOR_BASE_COLORS[idx % ACTOR_BASE_COLORS.length];
                    newColors[actor] = color;
                    idx++;
                }
            });
        } catch(err){ console.error('[Prompter][roles] auto-color generation failed', err); }
        settings.actorColors = newColors;
        saveRoles();
        // Перепарсим и перерисуем текст если уже загружен
        if (subtitleData.length > 0) handleTextResponse(subtitleData);
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
            if (playState !== (window.__lastPlayStateLogged ?? null)) {
                console.debug('[Prompter][transport] state', playState);
                window.__lastPlayStateLogged = playState;
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
                    const newContainer = subtitleElements[newCurrentLineIndex], $wrapper = $('#text-display-wrapper'), wrapperHeight = $wrapper.height();
                    const lineTop = newContainer.position().top + $wrapper.scrollTop(), scrollDuration = 400 / (settings.scrollSpeed / 100);
                    const linePositionInViewport = newContainer.position().top, topThreshold = wrapperHeight * 0.1, bottomThreshold = wrapperHeight * 0.9 - newContainer.outerHeight(true);
                    if (linePositionInViewport < topThreshold || linePositionInViewport > bottomThreshold) $wrapper.stop().animate({ scrollTop: lineTop - (wrapperHeight * 0.2) }, scrollDuration);
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
    $('#settings-button').on('click', function() {
        // Refresh form fields from authoritative settings before showing
        updateUIFromSettings();
        $('#settings-modal').show();
    });
    $('.modal-close-button, #settings-modal').on('click', function(event) { if (event.target === this) $('#settings-modal').hide(); });
    saveSettingsButton.on('click', saveSettings);
    resetSettingsButton.on('click', resetSettings);
    $('#actors-button').on('click', function(){
        // Заполнить textarea текущим mapping
        $('#actor-role-mapping-text').val(settings.actorRoleMappingText || '');
        regenerateActorColorListUI();
        $('#actors-modal').show();
    });
    $('#stats-button').on('click', function(){ buildAndShowStats(); });
    // Realtime mapping update while typing
    $('#actor-role-mapping-text').on('input', function(){
        settings.actorRoleMappingText = $(this).val();
        // Rebuild only lightweight preview (do not save yet)
        regenerateActorColorListUI();
        // Update rendered subtitles highlight if roles affect coloring
        if (subtitleData.length > 0) handleTextResponse(subtitleData);
    });

    // ================= STATISTICS =================
    function computeStats() {
        const roleCounts = new Map();
        const actorCounts = new Map();
        const colorCounts = new Map();
        let totalRoleLines = 0;
        let totalActorLines = 0;
        let totalColorLines = 0; // only used when no actors mapped
        const haveActorMapping = Object.keys(roleToActor).length > 0; // any role->actor relation
        if (Array.isArray(subtitleData)) {
            for (const line of subtitleData) {
                if (!line || !line.text) continue;
                const m = line.text.match(/^\[(.*?)\]\s*/);
                if (m && m[1]) {
                    const role = m[1];
                    totalRoleLines++;
                    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
                    const actor = roleToActor[role];
                    if (actor) {
                        totalActorLines++;
                        actorCounts.set(actor, (actorCounts.get(actor) || 0) + 1);
                    } else if (!haveActorMapping && line.color) {
                        // Only collect color stats if вообще нет сопоставлений актёров
                        totalColorLines++;
                        colorCounts.set(line.color, (colorCounts.get(line.color) || 0) + 1);
                    }
                }
            }
        }
        return { roleCounts, actorCounts, colorCounts, totalRoleLines, totalActorLines, totalColorLines, haveActorMapping };
    }

    function buildAndShowStats(){
        const { roleCounts, actorCounts, colorCounts, totalRoleLines, totalActorLines, totalColorLines, haveActorMapping } = computeStats();
        const statsModal = $('#stats-modal');
        const rolesSection = $('#stats-roles-section');
        const actorsSection = $('#stats-actors-section');
        const colorsSection = $('#stats-colors-section');
        const emptyMsg = $('#stats-empty');
        let any=false;
        // Roles table
        if (totalRoleLines > 0 && roleCounts.size > 0) {
            const tbody = $('#stats-roles-table tbody').empty();
            const arr = Array.from(roleCounts.entries()).sort((a,b)=> b[1]-a[1]);
            arr.forEach(([role,count])=>{
                const pct = ((count/totalRoleLines)*100).toFixed(1);
                tbody.append(`<tr><td>${role}</td><td>${count}</td><td>${pct}</td></tr>`);
            });
            $('#stats-roles-total').text(totalRoleLines);
            rolesSection.show(); any=true;
        } else { rolesSection.hide(); }
        // Actors table (primary if any actor mapping present and counts > 0)
        if (totalActorLines > 0 && actorCounts.size > 0) {
            const tbody = $('#stats-actors-table tbody').empty();
            const arr = Array.from(actorCounts.entries()).sort((a,b)=> b[1]-a[1]);
            arr.forEach(([actor,count])=>{
                const pct = ((count/totalActorLines)*100).toFixed(1);
                tbody.append(`<tr><td>${actor}</td><td>${count}</td><td>${pct}</td></tr>`);
            });
            $('#stats-actors-total').text(totalActorLines);
            actorsSection.show(); any=true;
        } else { actorsSection.hide(); }
        // Colors table: показываем ТОЛЬКО если НЕТ назначенных актёров вообще, но есть цвета в репликах
        if (!haveActorMapping) {
            const colorTotal = totalColorLines;
            if (colorTotal > 0 && colorCounts.size > 0) {
                const tbody = $('#stats-colors-table tbody').empty();
                const arr = Array.from(colorCounts.entries()).sort((a,b)=> b[1]-a[1]);
                arr.forEach(([col,count])=>{
                    const pct = ((count/colorTotal)*100).toFixed(1);
                    tbody.append(`<tr><td><span style="display:inline-block;width:1.2rem;height:1.2rem;vertical-align:middle;border-radius:0.2rem;background:${col};margin-right:0.4rem;border:1px solid #555"></span>${col}</td><td>${count}</td><td>${pct}</td></tr>`);
                });
                $('#stats-colors-total').text(colorTotal);
                colorsSection.show(); any=true;
            } else { colorsSection.hide(); }
        } else { colorsSection.hide(); }

        emptyMsg.toggle(!any);
        statsModal.show();
    }

    function evaluateStatsButtonVisibility(){
        const { roleCounts, actorCounts, haveActorMapping, colorCounts, totalColorLines } = computeStats();
        const btn = $('#stats-button');
        const roleHas = roleCounts && roleCounts.size>0;
        const actorHas = actorCounts && actorCounts.size>0;
        const colorHas = !haveActorMapping && colorCounts.size>0 && totalColorLines>0; // only if no actor mapping
        if (roleHas || actorHas || colorHas) btn.show(); else btn.hide();
    }
    let statsEvalRaf=null; function scheduleStatsButtonEvaluation(){ if(statsEvalRaf) cancelAnimationFrame(statsEvalRaf); statsEvalRaf=requestAnimationFrame(evaluateStatsButtonVisibility); }
    $(document).on('click', '.modal-close-button', function(){
        const target = $(this).data('close');
        if(target) { $('#'+target).hide(); }
    });
    $('#actors-modal').on('click', function(e){ if(e.target === this) $(this).hide(); });
    // Закрытие статистики по клику вне окна
    $('#stats-modal').on('click', function(e){ if(e.target === this) $(this).hide(); });
    // Глобальное закрытие stats по ESC
    $(document).on('keydown.rwv_stats_escape', function(e){
        if(e.key === 'Escape') { const m = $('#stats-modal:visible'); if(m.length) m.hide(); }
    });
    $(document).on('click', '.delete-actor-color', function(){
        $(this).closest('.actor-color-item').remove();
    });
    $('#save-actors-button').on('click', function(){ saveActorsFromUI(); $('#actors-modal').hide(); });

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
        console.debug('[Prompter] timecode click center');
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
    // Async init chain: load settings first, then initialize engine or emu
    loadSettings().then(async () => {
        applySettings();
        if (isEmuMode()) {
            await loadEmuData();
            // Start emu transport + render loop
            startTransportEmu(50);
            renderLoop();
            evaluateTransportWrap();
        } else {
            initialize();
        }
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
    window.addEventListener('resize', scheduleTransportWrapEvaluation, { passive: true });
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

    // Initialize collapsible fieldsets (settings modal)
    (function initCollapsibleFieldsets(){
        const $modal = $('#settings-modal');
        if(!$modal.length) return;
        $modal.find('fieldset.fieldset-collapsible > legend').each(function(){
            const $legend = $(this);
            const $fs = $legend.parent();
            const expanded = !$fs.hasClass('collapsed');
            $legend.attr({ role: 'button', tabindex: '0', 'aria-expanded': expanded ? 'true':'false' });
            function toggle(){
                $fs.toggleClass('collapsed').toggleClass('expanded');
                const isExp = !$fs.hasClass('collapsed');
                $legend.attr('aria-expanded', isExp ? 'true':'false');
            }
            $legend.on('click', function(e){ e.preventDefault(); toggle(); });
            $legend.on('keydown', function(e){ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); toggle(); }});
        });
    })();
    console.info('[Prompter] document ready init done');
});