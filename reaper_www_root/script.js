const SETTINGS_SCHEMA_VERSION = 7;
const DATA_MODEL_VERSION = 2;
const DEFAULT_PROJECT_FPS = 24;
const MAX_JUMP_PRE_ROLL_SECONDS = 10;
const MIN_AUTO_SCROLL_WINDOW_GAP = 5;
const MAX_AUTO_SCROLL_EASING_PER_PIXEL = 10;
const MAX_AUTO_SCROLL_ANIMATION_MS = 3000;
const SPEED_BASELINE_FACTOR = 2;
const MIN_SPEED_MULTIPLIER = 0.1;
const MAX_SPEED_MULTIPLIER = 20;
const PAGE_DYNAMIC_BASE_DURATION_MS = 540;
const PAGE_DYNAMIC_DISTANCE_COEFFICIENT = 0.9;
const DEFAULT_PAGE_STATIC_DURATION_MS = 360;
const DEFAULT_LINE_STATIC_DURATION_MS = 330;
const MIN_TIMELINE_SCROLL_MS = 120;
const TIMELINE_ACTIVE_COMPLETION_RATIO = 0.85;
const TIMELINE_LOOKAHEAD_COMPLETION_RATIO = 0.65;
const SUBTREADER_INERTIA_WINDOW_SECONDS = 0.7; // SubtReader UI.transition_sec window
const SUBTREADER_INERTIA_MIN_DISTANCE_PX = 0.75; // ignore tiny scroll deltas to prevent jitter
const supportsInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;

function clampNumber(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return min;
    }
    if (numeric < min) return min;
    if (numeric > max) return max;
    return numeric;
}

function normalizeTimecodeDisplayFormatValue(value, fallback = 'auto') {
    const fallbackNormalized = typeof fallback === 'string' ? fallback.trim().toLowerCase() : 'auto';
    const fallbackValue = fallbackNormalized === 'milliseconds' ? 'milliseconds'
        : fallbackNormalized === 'frames' ? 'frames'
        : 'auto';
    if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (normalized === 'milliseconds' || normalized === 'millisecond' || normalized === 'millis' || normalized === 'ms') {
            return 'milliseconds';
        }
        if (normalized === 'frames' || normalized === 'frame' || normalized === 'ff') {
            return 'frames';
        }
        if (normalized === 'auto') {
            return 'auto';
        }
    }
    return fallbackValue;
}

function sanitizeJumpPreRollSeconds(value, fallback = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        return Math.max(0, Number(fallback) || 0);
    }
    const clamped = Math.min(MAX_JUMP_PRE_ROLL_SECONDS, numeric);
    // Normalize to 3 decimal places to avoid FP noise in settings persistence.
    return Math.round(clamped * 1000) / 1000;
}

function sanitizeAutoScrollMode(value, fallback = 'page') {
    if (typeof value === 'string') {
          const normalized = value.trim().toLowerCase();
          if (normalized === 'line') return 'line';
          if (normalized === 'page') return 'page';
    }
    return typeof fallback === 'string' ? fallback : 'page';
}

function sanitizeProgressBarMode(value, fallback = 'subtitle') {
    const fallbackNormalized = typeof fallback === 'string' && fallback.toLowerCase() === 'timecode' ? 'timecode' : 'subtitle';
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'timecode' || normalized === 'transport' || normalized === 'timcode') {
            return 'timecode';
        }
        if (normalized === 'subtitle' || normalized === 'line' || normalized === 'replica') {
            return 'subtitle';
        }
    }
    return fallbackNormalized;
}

function sanitizeAutoScrollPercent(value, fallback, min = 0, max = 100) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return clampNumber(fallback, min, max);
    }
    return clampNumber(numeric, min, max);
}

function sanitizeAutoScrollLineEasingBaseMs(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
          return clampNumber(fallback, 50, MAX_AUTO_SCROLL_ANIMATION_MS);
    }
    return clampNumber(Math.round(numeric), 50, MAX_AUTO_SCROLL_ANIMATION_MS);
}

function sanitizeAutoScrollLineEasingPerPixel(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        return clampNumber(fallback, 0, MAX_AUTO_SCROLL_EASING_PER_PIXEL);
    }
    const rounded = Math.round(numeric * 100) / 100;
    return clampNumber(rounded, 0, MAX_AUTO_SCROLL_EASING_PER_PIXEL);
}

function sanitizeAutoScrollLineEasingMaxMs(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return clampNumber(fallback, 100, MAX_AUTO_SCROLL_ANIMATION_MS);
    }
    return clampNumber(Math.round(numeric), 100, MAX_AUTO_SCROLL_ANIMATION_MS);
}

const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = t => (t < 0.5)
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;

function isPlayingState(playState) {
    const state = Number(playState) | 0;
    return (state & 1) === 1;
}

function isRecordingState(playState) {
    const state = Number(playState) | 0;
    return (state & 4) === 4;
}

// --- ВСПОМОГАТЕЛЬНЫЕ МОДУЛИ ---
const PrompterTime = (() => {
    const EPSILON = 1e-6;

    function sanitizeFps(fps) {
        const numeric = Number(fps);
        if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_PROJECT_FPS;
        return numeric;
    }

    function msToFrames(ms, fps) {
        const safeFps = sanitizeFps(fps);
        return Math.floor((Number(ms) * safeFps) / 1000 + EPSILON);
    }

    function framesToMs(frames, fps) {
        const safeFps = sanitizeFps(fps);
        return Math.round((Number(frames) * 1000) / safeFps);
    }

    function pad2(num) {
        return num < 10 ? '0' + num : '' + num;
    }

    function formatHmsFrames(ms, fps) {
        const totalMs = Math.max(0, Number(ms) || 0);
        const safeFps = sanitizeFps(fps);
        const totalSeconds = totalMs / 1000;
        let remaining = totalSeconds;
        const hours = remaining >= 3600 ? Math.floor(remaining / 3600) : 0;
        remaining -= hours * 3600;
        const minutes = remaining >= 60 ? Math.floor(remaining / 60) : 0;
        remaining -= minutes * 60;
        const seconds = remaining >= 1 ? Math.floor(remaining) : 0;
        const fractional = remaining - seconds;
        let frames = Math.floor(fractional * safeFps + EPSILON);
        if (frames >= safeFps) {
            frames = 0;
        }
        return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(frames)}`;
    }

    function formatHmsMillis(ms, decimals = 3) {
        const totalMs = Math.max(0, Number(ms) || 0);
        const totalSeconds = totalMs / 1000;
        let remaining = totalSeconds;
        const hours = remaining >= 3600 ? Math.floor(remaining / 3600) : 0;
        remaining -= hours * 3600;
        const minutes = remaining >= 60 ? Math.floor(remaining / 60) : 0;
        remaining -= minutes * 60;
        const seconds = remaining >= 1 ? Math.floor(remaining) : 0;
        const fractionalMs = Math.round(totalMs - Math.floor(totalSeconds) * 1000);
        if (decimals <= 0) {
            return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
        }
        const clampedDecimals = Math.min(decimals, 3);
        const paddedMs = String(fractionalMs).padStart(3, '0').substring(0, clampedDecimals);
        return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${paddedMs}`;
    }

    function parseHmsFrames(input, fps) {
        if (typeof input !== 'string') return null;
        const trimmed = input.trim();
        if (!trimmed) return null;
        const match = trimmed.match(/^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/);
        if (!match) return null;
        const [, hh, mm, ss, ff] = match;
        const hours = Number(hh);
        const minutes = Number(mm);
        const seconds = Number(ss);
        const frames = Number(ff);
        if ([hours, minutes, seconds, frames].some(n => Number.isNaN(n))) return null;
        if (minutes > 59 || seconds > 59) return null;
        const safeFps = sanitizeFps(fps);
        const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
        const frameMs = Math.round((frames / safeFps) * 1000);
        return (totalSeconds * 1000) + frameMs;
    }

    function parseHmsMillis(input) {
        if (typeof input !== 'string') return null;
        const trimmed = input.trim();
        if (!trimmed) return null;
        const match = trimmed.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
        if (!match) return null;
        const [, hh, mm, ss, frac] = match;
        const hours = Number(hh);
        const minutes = Number(mm);
        const seconds = Number(ss);
        if ([hours, minutes, seconds].some(n => Number.isNaN(n))) return null;
        if (minutes > 59 || seconds > 59) return null;
        let millis = 0;
        if (typeof frac === 'string' && frac.length) {
            const fracMs = Number(frac.padEnd(3, '0').substring(0, 3));
            if (Number.isNaN(fracMs)) return null;
            millis = fracMs;
        }
        const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
        return (totalSeconds * 1000) + millis;
    }

    function runSelfTests() {
        const fpsCases = [23.976, 24, 25, 29.97];
        const msCases = [0, 1000, 12345, 61234, 3600000 + 1234];
        const prefix = '[PrompterTime][selftest]';
        let failures = 0;
        fpsCases.forEach(fps => {
            msCases.forEach(ms => {
                const formattedFrames = formatHmsFrames(ms, fps);
                const normalizedFrames = formattedFrames.replace(/\.(\d{2})$/, ':$1');
                const parsedMs = parseHmsFrames(normalizedFrames, fps);
                if (parsedMs === null) {
                    console.warn(prefix, 'parseHmsFrames returned null', { formattedFrames, normalizedFrames, fps });
                    failures += 1;
                    return;
                }
                const delta = Math.abs(parsedMs - ms);
                const allowed = Math.max(1, Math.round(1000 / sanitizeFps(fps)));
                if (delta > allowed) {
                    console.warn(prefix, 'format/parse frames mismatch', { fps, ms, formattedFrames, parsedMs, delta, allowed });
                    failures += 1;
                }

                const formattedMillis = formatHmsMillis(ms);
                const parsedMillis = parseHmsMillis(formattedMillis);
                if (parsedMillis === null) {
                    console.warn(prefix, 'parseHmsMillis returned null', { formattedMillis });
                    failures += 1;
                } else if (Math.abs(parsedMillis - ms) > 1) {
                    console.warn(prefix, 'format/parse millis mismatch', { ms, formattedMillis, parsedMillis });
                    failures += 1;
                }
            });
        });
        if (failures === 0) {
            console.info(prefix, 'passed', { cases: fpsCases.length * msCases.length });
        }
        return failures === 0;
    }

    return {
        sanitizeFps,
        msToFrames,
        framesToMs,
        formatHmsFrames,
        formatHmsMillis,
        parseHmsFrames,
        parseHmsMillis,
        runSelfTests
    };
})();

if (typeof window !== 'undefined') {
    window.PrompterTime = PrompterTime;
    try {
        PrompterTime.runSelfTests();
    } catch (err) {
        console.warn('[PrompterTime] self-test threw', err);
    }
}

// --- НАСТРОЙКИ ПО УМОЛЧАНИЮ ---
const defaultSettings = {
    settingsSchemaVersion: 6,
    fontSize: 2,
    lineHeight: 1.4,
    navigationPanelPosition: 'bottom',
    navigationCompactMode: false,
    transportTimecodeVisible: true,
    frameRate: 24,
    autoScroll: true,
    scrollSpeed: 60,
    autoScrollMode: 'page',
    autoScrollDynamicSpeedEnabled: true,
    autoScrollWindowTopPercent: 10,
    autoScrollWindowBottomPercent: 85,
    autoScrollLineAnchorPercent: 35,
    autoScrollLineEasingBaseMs: 220,
    autoScrollLineEasingPerPixel: 1.2,
    autoScrollLineEasingMaxMs: 1200,
    theme: 'dark',
    lineSpacing: 50,
    fontFamily: "'-apple-system', BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
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
    filterHiddenBehavior: 'hide',
    filterDimPercent: 60,
    filterSoloRoles: [],
    filterMuteRoles: [],
    filterSoloActors: [],
    filterMuteActors: [],
    checkerboardEnabled: false,
    checkerboardMode: 'by_role',
    checkerboardBg1: 'rgba(34, 34, 34, 1)',
    checkerboardFont1: 'rgba(238, 238, 238, 1)',
    checkerboardBg2: 'rgba(42, 42, 42, 1)',
    checkerboardFont2: 'rgba(238, 238, 238, 1)',
    highlightCurrentEnabled: true,
    highlightPreviousEnabled: true,
    highlightPauseEnabled: true,
    progressBarEnabled: true,
    progressBarMode: 'subtitle',
    highlightCurrentBg: 'rgba(80, 80, 0, 0.4)',
    highlightCurrentRoleEnabled: true,
    highlightCurrentRoleBg: 'rgba(80, 80, 0, 0.4)',
    highlightPauseBg: 'rgba(0, 80, 120, 0.3)',
    highlightClickEnabled: true,
    highlightClickBg: 'rgba(120, 0, 120, 0.4)',
    highlightClickDuration: 800,
    progressBarColor: 'rgba(255, 193, 7, 1)',
    jumpOnClickEnabled: false,
    jumpPreventWhilePlaying: true,
    jumpPreventWhileRecording: true,
    jumpPreRollSeconds: 0,
    // Actors coloring
    actorRoleMappingText: '', // Raw multiline text user enters
    actorColors: {}, // { actorName: colorString }
    dataModelVersion: 2,
    timecodeDisplayFormat: 'auto'
};
let settings = {};
let currentProjectName = '';
let animationFrameId = null;
let wwr_is_enabled = false;
let navigationPanelCollapsed = false;
const NAV_PANEL_ANIMATION_MS = 280; // Keep in sync with CSS transition timings
let navigationPanelAnimationTimer = null;
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
const SETTINGS_CHUNK_SIZE = 800;
const ROLES_CHUNK_SIZE = 800;

const EMU_ROLES_MISSING_KEY = 'frzz_emu_roles_missing';
const ACTOR_ROLE_DELIMITER_WARNING_TEXT = 'Проверьте карту ролей, не найден общий разделитель между актерами и их ролями';
const PROJECT_DATA_CACHE_KEY = 'frzz_project_data_cache';
const PROJECT_DATA_STATUS_KEY = 'getProjectDataStatus';
const PROJECT_DATA_JSON_KEY = 'getProjectDataJson';
const PROJECT_DATA_CHUNK_COUNT_KEY = 'getProjectDataJson_chunk_count';
const PROJECT_DATA_CHUNK_PREFIX = 'getProjectDataJson_chunk_';
const PROJECT_DATA_POLL_INTERVAL_MS = 100;
const PROJECT_DATA_TIMEOUT_MS = 5000;
const PROJECT_DATA_STATUS_TOLERANCE_MS = 20;

let projectDataCache = null;
let projectDataInFlight = null;
let lastProjectDataTimestamp = 0;

const extStateWaiters = new Map();

function resolveExtStateWaiter(key, value) {
    const waiter = extStateWaiters.get(key);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    extStateWaiters.delete(key);
    try {
        waiter.resolve(value);
    } catch (err) {
        console.error('[Prompter][extstate] waiter resolve failed', { key, err });
    }
    return true;
}

function requestExtStateValue(key, timeoutMs = 500) {
    return new Promise((resolve, reject) => {
        if (extStateWaiters.has(key)) {
            const pending = extStateWaiters.get(key);
            clearTimeout(pending.timer);
            pending.reject(new Error(`Superseded request for ${key}`));
            extStateWaiters.delete(key);
        }
        const timer = setTimeout(() => {
            if (extStateWaiters.get(key) !== record) return;
            extStateWaiters.delete(key);
            reject(new Error(`Timeout waiting for extstate ${key}`));
        }, timeoutMs);
        const record = { resolve, reject, timer };
        extStateWaiters.set(key, record);
        wwr_req(`GET/EXTSTATE/PROMPTER_WEBUI/${key}`);
    });
}

function delay(ms) {
    const duration = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    return new Promise(resolve => setTimeout(resolve, duration));
}

async function fetchProjectDataChunks() {
    const countRaw = await requestExtStateValue(PROJECT_DATA_CHUNK_COUNT_KEY, 800);
    const total = parseInt(countRaw, 10);
    if (!Number.isFinite(total) || total <= 0) {
        throw new Error(`invalid project data chunk count: ${countRaw}`);
    }
    const chunkPromises = [];
    for (let i = 0; i < total; i++) {
        const key = `${PROJECT_DATA_CHUNK_PREFIX}${i}`;
        const promise = requestExtStateValue(key, 800)
            .then(value => value || '')
            .catch(err => {
                console.error('[Prompter][projectData] failed to fetch chunk', { index: i, total }, err);
                throw err;
            });
        chunkPromises.push(promise);
    }
    const parts = await Promise.all(chunkPromises);
    return parts.join('');
}

function parseProjectDataStatus(raw) {
    const result = {
        raw: typeof raw === 'string' ? raw : '',
        normalized: 'unknown',
        state: typeof raw === 'string' ? raw : '',
        timestamp: null,
        detail: ''
    };

    if (typeof raw !== 'string') {
        return result;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
        result.state = '';
        return result;
    }

    const [statePart = '', timestampPart = '', ...detailParts] = trimmed.split('|');
    result.state = statePart;
    result.detail = detailParts.join('|');

    const normalizedState = statePart.toLowerCase();
    if (normalizedState.startsWith('pending') || normalizedState.startsWith('working') || normalizedState.startsWith('processing')) {
        result.normalized = 'pending';
    } else if (normalizedState.startsWith('ok')) {
        result.normalized = 'ok';
    } else if (normalizedState.startsWith('error') || normalizedState.startsWith('fail')) {
        result.normalized = 'error';
    } else if (normalizedState.length) {
        result.normalized = 'other';
    }

    const timestampValue = Number(timestampPart);
    if (Number.isFinite(timestampValue)) {
        result.timestamp = timestampValue;
    }

    return result;
}

function clearProjectDataCache() {
    projectDataCache = null;
    lastProjectDataTimestamp = 0;
    try {
        localStorage.removeItem(PROJECT_DATA_CACHE_KEY);
    } catch (err) {
        console.warn('[Prompter][projectData] failed to clear cache', err);
    }
}

function loadProjectDataCache() {
    if (projectDataCache) {
        return projectDataCache;
    }
    try {
        const raw = localStorage.getItem(PROJECT_DATA_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const snapshot = parsed && typeof parsed === 'object' ? parsed.data || null : null;
        projectDataCache = snapshot && typeof snapshot === 'object' ? snapshot : null;
        return projectDataCache;
    } catch (err) {
        console.warn('[Prompter][projectData] failed to load cache', err);
        return null;
    }
}

function storeProjectDataCache(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        clearProjectDataCache();
        return;
    }
    projectDataCache = snapshot;
    try {
        const payload = { data: snapshot, savedAt: Date.now() };
        localStorage.setItem(PROJECT_DATA_CACHE_KEY, JSON.stringify(payload));
    } catch (err) {
        console.warn('[Prompter][projectData] failed to persist cache', err);
    }
}

$(document).ready(function() {
    const initStartTs = performance.now();
    // --- ПЕРЕМЕННЫЕ ---
    const REASCRIPT_ACTION_ID = "_FRZZ_WEB_NOTES_READER";
    const BASE_LINE_SPACING = 0.5;
    const BASE_ROLE_WIDTH = 9.375;
    const BASE_ROLE_FONT_SIZE = 0.9;
    const mainTitle = $('h1');
    const trackSelector = $('#track-selector');
    const textDisplay = $('#text-display');
    const textDisplayWrapper = $('#text-display-wrapper');
    const textDisplayEl = textDisplay[0] || null;
    const textDisplayWrapperEl = textDisplayWrapper[0] || null;
    const sharedProgressContainer = document.createElement('div');
    sharedProgressContainer.className = 'subtitle-progress-container';
    const sharedProgressBar = document.createElement('div');
    sharedProgressBar.className = 'subtitle-progress-bar';
    sharedProgressContainer.appendChild(sharedProgressBar);
    const JUMP_REQUEST_DEBOUNCE_MS = 150;
    let sharedProgressHost = null;
    let sharedProgressIndex = -1;
    let sharedProgressValue = 0;
    let transportProgressValue = 0;
    let activeTimecodeProgressIndex = -1;
    let timecodeProgressValue = 0;
    const statusIndicator = $('#status-indicator');
    const refreshButton = $('#refresh-button');
    const navigationPanel = $('#navigation-panel');
    const navigationCompactToggle = $('#navigation-compact-toggle');
    const navigationFullscreenToggle = $('#navigation-fullscreen-toggle');
    const navigationFloatingControls = $('#navigation-floating-controls');
    const navigationFloatingExpandButton = $('#navigation-floating-expand');
    const navigationFloatingFullscreenButton = $('#navigation-floating-fullscreen');
    const navigationFloatingSettingsButton = $('#navigation-floating-settings');
    const transportStatus = $('#transport-status');
    const transportStateText = $('#transport-state-text');
    const transportTimecode = $('#transport-timecode');
    const transportProgressContainer = $('#transport-progress-container');
    const transportProgressBar = $('#transport-progress-bar');
    const transportProgressBarEl = transportProgressBar.length ? transportProgressBar[0] : null;
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
    const scrollSpeedWrapper = $('#scroll-speed-wrapper');
    const autoScrollSettingsWrapper = $('#auto-scroll-settings-wrapper');
    const autoScrollModeSelect = $('#auto-scroll-mode');
    const autoScrollDynamicSpeedWrapper = $('#auto-scroll-dynamic-speed-tile');
    const autoScrollDynamicSpeedToggle = $('#auto-scroll-dynamic-speed-enabled');
    const autoScrollWindowWrapper = $('#auto-scroll-window-wrapper');
    const autoScrollWindowTrack = $('#auto-scroll-window-track');
    const autoScrollWindowTopInput = $('#auto-scroll-window-top-percent');
    const autoScrollWindowBottomInput = $('#auto-scroll-window-bottom-percent');
    const autoScrollWindowTopValue = $('#auto-scroll-window-top-value');
    const autoScrollWindowBottomValue = $('#auto-scroll-window-bottom-value');
    const autoScrollLineAnchorWrapper = $('#auto-scroll-line-anchor-wrapper');
    const autoScrollLineAnchorInput = $('#auto-scroll-line-anchor-percent');
    const autoScrollLineAnchorValue = $('#auto-scroll-line-anchor-value');
    const lineSpacingSlider = $('#line-spacing');
    const lineSpacingValue = $('#line-spacing-value');
    const autoFindTrackCheckbox = $('#auto-find-track');
    const autoFindKeywordsWrapper = $('#auto-find-keywords-wrapper');
    const settingsTileGrids = $('.settings-tile-grid');
    const TILE_GRID_ROW_SIZE = 6; // finer granularity for masonry spans
    let settingsTileReflowRaf = null;

    function computeTileGridRowGap(gridEl) {
        if (!gridEl || typeof window === 'undefined') return 0;
        const styles = window.getComputedStyle(gridEl);
        const gapValue = styles.rowGap || styles.gridRowGap || '0';
        const parsed = parseFloat(gapValue);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function reflowSettingsTileGrid(gridEl) {
        if (!gridEl || gridEl.childElementCount === 0) return;
        if (gridEl.offsetParent === null) return; // Skip hidden grids
        const baseRow = TILE_GRID_ROW_SIZE;
        const rowGap = computeTileGridRowGap(gridEl);
        gridEl.style.gridAutoFlow = 'row dense';
        gridEl.style.gridAutoRows = `${baseRow}px`;
        const tiles = gridEl.querySelectorAll('.settings-tile');
        tiles.forEach(tile => {
            if (!tile) return;
            // Ensure measurement includes margins inside the tile
            const tileRect = tile.getBoundingClientRect();
            if (!tileRect || tileRect.height === 0) {
                tile.style.gridRowEnd = 'span 1';
                return;
            }
            const totalHeight = tileRect.height + rowGap;
            const span = Math.max(1, Math.ceil(totalHeight / (baseRow + rowGap)));
            tile.style.gridRowEnd = `span ${span}`;
        });
    }

    function scheduleSettingsTileReflow() {
        if (settingsTileReflowRaf !== null) return;
        if (!settingsTileGrids || !settingsTileGrids.length) return;
        settingsTileReflowRaf = (typeof window !== 'undefined' && window.requestAnimationFrame)
            ? window.requestAnimationFrame(() => {
                settingsTileReflowRaf = null;
                settingsTileGrids.each((_, gridEl) => reflowSettingsTileGrid(gridEl));
            })
            : setTimeout(() => {
                settingsTileReflowRaf = null;
                settingsTileGrids.each((_, gridEl) => reflowSettingsTileGrid(gridEl));
            }, 16);
    }

    scheduleSettingsTileReflow();
    if (typeof window !== 'undefined') {
        $(window).on('resize', scheduleSettingsTileReflow);
    }

    function refreshNavigationCollapseToggleUI(collapsed) {
        if (!navigationCompactToggle || !navigationCompactToggle.length) {
            return;
        }
        const isCollapsed = !!collapsed;
        navigationCompactToggle.attr('aria-expanded', isCollapsed ? 'false' : 'true');
        navigationCompactToggle.attr('title', isCollapsed ? 'Развернуть панель' : 'Свернуть панель');
        navigationCompactToggle.attr('aria-label', isCollapsed ? 'Развернуть панель' : 'Свернуть панель');
        navigationCompactToggle.toggleClass('is-collapsed', isCollapsed);
    }

    function updateNavigationCollapsedUI() {
        const collapsed = navigationPanelCollapsed;
        const navAnimating = navigationPanel.length && navigationPanel.hasClass('nav-panel-animating');
        if (navigationPanel.length) {
            if (!navAnimating) {
                navigationPanel.toggleClass('is-collapsed', collapsed);
            }
            if (collapsed) {
                navigationPanel.attr('aria-hidden', 'true');
            } else {
                navigationPanel.removeAttr('aria-hidden');
            }
            if (supportsInert) {
                if (collapsed) {
                    navigationPanel.attr('inert', '');
                } else {
                    navigationPanel.removeAttr('inert');
                }
            }
        }
        $('body').toggleClass('nav-panel-collapsed', collapsed);
        refreshNavigationCollapseToggleUI(collapsed);
        if (navigationFloatingControls.length) {
            navigationFloatingControls.toggleClass('is-visible', collapsed);
            navigationFloatingControls.attr('aria-hidden', collapsed ? 'false' : 'true');
            const floatingButtons = navigationFloatingControls.find('button');
            floatingButtons.attr('tabindex', collapsed ? 0 : -1);
            if (supportsInert) {
                if (collapsed) {
                    navigationFloatingControls.removeAttr('inert');
                } else {
                    navigationFloatingControls.attr('inert', '');
                }
            }
        }
        if (navigationFloatingExpandButton.length) {
            navigationFloatingExpandButton.attr('aria-expanded', collapsed ? 'false' : 'true');
            navigationFloatingExpandButton.attr('title', collapsed ? 'Развернуть панель' : 'Свернуть панель');
            navigationFloatingExpandButton.attr('aria-label', collapsed ? 'Развернуть панель' : 'Свернуть панель');
        }
    }

    function setNavigationPanelCollapsed(collapsed) {
        const next = !!collapsed;
        if (!navigationPanel.length) {
            navigationPanelCollapsed = next;
            updateNavigationCollapsedUI();
            return;
        }

        if (navigationPanelAnimationTimer !== null) {
            clearTimeout(navigationPanelAnimationTimer);
            navigationPanelAnimationTimer = null;
            navigationPanel.removeClass('nav-panel-animating nav-panel-hidden');
            if (navigationPanelCollapsed) {
                navigationPanel.addClass('is-collapsed');
            } else {
                navigationPanel.removeClass('is-collapsed');
            }
        }

        if (navigationPanelCollapsed === next) {
            updateNavigationCollapsedUI();
            return;
        }

        navigationPanelCollapsed = next;

        const panelEl = navigationPanel[0];
        const finishAnimation = () => {
            navigationPanel.removeClass('nav-panel-animating nav-panel-hidden');
            navigationPanelAnimationTimer = null;
            updateNavigationCollapsedUI();
        };

        navigationPanel.addClass('nav-panel-animating');
        if (next) {
            navigationPanel.removeClass('is-collapsed');
            panelEl.offsetHeight; // force reflow
            navigationPanel.addClass('nav-panel-hidden');
            navigationPanelAnimationTimer = setTimeout(() => {
                navigationPanel.addClass('is-collapsed');
                finishAnimation();
            }, NAV_PANEL_ANIMATION_MS);
        } else {
            navigationPanel.removeClass('is-collapsed');
            navigationPanel.addClass('nav-panel-hidden');
            panelEl.offsetHeight; // force reflow
            navigationPanel.removeClass('nav-panel-hidden');
            navigationPanelAnimationTimer = setTimeout(() => {
                finishAnimation();
            }, NAV_PANEL_ANIMATION_MS);
        }
        updateNavigationCollapsedUI();
        scheduleTransportWrapEvaluation();
    }

    const fullscreenTarget = document.documentElement || document.body || null;
    const fullscreenChangeEvents = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'msfullscreenchange'];
    const fullscreenErrorEvents = ['fullscreenerror', 'webkitfullscreenerror', 'mozfullscreenerror', 'msfullscreenerror'];
    const fullscreenAvailable = Boolean(
        fullscreenTarget && (
            fullscreenTarget.requestFullscreen ||
            fullscreenTarget.webkitRequestFullscreen ||
            fullscreenTarget.mozRequestFullScreen ||
            fullscreenTarget.msRequestFullscreen
        )
    );

    function getActiveFullscreenElement() {
        return document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement ||
            null;
    }

    function isFullscreenActive() {
        return !!getActiveFullscreenElement();
    }

    function enterFullscreenMode() {
        if (!fullscreenAvailable || !fullscreenTarget) {
            return;
        }
        const request = fullscreenTarget.requestFullscreen ||
            fullscreenTarget.webkitRequestFullscreen ||
            fullscreenTarget.mozRequestFullScreen ||
            fullscreenTarget.msRequestFullscreen;
        if (typeof request === 'function') {
            try {
                const result = request.call(fullscreenTarget);
                if (result && typeof result.catch === 'function') {
                    result.catch(err => console.warn('[Prompter] fullscreen entry failed', err));
                }
            } catch (err) {
                console.warn('[Prompter] fullscreen entry threw', err);
            }
        }
    }

    function exitFullscreenMode() {
        if (!fullscreenAvailable) {
            return;
        }
        const exit = document.exitFullscreen ||
            document.webkitExitFullscreen ||
            document.mozCancelFullScreen ||
            document.msExitFullscreen;
        if (typeof exit === 'function') {
            try {
                const result = exit.call(document);
                if (result && typeof result.catch === 'function') {
                    result.catch(err => console.warn('[Prompter] fullscreen exit failed', err));
                }
            } catch (err) {
                console.warn('[Prompter] fullscreen exit threw', err);
            }
        }
    }

    function updateFullscreenToggleUI() {
        const active = isFullscreenActive();
        const enterLabel = 'На весь экран';
        const exitLabel = 'Выйти из полноэкранного режима';
        $('body').toggleClass('prompter-fullscreen-active', active);
        if (navigationFullscreenToggle && navigationFullscreenToggle.length) {
            navigationFullscreenToggle.toggleClass('is-active', active);
            navigationFullscreenToggle.attr('aria-pressed', active ? 'true' : 'false');
            navigationFullscreenToggle.attr('title', active ? exitLabel : enterLabel);
            navigationFullscreenToggle.attr('aria-label', active ? exitLabel : enterLabel);
        }
        if (navigationFloatingFullscreenButton && navigationFloatingFullscreenButton.length) {
            navigationFloatingFullscreenButton.toggleClass('is-active', active);
            navigationFloatingFullscreenButton.attr('aria-pressed', active ? 'true' : 'false');
            navigationFloatingFullscreenButton.attr('title', active ? exitLabel : enterLabel);
            navigationFloatingFullscreenButton.attr('aria-label', active ? exitLabel : enterLabel);
        }
    }

    function handleFullscreenToggle(event) {
        if (event) {
            event.preventDefault();
        }
        if (!fullscreenAvailable) {
            return;
        }
        if (isFullscreenActive()) {
            exitFullscreenMode();
        } else {
            enterFullscreenMode();
        }
    }

    updateNavigationCollapsedUI();
    const processRolesCheckbox = $('#process-roles');
    const roleOptionsWrapper = $('#role-options-wrapper');
    const setRoleOptionsVisibility = (enabled) => {
        if (!roleOptionsWrapper.length) return;
        roleOptionsWrapper.toggleClass('is-hidden', !enabled);
    };
    const updateFilterHiddenControlsVisibility = (mode) => {
        if (!filterDimPercentWrapper.length) return;
        const visible = (mode || '').toLowerCase() === FILTER_BEHAVIOR_DIM;
        filterDimPercentWrapper.css('display', '');
        filterDimPercentWrapper.toggleClass('is-hidden', !visible);
        if (visible && filterDimPercentSlider.length) {
            const dimPercent = sanitizeFilterDimPercent(settings.filterDimPercent, defaultSettings.filterDimPercent);
            filterDimPercentSlider.val(dimPercent);
            filterDimPercentValue.text(`${dimPercent}%`);
            refreshFrzzSliderFill(filterDimPercentSlider);
        } else if (!visible && filterDimPercentValue.length) {
            const dimPercent = sanitizeFilterDimPercent(settings.filterDimPercent, defaultSettings.filterDimPercent);
            if (filterDimPercentSlider.length) {
                filterDimPercentSlider.val(dimPercent);
                refreshFrzzSliderFill(filterDimPercentSlider);
            }
            filterDimPercentValue.text(`${dimPercent}%`);
        }
        scheduleSettingsTileReflow();
    };
    const roleDisplayStyleSelect = $('#role-display-style');
    const enableColorSwatchesCheckbox = $('#enable-color-swatches');
    const roleColumnScaleWrapper = $('#role-column-scale-wrapper');
    const roleColumnScaleSlider = $('#role-column-scale');
    const roleColumnScaleValue = $('#role-column-scale-value');
    const filterHiddenBehaviorSelect = $('#filter-hidden-behavior');
    const filterDimPercentWrapper = $('#filter-dim-percent-wrapper');
    const filterDimPercentSlider = $('#filter-dim-percent');
    const filterDimPercentValue = $('#filter-dim-percent-value');
    const checkerboardEnabledCheckbox = $('#checkerboard-enabled');
    const checkerboardOptionsWrapper = $('#checkerboard-options-wrapper');
    const setCheckerboardOptionsVisibility = (enabled) => {
        if (!checkerboardOptionsWrapper.length) return;
        checkerboardOptionsWrapper.toggleClass('is-hidden', !enabled);
    };
    const highlightCurrentTile = $('#highlight-current-tile');
    const highlightPreviousTile = $('#highlight-previous-tile');
    const highlightProgressTile = $('#highlight-progress-tile');
    const highlightCurrentOptions = $('#highlight-current-options');
    const highlightPreviousOptions = $('#highlight-previous-options');
    const highlightProgressOptions = $('#highlight-progress-options');
    const highlightCurrentEnabledCheckbox = $('#highlight-current-enabled');
    const highlightPreviousEnabledCheckbox = $('#highlight-previous-enabled');
    const highlightPauseEnabledCheckbox = $('#highlight-pause-enabled');
    const progressBarEnabledCheckbox = $('#progress-bar-enabled');
    const progressBarModeSelect = $('#progress-bar-mode');
    const progressBarModeWrapper = $('#progress-bar-mode-wrapper');
    const progressBarColorInput = $('#progress-bar-color');
    const highlightCurrentRoleEnabledCheckbox = $('#highlight-current-role-enabled');
    const highlightClickEnabledCheckbox = $('#highlight-click-enabled');
    const highlightClickOptionsWrapper = $('#highlight-click-options-wrapper');
    const highlightRoleColorWrapper = $('#highlight-role-color-wrapper');
    const roleFontColorEnabledCheckbox = $('#role-font-color-enabled');
    const jumpOnClickCheckbox = $('#jump-on-click-enabled');
    const jumpSettingsWrapper = $('#jump-settings-wrapper');
    const jumpPreRollInput = $('#jump-pre-roll-seconds');
    const jumpPreventWhilePlayingCheckbox = $('#jump-prevent-while-playing');
    const jumpPreventWhileRecordingCheckbox = $('#jump-prevent-while-recording');
    const timecodeDisplayFormatSelect = $('#timecode-display-format');
    let subtitleData = [];
    let subtitleElements = [];
    let subtitleContentElements = [];
    let subtitleTimeElements = [];
    let subtitleTimeLabelElements = [];
    let subtitleTimeProgressElements = [];
    let subtitlePaintStates = [];
    let subtitleStyleMetadata = [];
    let subtitleFilterStates = [];
    let paintGeneration = 0;
    let paintScheduled = false;
    let lastVisibleStart = 0;
    let lastVisibleEnd = 0;
    const PAINT_BUFFER = 50;
    let subtitleObserver = null;
    const visibleIndices = new Set();

    function clearPreviousLineHighlight() {
        if (lastPreviousLineIndex === -1) {
            return;
        }
        removePreviousLineHighlightAt(lastPreviousLineIndex);
    }

    function applyPreviousLineHighlight(index) {
        if (typeof index !== 'number' || index < 0 || index >= subtitleElements.length) {
            clearPreviousLineHighlight();
            return;
        }
        if (lastPreviousLineIndex !== -1 && lastPreviousLineIndex !== index) {
            removePreviousLineHighlightAt(lastPreviousLineIndex);
        }
        const target = subtitleElements[index];
        if (target && target.classList) {
            target.classList.add('previous-line');
            lastPreviousLineIndex = index;
        } else {
            lastPreviousLineIndex = -1;
        }
    }
    function removePreviousLineHighlightAt(index) {
        if (typeof index !== 'number' || index < 0 || index >= subtitleElements.length) {
            return;
        }
        const element = subtitleElements[index];
        if (element && element.classList) {
            element.classList.remove('previous-line');
        }
        if (lastPreviousLineIndex === index) {
            lastPreviousLineIndex = -1;
        }
    }

    function updatePreviousLineHighlightState({
        newCurrentLineIndex,
        previousIndex,
        inPause,
        highlightPreviousEnabled,
        highlightPauseEnabled,
        indexChanged
    }) {
        if (!highlightPreviousEnabled) {
            clearPreviousLineHighlight();
            return;
        }

        if (highlightPauseEnabled) {
            if (inPause && newCurrentLineIndex !== -1) {
                applyPreviousLineHighlight(newCurrentLineIndex);
            } else {
                if (lastPreviousLineIndex !== -1) {
                    removePreviousLineHighlightAt(lastPreviousLineIndex);
                }
                const precedingIndex = newCurrentLineIndex - 1;
                if (precedingIndex >= 0) {
                    removePreviousLineHighlightAt(precedingIndex);
                }
            }
            if (indexChanged && previousIndex !== -1 && previousIndex !== newCurrentLineIndex) {
                removePreviousLineHighlightAt(previousIndex);
            }
            return;
        }

        if (newCurrentLineIndex === -1) {
            if (indexChanged && previousIndex !== -1) {
                applyPreviousLineHighlight(previousIndex);
            } else {
                clearPreviousLineHighlight();
            }
            return;
        }

        if (inPause) {
            applyPreviousLineHighlight(newCurrentLineIndex);
            return;
        }

        const targetIndex = newCurrentLineIndex - 1;
        if (targetIndex >= 0) {
            applyPreviousLineHighlight(targetIndex);
        } else {
            clearPreviousLineHighlight();
        }
    }

    let visibleRangeStart = 0;
    let visibleRangeEnd = -1;
    // rAF id for render loop
    // Move transportWrapRaf early to avoid TDZ error when scheduleTransportWrapEvaluation runs during applySettings
    let transportWrapRaf = null;
    let lastPreviousLineIndex = -1;
    // When roles.json is successfully loaded, prefer actor colors over per-line color entirely
    let rolesLoaded = false;
    let rolesSaveInFlight = false;
    let rolesSaveStartedAt = 0;
    let rolesStatusPollTimer = null;
    let rolesStatusFallbackTimer = null;
    let rolesStatusRetryCount = 0;
    let emuDataLoadedOnce = false;
    let emuRolesFetchAttempted = false;
    let emuRolesFetchPromise = null;
    let projectFps = DEFAULT_PROJECT_FPS;
    let projectFpsSource = 'default';
    let projectDropFrame = false;
    let projectFpsRaw = '';
    let activeTimecodeFormat = normalizeTimecodeDisplayFormatValue(defaultSettings.timecodeDisplayFormat, 'auto');
    let effectiveTimecodeFormat = activeTimecodeFormat;
    let dataModel = createEmptyDataModel();
    const eventBus = createEventBus();
    if (typeof window !== 'undefined') {
        window.PrompterEventBus = eventBus;
        window.PrompterDataModel = () => dataModel;
    }
    // Guards to avoid duplicate loads
    let subtitleLoadInFlight = false;
    let subtitleLoadTrackId = null;
    let subtitlesLoadedOnce = false;
    let currentLineIndex = -1;
    let lastPlaybackTimeSeconds = 0;
    let latestTimecode = 0;
    let firstRenderTs = null;
    const readyStagesLogged = new Set();
    let transportStageLogged = false;
    let transportPlayState = 0;
    let transportLastUpdateAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let transportLastTimecode = 0;
    let lastJumpRequestAt = 0;
    let scrollAnimationFrame = null;
    let subtReaderInertiaState = {
        activeIndex: -1,
        lastTarget: null,
        lastRawProgress: 0
    };

    function hasReliableFrameRateForAuto() {
        if (!Number.isFinite(projectFps) || projectFps <= 0) return false;
        const source = (projectFpsSource || '').toLowerCase();
        if (!source || source === 'default' || source === 'unknown') return false;
        return true;
    }

    function computeEffectiveTimecodeFormat(formatCandidate) {
        const normalized = normalizeTimecodeDisplayFormatValue(formatCandidate, defaultSettings.timecodeDisplayFormat);
        if (normalized === 'auto') {
            return hasReliableFrameRateForAuto() ? 'frames' : 'milliseconds';
        }
        return normalized;
    }

    function getEffectiveTimecodeFormat() {
        return effectiveTimecodeFormat;
    }

    function refreshDisplayedTimecodes(context = {}) {
        if (transportTimecode && transportTimecode.length) {
            transportTimecode.text(formatTimecode(latestTimecode));
        }
        if (!Array.isArray(subtitleData) || !subtitleData.length) return;
        const frameRate = getActiveFrameRate();
        const effectiveFormat = getEffectiveTimecodeFormat();
        for (let i = 0; i < subtitleData.length; i++) {
            const line = subtitleData[i];
            if (!line) continue;
            const timeString = formatTimecode(line.start_time, frameRate);
            const labelNode = subtitleTimeLabelElements[i];
            if (labelNode) {
                labelNode.textContent = timeString;
            } else {
                const container = subtitleElements[i];
                if (container) {
                    const timeNode = container.querySelector('.subtitle-time');
                    if (timeNode) {
                        timeNode.textContent = timeString;
                    }
                }
            }
            line.__cachedTimecode = timeString;
            line.__cachedFrameRate = frameRate;
            line.__cachedTimecodeFormat = effectiveFormat;
        }
        if (context.log) {
            console.debug('[Prompter][timecode] display refreshed', context);
        }
    }

    function setActiveTimecodeFormat(formatCandidate, options = {}) {
        const normalized = normalizeTimecodeDisplayFormatValue(formatCandidate, defaultSettings.timecodeDisplayFormat);
        const previousActive = activeTimecodeFormat;
        const previousEffective = effectiveTimecodeFormat;
        activeTimecodeFormat = normalized;
        effectiveTimecodeFormat = computeEffectiveTimecodeFormat(normalized);
        if (options.updateUI !== false && timecodeDisplayFormatSelect && timecodeDisplayFormatSelect.length) {
            timecodeDisplayFormatSelect.val(normalized);
        }
        const effectiveChanged = effectiveTimecodeFormat !== previousEffective;
        if (options.refresh !== false && (effectiveChanged || options.forceRefresh)) {
            refreshDisplayedTimecodes({ reason: options.reason || 'format_update' });
        }
        if (options.log) {
            console.debug('[Prompter][timecode] format set', {
                active: activeTimecodeFormat,
                effective: effectiveTimecodeFormat,
                reason: options.reason || 'manual',
                effectiveChanged
            });
        }
        return {
            activeChanged: normalized !== previousActive,
            effectiveChanged
        };
    }

    function updateEffectiveTimecodeFormat(reason) {
        const previousEffective = effectiveTimecodeFormat;
        effectiveTimecodeFormat = computeEffectiveTimecodeFormat(activeTimecodeFormat);
        if (effectiveTimecodeFormat !== previousEffective) {
            console.debug('[Prompter][timecode] auto adjustment', { reason, format: effectiveTimecodeFormat });
            refreshDisplayedTimecodes({ reason: reason || 'auto_adjust' });
        }
    }

    setActiveTimecodeFormat(activeTimecodeFormat, { updateUI: false, refresh: false, reason: 'init' });

    // Configure event listener optimizations (passive scroll + skip touch on non-touch devices)
    (function configureInputEventOptimizations($root){
        try {
            if (!$root || !$root.event || !$root.fn) return;
            if ($root.fn.__frzzEventOptimized) return;
            $root.fn.__frzzEventOptimized = true;

            const supportsPassive = (() => {
                let supported = false;
                try {
                    const opts = Object.defineProperty({}, 'passive', {
                        get() {
                            supported = true;
                            return true;
                        }
                    });
                    const testListener = function() {};
                    window.addEventListener('testPassive', testListener, opts);
                    window.removeEventListener('testPassive', testListener, opts);
                } catch (_) {
                    supported = false;
                }
                return supported;
            })();

            const nav = typeof navigator !== 'undefined' ? navigator : null;
            const hasTouchSupport = ('ontouchstart' in window) || (nav && ((nav.maxTouchPoints || 0) > 0 || (nav.msMaxTouchPoints || 0) > 0));

            if (supportsPassive) {
                const passiveEvents = ['wheel', 'mousewheel', 'scroll'];
                passiveEvents.forEach(evt => {
                    const special = $root.event.special[evt] = $root.event.special[evt] || {};
                    const setupOrig = special.setup;
                    const teardownOrig = special.teardown;
                    special.setup = function(_, ns, handle) {
                        if (setupOrig) setupOrig.apply(this, arguments);
                        this.addEventListener(evt, handle, { passive: true });
                        return false;
                    };
                    special.teardown = function(_, ns, handle) {
                        this.removeEventListener(evt, handle, { passive: true });
                        if (teardownOrig) return teardownOrig.apply(this, arguments);
                        return undefined;
                    };
                });
            }

            if (!hasTouchSupport) {
                const touchEvents = new Set(['touchstart', 'touchmove', 'touchend', 'touchcancel']);
                const filterEventTokens = input => {
                    if (!input) return '';
                    return input.split(/\s+/).map(token => token.trim()).filter(token => {
                        if (!token) return false;
                        const base = token.split('.')[0];
                        return !touchEvents.has(base);
                    }).join(' ');
                };
                const filterFirstArg = arg => {
                    if (typeof arg === 'string') {
                        const filtered = filterEventTokens(arg);
                        return filtered ? filtered : null;
                    }
                    if (arg && typeof arg === 'object') {
                        const result = {};
                        Object.keys(arg).forEach(key => {
                            const filteredKey = filterEventTokens(key);
                            if (filteredKey) {
                                result[filteredKey] = arg[key];
                            }
                        });
                        return Object.keys(result).length ? result : null;
                    }
                    return arg;
                };
                const origOn = $root.fn.on;
                const origOff = $root.fn.off;
                const origOne = $root.fn.one;
                $root.fn.on = function(...args) {
                    if (!args.length) return origOn.apply(this, args);
                    const filtered = filterFirstArg(args[0]);
                    if (filtered === null) return this;
                    args[0] = filtered;
                    return origOn.apply(this, args);
                };
                $root.fn.off = function(...args) {
                    if (!args.length) return origOff.apply(this, args);
                    const filtered = filterFirstArg(args[0]);
                    if (filtered === null) return this;
                    args[0] = filtered;
                    return origOff.apply(this, args);
                };
                $root.fn.one = function(...args) {
                    if (!args.length) return origOne.apply(this, args);
                    const filtered = filterFirstArg(args[0]);
                    if (filtered === null) return this;
                    args[0] = filtered;
                    return origOne.apply(this, args);
                };
                console.debug('[Prompter][perf] touch listeners skipped (no touch support detected)');
            }

            if (supportsPassive) {
                console.debug('[Prompter][perf] passive listeners enabled for wheel/mousewheel/scroll', {
                    skipTouch: !hasTouchSupport
                });
            }
        } catch (err) {
            console.warn('[Prompter][perf] event optimization setup failed', err);
        }
    })($);

    console.info('[Prompter] document ready init start');

    // Actor coloring runtime caches
    let roleToActor = {}; // role -> actor
    let actorToRoles = {}; // actor -> Set(roles)
    let cachedActorRoleMappingText = null;
    let cachedMappedRolesCount = 0;
    let actorRoleDelimiterWarning = '';
    const speedSteps = [1];
    for (let i = 10; i <= 200; i += 10) { speedSteps.push(i); }
    speedSteps.push(500);
    scrollSpeedSlider.attr('min', 0).attr('max', speedSteps.length - 1).attr('step', 1);

    const FILTER_BEHAVIOR_HIDE = 'hide';
    const FILTER_BEHAVIOR_DIM = 'dim';
    const defaultDimOpacity = computeFilterDimOpacity(defaultSettings.filterDimPercent);
    const filterRuntime = {
        behavior: defaultSettings.filterHiddenBehavior,
        dimPercent: defaultSettings.filterDimPercent,
        dimOpacity: defaultDimOpacity,
        dimOverlayAlpha: Number((1 - defaultDimOpacity).toFixed(3)),
        soloRoles: new Set(),
        muteRoles: new Set(),
        soloActors: new Set(),
        muteActors: new Set(),
        hasFilters: false
    };
    let filtersApplied = false;

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
    const LIGHTEN_CACHE = new Map();
    function getLightenedColorCached(colorStr, forceLightBg = true) {
        if (!colorStr) return null;
        const key = `${forceLightBg ? 1 : 0}|${colorStr}`;
        if (LIGHTEN_CACHE.has(key)) return LIGHTEN_CACHE.get(key);
        const value = lightenGeneric(colorStr, forceLightBg);
        LIGHTEN_CACHE.set(key, value);
        return value;
    }
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

    function logReadyStage(stage) {
        if (readyStagesLogged.has(stage)) return;
        readyStagesLogged.add(stage);
        const now = performance.now();
        const payload = {
            stage,
            msSinceInit: Math.round(now - initStartTs)
        };
        if (firstRenderTs !== null) {
            payload.msToFirstRender = Math.round(firstRenderTs - initStartTs);
            payload.msSinceFirstRender = Math.round(now - firstRenderTs);
        }
        console.info('[Prompter][ready]', payload);
    }

    function getEmuRolesMissingFlag() {
        try { return sessionStorage.getItem(EMU_ROLES_MISSING_KEY) === '1'; }
        catch (_) { return false; }
    }

    function setEmuRolesMissingFlag(flag) {
        try {
            if (flag) sessionStorage.setItem(EMU_ROLES_MISSING_KEY, '1');
            else sessionStorage.removeItem(EMU_ROLES_MISSING_KEY);
        } catch (_) { /* storage may be unavailable */ }
    }
    
    function parseFpsDescriptor(value) {
        const result = {
            numeric: NaN,
            dropFrame: null,
            raw: ''
        };
        if (typeof value === 'number' && Number.isFinite(value)) {
            result.numeric = value;
            result.raw = String(value);
            return result;
        }
        if (typeof value !== 'string') {
                    candidates = value.split(/[;,\r\n]+/);
        }
        const trimmed = value.trim();
        if (!trimmed) {
            return result;
        }
        result.raw = trimmed;
        const normalized = trimmed.replace(',', '.');
        const suffixMatch = normalized.match(/(df|ndf|nd)\s*$/i);
        if (suffixMatch) {
            const suffix = suffixMatch[1].toUpperCase();
            if (suffix === 'DF') {
                result.dropFrame = true;
            } else {
                result.dropFrame = false;
            }
        }
        const numericMatch = normalized.match(/-?\d+(?:\.\d+)?/);
        if (numericMatch) {
            const parsed = Number(numericMatch[0]);
            if (Number.isFinite(parsed)) {
                result.numeric = parsed;
            }
        }
        return result;
    }

    function getActiveFrameRate() {
        return PrompterTime.sanitizeFps(projectFps || settings.frameRate || DEFAULT_PROJECT_FPS);
    }

    function formatTimecode(totalSeconds, frameRate = null) {
        const ms = Math.max(0, Number(totalSeconds) || 0) * 1000;
        const effectiveFormat = getEffectiveTimecodeFormat();
        if (effectiveFormat === 'milliseconds') {
            return PrompterTime.formatHmsMillis(ms, 2);
        }
        const fps = PrompterTime.sanitizeFps(frameRate || getActiveFrameRate());
        return PrompterTime.formatHmsFrames(ms, fps);
    }

    function setProjectFps(newFps, meta = {}) {
        const { forceEmit = false, source: metaSource, dropFrame, raw, ...restMeta } = meta;
        const descriptor = parseFpsDescriptor(newFps);
        let numericInput = descriptor.numeric;
        let descriptorDropFrame = descriptor.dropFrame;
        let descriptorRaw = descriptor.raw;
        let fallbackDescriptor = null;
        if (!Number.isFinite(numericInput) || numericInput <= 0) {
            console.warn('[Prompter][fps] invalid fps candidate, falling back', { newFps, meta });
            fallbackDescriptor = parseFpsDescriptor(projectFps);
            numericInput = fallbackDescriptor.numeric;
            if (!Number.isFinite(numericInput) || numericInput <= 0) {
                numericInput = DEFAULT_PROJECT_FPS;
            }
            if (descriptorDropFrame === null && fallbackDescriptor.dropFrame !== null) {
                descriptorDropFrame = fallbackDescriptor.dropFrame;
            }
            if (!descriptorRaw && fallbackDescriptor.raw) {
                descriptorRaw = fallbackDescriptor.raw;
            }
        }
        const sanitized = PrompterTime.sanitizeFps(numericInput);
        const source = metaSource || projectFpsSource || 'unknown';
        const previousFps = projectFps;
        const sameValue = Math.abs(sanitized - previousFps) < 1e-3;
        const previousDrop = projectDropFrame;
        const previousRaw = projectFpsRaw;
        projectFpsSource = source;
        let rawString = '';
        if (typeof raw === 'string' && raw.trim()) {
            rawString = raw.trim();
        } else if (descriptorRaw) {
            rawString = descriptorRaw;
        } else if (typeof newFps === 'string' && newFps.trim()) {
            rawString = newFps.trim();
        } else if (fallbackDescriptor && fallbackDescriptor.raw) {
            rawString = fallbackDescriptor.raw;
        } else if (Number.isFinite(newFps)) {
            rawString = String(newFps);
        } else {
            rawString = String(sanitized);
        }
        let dropToApply = projectDropFrame;
        if (typeof dropFrame === 'boolean') {
            dropToApply = dropFrame;
        } else if (descriptorDropFrame !== null) {
            dropToApply = descriptorDropFrame;
        } else if (rawString) {
            const rawDescriptor = parseFpsDescriptor(rawString);
            if (rawDescriptor.dropFrame !== null) {
                dropToApply = rawDescriptor.dropFrame;
            }
        }
        projectDropFrame = dropToApply;
        projectFpsRaw = rawString;
        projectFps = sanitized;
        settings.frameRate = sanitized;
        const metaUnchanged = projectDropFrame === previousDrop && projectFpsRaw === previousRaw;
        if (sameValue && metaUnchanged && !forceEmit) {
            return;
        }
        const payload = { fps: sanitized, source, dropFrame: projectDropFrame, raw: projectFpsRaw, ...restMeta };
        eventBus.emit('project:fps', payload);
        console.info('[Prompter][fps] updated', payload);
        updateEffectiveTimecodeFormat(meta.reason || source || 'fps_update');
    }

    function legacyActorMappingToText(source) {
        if (!source || typeof source !== 'object') return '';
        const lines = [];
        Object.keys(source).forEach(actorRaw => {
            if (!actorRaw) return;
            const actor = String(actorRaw).trim();
            if (!actor) return;
            const value = source[actorRaw];
            let roles = [];
            if (Array.isArray(value)) {
                roles = value
                    .map(r => typeof r === 'string' ? r.trim() : '')
                    .filter(Boolean);
            } else if (typeof value === 'string') {
                roles = value
                    .split(/[;,\n]+/)
                    .map(r => r.trim())
                    .filter(Boolean);
            } else if (value && typeof value === 'object') {
                roles = Object.keys(value)
                    .filter(key => {
                        const val = value[key];
                        if (typeof val === 'boolean') return val;
                        if (typeof val === 'number') return Number.isFinite(val) ? val !== 0 : false;
                        if (typeof val === 'string') return val.trim().length > 0;
                        return false;
                    })
                    .map(key => key.trim())
                    .filter(Boolean);
            }
            if (roles.length) {
                lines.push(`${actor} ${roles.join(', ')}`);
            }
        });
        return lines.join('\n');
    }

    function normalizeActorColors(input) {
        if (!input) return {};
        if (Array.isArray(input)) {
            const normalized = {};
            input.forEach(entry => {
                if (!entry) return;
                if (Array.isArray(entry) && entry.length >= 2) {
                    const actor = String(entry[0] || '').trim();
                    const color = String(entry[1] || '').trim();
                    if (actor && color) normalized[actor] = color;
                } else if (typeof entry === 'object') {
                    const actor = String(entry.actor || entry.name || '').trim();
                    const color = String(entry.color || entry.value || '').trim();
                    if (actor && color) normalized[actor] = color;
                }
            });
            return normalized;
        }
        if (typeof input === 'object') {
            const normalized = {};
            Object.keys(input).forEach(key => {
                const actor = String(key || '').trim();
                const color = input[key];
                if (!actor) return;
                if (typeof color === 'string' && color.trim()) {
                    normalized[actor] = color.trim();
                }
            });
            return normalized;
        }
        return {};
    }

    function migrateSettingsObject(rawSettings, metaTarget) {
        const incoming = rawSettings && typeof rawSettings === 'object' ? { ...rawSettings } : {};
        const legacySchema = Number(incoming.settingsSchemaVersion || incoming.settings_schema_version || 1);
        let changed = false;
        const coerceFlag = (value, fallback) => {
            if (value === undefined || value === null) {
                return !!fallback;
            }
            if (typeof value === 'boolean') {
                return value;
            }
            if (typeof value === 'number') {
                return value !== 0;
            }
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
                    return true;
                }
                if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
                    return false;
                }
            }
            return !!fallback;
        };
        if ((!incoming.actorRoleMappingText || !incoming.actorRoleMappingText.trim()) && incoming.actorRoleMapping) {
            const legacyText = legacyActorMappingToText(incoming.actorRoleMapping);
            if (legacyText) {
                incoming.actorRoleMappingText = legacyText;
                changed = true;
            }
            delete incoming.actorRoleMapping;
        }
        if ((!incoming.actorRoleMappingText || !incoming.actorRoleMappingText.trim()) && incoming.actorRoles) {
            const legacyText = legacyActorMappingToText(incoming.actorRoles);
            if (legacyText) {
                incoming.actorRoleMappingText = legacyText;
                changed = true;
            }
            delete incoming.actorRoles;
        }
        if (incoming.actorColors) {
            const normalizedColors = normalizeActorColors(incoming.actorColors);
            if (JSON.stringify(normalizedColors) !== JSON.stringify(incoming.actorColors)) {
                changed = true;
            }
            incoming.actorColors = normalizedColors;
        }
        if (typeof incoming.uiScale === 'number' && incoming.uiScale > 300) {
            incoming.uiScale = Math.round(incoming.uiScale / 2);
            changed = true;
        } else if (typeof incoming.fontScale === 'number') {
            incoming.uiScale = Math.round(incoming.fontScale * 100);
            delete incoming.fontScale;
            changed = true;
        }
        if (incoming.roleColumnWidth && !incoming.roleColumnScale) {
            const value = Number(incoming.roleColumnWidth);
            if (Number.isFinite(value) && value > 0) {
                incoming.roleColumnScale = Math.round(Math.min(300, Math.max(50, value * 100)));
                changed = true;
            }
            delete incoming.roleColumnWidth;
        }
        if (typeof incoming.frameRate === 'string') {
            const parsed = parseFloat(incoming.frameRate);
            if (Number.isFinite(parsed)) {
                incoming.frameRate = parsed;
                changed = true;
            }
        }
        if (incoming.jumpPreRollSeconds !== undefined) {
            const sanitizedPreRoll = sanitizeJumpPreRollSeconds(incoming.jumpPreRollSeconds, defaultSettings.jumpPreRollSeconds);
            if (sanitizedPreRoll !== incoming.jumpPreRollSeconds) {
                incoming.jumpPreRollSeconds = sanitizedPreRoll;
                changed = true;
            }
        }
        if (incoming.jumpOnClickEnabled !== undefined && typeof incoming.jumpOnClickEnabled !== 'boolean') {
            const normalized = Boolean(incoming.jumpOnClickEnabled);
            if (normalized !== incoming.jumpOnClickEnabled) {
                incoming.jumpOnClickEnabled = normalized;
                changed = true;
            }
        }
        if (incoming.jumpPreventWhilePlaying !== undefined && typeof incoming.jumpPreventWhilePlaying !== 'boolean') {
            const normalized = Boolean(incoming.jumpPreventWhilePlaying);
            if (normalized !== incoming.jumpPreventWhilePlaying) {
                incoming.jumpPreventWhilePlaying = normalized;
                changed = true;
            }
        }
        if (incoming.jumpPreventWhileRecording !== undefined && typeof incoming.jumpPreventWhileRecording !== 'boolean') {
            const normalized = Boolean(incoming.jumpPreventWhileRecording);
            if (normalized !== incoming.jumpPreventWhileRecording) {
                incoming.jumpPreventWhileRecording = normalized;
                changed = true;
            }
        }
        const base = { ...defaultSettings, ...incoming };
        const navCompact = coerceFlag(base.navigationCompactMode, defaultSettings.navigationCompactMode);
        if (navCompact !== base.navigationCompactMode) {
            base.navigationCompactMode = navCompact;
            changed = true;
        } else {
            base.navigationCompactMode = navCompact;
        }
        const transportVisible = coerceFlag(base.transportTimecodeVisible, defaultSettings.transportTimecodeVisible);
        if (transportVisible !== base.transportTimecodeVisible) {
            base.transportTimecodeVisible = transportVisible;
            changed = true;
        } else {
            base.transportTimecodeVisible = transportVisible;
        }
        const highlightCurrent = coerceFlag(base.highlightCurrentEnabled, defaultSettings.highlightCurrentEnabled);
        if (highlightCurrent !== base.highlightCurrentEnabled) {
            base.highlightCurrentEnabled = highlightCurrent;
            changed = true;
        } else {
            base.highlightCurrentEnabled = highlightCurrent;
        }
        const highlightPrevious = coerceFlag(base.highlightPreviousEnabled, defaultSettings.highlightPreviousEnabled);
        if (highlightPrevious !== base.highlightPreviousEnabled) {
            base.highlightPreviousEnabled = highlightPrevious;
            changed = true;
        } else {
            base.highlightPreviousEnabled = highlightPrevious;
        }
        const highlightPause = coerceFlag(base.highlightPauseEnabled, defaultSettings.highlightPauseEnabled);
        if (highlightPause !== base.highlightPauseEnabled) {
            base.highlightPauseEnabled = highlightPause;
            changed = true;
        } else {
            base.highlightPauseEnabled = highlightPause;
        }
        const progressEnabled = coerceFlag(base.progressBarEnabled, defaultSettings.progressBarEnabled);
        if (progressEnabled !== base.progressBarEnabled) {
            base.progressBarEnabled = progressEnabled;
            changed = true;
        } else {
            base.progressBarEnabled = progressEnabled;
        }
        const sanitizedProgressMode = sanitizeProgressBarMode(
            base.progressBarMode,
            defaultSettings.progressBarMode
        );
        if (sanitizedProgressMode !== base.progressBarMode) {
            base.progressBarMode = sanitizedProgressMode;
            changed = true;
        }
        if (!base.dataModelVersion || base.dataModelVersion < DATA_MODEL_VERSION) {
            changed = true;
            base.dataModelVersion = DATA_MODEL_VERSION;
        }
        if (!base.timecodeDisplayFormat) {
            base.timecodeDisplayFormat = defaultSettings.timecodeDisplayFormat;
            changed = true;
        }
        const normalizedFormat = normalizeTimecodeDisplayFormatValue(base.timecodeDisplayFormat, defaultSettings.timecodeDisplayFormat);
        if (normalizedFormat !== base.timecodeDisplayFormat) {
            base.timecodeDisplayFormat = normalizedFormat;
            changed = true;
        }
        if (legacySchema !== SETTINGS_SCHEMA_VERSION) {
            changed = true;
        }
        base.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
        if (legacySchema < SETTINGS_SCHEMA_VERSION) {
            base.settingsMigratedFrom = legacySchema;
        } else {
            delete base.settingsMigratedFrom;
        }

        const sanitizedMode = sanitizeAutoScrollMode(base.autoScrollMode, defaultSettings.autoScrollMode);
        if (sanitizedMode !== base.autoScrollMode) {
            base.autoScrollMode = sanitizedMode;
            changed = true;
        }
        const sanitizedDynamicSpeed = base.autoScrollDynamicSpeedEnabled !== false;
        if (sanitizedDynamicSpeed !== base.autoScrollDynamicSpeedEnabled) {
            base.autoScrollDynamicSpeedEnabled = sanitizedDynamicSpeed;
            changed = true;
        }
        const sanitizedWindowTop = sanitizeAutoScrollPercent(
            base.autoScrollWindowTopPercent,
            defaultSettings.autoScrollWindowTopPercent,
            0,
            90
        );
        let sanitizedWindowBottom = sanitizeAutoScrollPercent(
            base.autoScrollWindowBottomPercent,
            defaultSettings.autoScrollWindowBottomPercent,
            sanitizedWindowTop + MIN_AUTO_SCROLL_WINDOW_GAP,
            100
        );
        if (sanitizedWindowBottom - sanitizedWindowTop < MIN_AUTO_SCROLL_WINDOW_GAP) {
            sanitizedWindowBottom = Math.min(100, sanitizedWindowTop + MIN_AUTO_SCROLL_WINDOW_GAP);
        }
        if (sanitizedWindowTop !== base.autoScrollWindowTopPercent) {
            base.autoScrollWindowTopPercent = sanitizedWindowTop;
            changed = true;
        }
        if (sanitizedWindowBottom !== base.autoScrollWindowBottomPercent) {
            base.autoScrollWindowBottomPercent = sanitizedWindowBottom;
            changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(base, 'autoScrollPageAnchorPercent')) {
            delete base.autoScrollPageAnchorPercent;
            changed = true;
        }
        const sanitizedLineAnchor = sanitizeAutoScrollPercent(
            base.autoScrollLineAnchorPercent,
            defaultSettings.autoScrollLineAnchorPercent,
            0,
            100
        );
        if (sanitizedLineAnchor !== base.autoScrollLineAnchorPercent) {
            base.autoScrollLineAnchorPercent = sanitizedLineAnchor;
            changed = true;
        }
        const sanitizedLineBase = sanitizeAutoScrollLineEasingBaseMs(
            base.autoScrollLineEasingBaseMs,
            defaultSettings.autoScrollLineEasingBaseMs
        );
        if (sanitizedLineBase !== base.autoScrollLineEasingBaseMs) {
            base.autoScrollLineEasingBaseMs = sanitizedLineBase;
            changed = true;
        }
        const sanitizedLinePerPixel = sanitizeAutoScrollLineEasingPerPixel(
            base.autoScrollLineEasingPerPixel,
            defaultSettings.autoScrollLineEasingPerPixel
        );
        if (sanitizedLinePerPixel !== base.autoScrollLineEasingPerPixel) {
            base.autoScrollLineEasingPerPixel = sanitizedLinePerPixel;
            changed = true;
        }
        let sanitizedLineMax = sanitizeAutoScrollLineEasingMaxMs(
            base.autoScrollLineEasingMaxMs,
            defaultSettings.autoScrollLineEasingMaxMs
        );
        if (sanitizedLineMax < base.autoScrollLineEasingBaseMs) {
            sanitizedLineMax = base.autoScrollLineEasingBaseMs;
        }
        if (sanitizedLineMax !== base.autoScrollLineEasingMaxMs) {
            base.autoScrollLineEasingMaxMs = sanitizedLineMax;
            changed = true;
        }
        if (metaTarget && typeof metaTarget === 'object') {
            metaTarget.changed = !!changed;
            metaTarget.legacySchema = legacySchema;
            metaTarget.migratedFrom = legacySchema < SETTINGS_SCHEMA_VERSION ? legacySchema : null;
        }
        return base;
    }

    function createEmptyDataModel() {
        return {
            version: DATA_MODEL_VERSION,
            roles: new Map(),
            actors: new Map(),
            bindings: new Map(),
            lines: new Map(),
            order: [],
            meta: { generatedAt: Date.now() }
        };
    }

    function resetDataModel() {
        dataModel = createEmptyDataModel();
    }

    function resolveDataModelLineId(line, fallbackIndex) {
        if (line && typeof line === 'object') {
            const { id, guid, uuid, uid, unique_id: uniqueId } = line;
            if (typeof id === 'string' && id.trim()) return id.trim();
            if (typeof guid === 'string' && guid.trim()) return guid.trim();
            if (Number.isFinite(guid)) return `guid_${guid}`;
            if (typeof uuid === 'string' && uuid.trim()) return uuid.trim();
            if (typeof uid === 'string' && uid.trim()) return uid.trim();
            if (typeof uniqueId === 'string' && uniqueId.trim()) return uniqueId.trim();
            if (Number.isFinite(id)) return `id_${id}`;
            if (typeof line.__dataModelId === 'string' && line.__dataModelId) return line.__dataModelId;
        }
        const safeIndex = Number.isFinite(fallbackIndex) ? fallbackIndex : 0;
        const timePart = line && Number.isFinite(line.start_time) ? Math.round(line.start_time * 1000) : safeIndex;
        const generated = `line_${timePart}_${safeIndex}`;
        if (line && typeof line === 'object') {
            try {
                line.__dataModelId = generated;
            } catch (err) {
                /* ignore inability to assign */
            }
        }
        return generated;
    }

    function recordDataModelLine(record) {
        if (!record || !record.id) return;
        dataModel.lines.set(record.id, record);
        dataModel.order.push(record.id);
        if (record.roleId) {
            if (!dataModel.roles.has(record.roleId)) {
                dataModel.roles.set(record.roleId, {
                    id: record.roleId,
                    name: record.roleId,
                    baseColor: record.roleBaseColor || null,
                    lineIds: []
                });
            }
            dataModel.roles.get(record.roleId).lineIds.push(record.id);
        }
        if (record.actorId) {
            if (!dataModel.actors.has(record.actorId)) {
                dataModel.actors.set(record.actorId, {
                    id: record.actorId,
                    name: record.actorId,
                    color: (settings.actorColors && settings.actorColors[record.actorId]) || null,
                    lineIds: []
                });
            }
            dataModel.actors.get(record.actorId).lineIds.push(record.id);
            if (record.roleId) {
                dataModel.bindings.set(record.roleId, record.actorId);
            }
        }
    }

    function finalizeDataModelUpdate() {
        dataModel.meta.generatedAt = Date.now();
        eventBus.emit('data:model:update', {
            lines: dataModel.order.length,
            roles: dataModel.roles.size,
            actors: dataModel.actors.size
        });
    }

    function encodeEventPayload(payload) {
        if (!payload || typeof payload !== 'object') return '';
        return Object.keys(payload).map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(payload[key]))}`).join('&');
    }

    function createEventBus() {
        const handlerMap = new Map();
        const HISTORY_LIMIT = 50;
        const history = [];
        let pollTimerId = null;
        let watchdogTimerId = null;
        const diagState = {
            startedAt: Date.now(),
            lastPollAt: 0,
            lastIngestAt: 0,
            lastEmitOutAt: 0,
            lastEmitLocalAt: 0,
            consecutivePollMisses: 0,
            consecutiveIngestMisses: 0,
            watchdogFired: 0
        };
        const WATCHDOG_INTERVAL = 2000;
        const POLL_STALL_THRESHOLD = 4500;
        const INGEST_STALL_THRESHOLD = 7000;

        function appendHistory(entry) {
            history.push({ ...entry, timestamp: Date.now() });
            if (history.length > HISTORY_LIMIT) history.shift();
        }

        function dispatch(name, payload, meta) {
            const handlers = handlerMap.get(name);
            if (!handlers || handlers.size === 0) return;
            handlers.forEach(fn => {
                try {
                    fn(payload, meta || {});
                } catch (err) {
                    console.error('[Prompter][eventBus] handler error', err);
                }
            });
        }

        function requestBackendEvents() {
            if (!wwr_is_enabled) return;
            diagState.lastPollAt = Date.now();
            wwr_req('GET/EXTSTATE/PROMPTER_WEBUI/event_queue');
        }

        function logDiagnostic(kind, details) {
            const payload = { kind, ...(details || {}) };
            appendHistory({ direction: 'diag', name: kind, payload });
            console.warn('[Prompter][eventBus][diag]', kind, payload);
        }

        function ensureWatchdog() {
            if (watchdogTimerId) return;
            watchdogTimerId = setInterval(() => {
                const now = Date.now();
                if (diagState.lastPollAt && (now - diagState.lastPollAt) > POLL_STALL_THRESHOLD) {
                    diagState.consecutivePollMisses += 1;
                    diagState.watchdogFired += 1;
                    logDiagnostic('poll_stall', {
                        sinceMs: now - diagState.lastPollAt,
                        consecutive: diagState.consecutivePollMisses
                    });
                    requestBackendEvents();
                } else {
                    diagState.consecutivePollMisses = 0;
                }
                if (diagState.lastIngestAt && (now - diagState.lastIngestAt) > INGEST_STALL_THRESHOLD) {
                    diagState.consecutiveIngestMisses += 1;
                    diagState.watchdogFired += 1;
                    logDiagnostic('ingest_stall', {
                        sinceMs: now - diagState.lastIngestAt,
                        consecutive: diagState.consecutiveIngestMisses
                    });
                    requestBackendEvents();
                } else {
                    diagState.consecutiveIngestMisses = 0;
                }
            }, WATCHDOG_INTERVAL);
        }

        function stopWatchdog() {
            if (watchdogTimerId) {
                clearInterval(watchdogTimerId);
                watchdogTimerId = null;
            }
            diagState.consecutivePollMisses = 0;
            diagState.consecutiveIngestMisses = 0;
        }

        function startPolling() {
            if (pollTimerId) return;
            pollTimerId = setInterval(requestBackendEvents, 180);
            requestBackendEvents();
            ensureWatchdog();
        }

        function stopPolling() {
            if (pollTimerId) {
                clearInterval(pollTimerId);
                pollTimerId = null;
            }
            stopWatchdog();
        }

        function ingestBackendQueue(raw) {
            const trimmed = typeof raw === 'string' ? raw.trim() : '';
            if (!trimmed) {
                diagState.lastIngestAt = Date.now();
                return;
            }
            const lines = trimmed.split('\n').map(s => s.trim()).filter(Boolean);
            if (!lines.length) return;
            diagState.lastIngestAt = Date.now();
            lines.forEach(line => {
                try {
                    const evt = JSON.parse(line);
                    appendHistory({ direction: 'in', name: evt.name, payload: evt.payload || null });
                    dispatch(evt.name, evt.payload || {}, { source: 'backend', ts: evt.ts });
                } catch (err) {
                    console.warn('[Prompter][eventBus] failed to parse backend event', line, err);
                }
            });
            // clear queue
            wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/event_queue/');
        }

        function on(name, handler) {
            if (!handlerMap.has(name)) handlerMap.set(name, new Set());
            handlerMap.get(name).add(handler);
            return () => off(name, handler);
        }

        function once(name, handler) {
            const wrapper = (payload, meta) => {
                off(name, wrapper);
                handler(payload, meta);
            };
            return on(name, wrapper);
        }

        function off(name, handler) {
            const set = handlerMap.get(name);
            if (!set) return;
            set.delete(handler);
            if (set.size === 0) handlerMap.delete(name);
        }

        function emitLocal(name, payload = {}, meta = { source: 'local' }) {
            appendHistory({ direction: 'local', name, payload });
            diagState.lastEmitLocalAt = Date.now();
            dispatch(name, payload, meta);
        }

        function emitToBackend(name, payload = {}) {
            const safeName = encodeURIComponent(name);
            const encodedPayload = encodeURIComponent(encodeEventPayload(payload));
            wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/event_name/${safeName}`);
            wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/event_payload/${encodedPayload}`);
            wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/PROCESS_EVENT');
            setTimeout(() => { wwr_req(REASCRIPT_ACTION_ID); }, 25);
            appendHistory({ direction: 'out', name, payload });
            diagState.lastEmitOutAt = Date.now();
        }

        return {
            on,
            once,
            off,
            emit: emitLocal,
            emitToBackend,
            ingestBackendQueue,
            start: startPolling,
            stop: stopPolling,
            history: () => [...history],
            diagnostics: () => ({
                ...diagState,
                pollTimerActive: Boolean(pollTimerId),
                watchdogActive: Boolean(watchdogTimerId)
            }),
            resetDiagnostics: () => {
                diagState.lastPollAt = 0;
                diagState.lastIngestAt = 0;
                diagState.lastEmitOutAt = 0;
                diagState.lastEmitLocalAt = 0;
                diagState.consecutivePollMisses = 0;
                diagState.consecutiveIngestMisses = 0;
                diagState.watchdogFired = 0;
            }
        };
    }

    function smoothScrollWrapperTo(targetTop, options = {}) {
        const wrapper = textDisplayWrapperEl || textDisplayWrapper[0] || null;
        if (!wrapper) return;
        const maxScrollTop = Math.max(0, wrapper.scrollHeight - wrapper.clientHeight);
        const clampedTarget = clampNumber(targetTop, 0, maxScrollTop);
        const currentScrollTop = wrapper.scrollTop;
        const distance = clampedTarget - currentScrollTop;
        if (Math.abs(distance) < 0.5) {
            wrapper.scrollTop = clampedTarget;
            return;
        }
        if (scrollAnimationFrame) {
            cancelAnimationFrame(scrollAnimationFrame);
            scrollAnimationFrame = null;
        }
        const defaultDuration = Math.max(240, Math.min(900, Math.abs(distance) * 0.65));
        const desiredDuration = Number(options.durationMs);
        const durationMs = clampNumber(
            Number.isFinite(desiredDuration) && desiredDuration > 0 ? desiredDuration : defaultDuration,
            60,
            options.maxDurationMs ? clampNumber(options.maxDurationMs, 120, MAX_AUTO_SCROLL_ANIMATION_MS) : MAX_AUTO_SCROLL_ANIMATION_MS
        );
        const easingFn = typeof options.easing === 'function' ? options.easing : easeOutCubic;
        const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        const startTop = currentScrollTop;

        const step = (timestamp) => {
            const nowTs = typeof timestamp === 'number' ? timestamp : ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
            const elapsed = nowTs - startTime;
            const t = elapsed >= durationMs ? 1 : Math.max(0, elapsed / durationMs);
            const eased = easingFn(t);
            wrapper.scrollTop = startTop + distance * eased;
            if (t < 1) {
                scrollAnimationFrame = requestAnimationFrame(step);
            } else {
                scrollAnimationFrame = null;
                wrapper.scrollTop = clampedTarget;
            }
        };

        scrollAnimationFrame = requestAnimationFrame(step);
    }

    function applyClickHighlight(element, options = {}) {
        if (!element || !settings.highlightClickEnabled) return;
        const durationCandidate = options.duration !== undefined ? options.duration : settings.highlightClickDuration;
        const duration = (typeof durationCandidate === 'number' && durationCandidate > 0 && durationCandidate <= 60000)
            ? durationCandidate
            : defaultSettings.highlightClickDuration;
        if (element.__clickHighlightTimer) {
            clearTimeout(element.__clickHighlightTimer);
            element.classList.remove('click-highlight');
            element.__clickHighlightTimer = null;
        }
        element.classList.add('click-highlight');
        element.__clickHighlightTimer = setTimeout(() => {
            element.classList.remove('click-highlight');
            element.__clickHighlightTimer = null;
        }, duration);
    }

    function focusLineElement(targetIndex, options = {}) {
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= subtitleElements.length) return;
        const element = options.element || subtitleElements[targetIndex];
        if (!element) return;
        const shouldScroll = options.scroll !== false;
        const blockMode = options.scrollBlock || 'center';
        if (shouldScroll) {
            const fallbackTop = element.offsetTop - ((textDisplayWrapperEl && blockMode === 'center') ? (textDisplayWrapperEl.clientHeight / 2) : 0);
            try {
                element.scrollIntoView({ behavior: 'smooth', block: blockMode });
            } catch (err) {
                smoothScrollWrapperTo(fallbackTop);
            }
        }
        if (options.highlight !== false) {
            applyClickHighlight(element, options.highlightOptions || {});
        }
        attachSharedProgressToIndex(targetIndex);
        paintLine(targetIndex, true);
        schedulePaintVisible();
    }

    function updateJumpControlsState(enabled) {
        const isEnabled = !!enabled;
        if (jumpSettingsWrapper && jumpSettingsWrapper.length) {
            jumpSettingsWrapper.toggle(isEnabled);
        }
        if (jumpPreRollInput && jumpPreRollInput.length) {
            jumpPreRollInput.prop('disabled', !isEnabled);
        }
        if (jumpPreventWhilePlayingCheckbox && jumpPreventWhilePlayingCheckbox.length) {
            jumpPreventWhilePlayingCheckbox.prop('disabled', !isEnabled);
        }
        if (jumpPreventWhileRecordingCheckbox && jumpPreventWhileRecordingCheckbox.length) {
            jumpPreventWhileRecordingCheckbox.prop('disabled', !isEnabled);
        }
        scheduleSettingsTileReflow();
    }

    function getActiveJumpPreRollSeconds() {
        const candidate = settings && typeof settings.jumpPreRollSeconds !== 'undefined'
            ? settings.jumpPreRollSeconds
            : defaultSettings.jumpPreRollSeconds;
        return sanitizeJumpPreRollSeconds(candidate, defaultSettings.jumpPreRollSeconds);
    }

    function shouldBlockJumpDueToTransport() {
        if (!settings.jumpOnClickEnabled) return true;
        if (settings.jumpPreventWhileRecording && isRecordingState(transportPlayState)) {
            return true;
        }
        if (settings.jumpPreventWhilePlaying && isPlayingState(transportPlayState)) {
            return true;
        }
        return false;
    }

    function sendNativeTransportJump(targetSeconds, options = {}) {
        if (typeof wwr_req !== 'function') {
            return false;
        }
        if (!wwr_is_enabled) {
            wwr_is_enabled = true;
        }
        const numeric = Number(targetSeconds);
        if (!Number.isFinite(numeric)) {
            return false;
        }
        const clampedSeconds = Math.max(0, numeric);
        // Round to 6 decimals which matches REAPER web expectations.
        const formatted = clampedSeconds.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
        try {
            wwr_req(`SET/POS/${formatted}`);
            if (options.requestTransportRefresh) {
                wwr_req('TRANSPORT');
            }
            return true;
        } catch (err) {
            console.error('[Prompter][jump] native SET/POS failed', err);
            return false;
        }
    }

    function requestJumpToLine(lineIndex, startSeconds) {
        if (!settings.jumpOnClickEnabled) {
            return false;
        }
        if (!wwr_is_enabled || !eventBus || typeof eventBus.emitToBackend !== 'function') {
            console.debug('[Prompter][jump] backend event bus unavailable, will attempt native command if possible');
        }
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - lastJumpRequestAt < JUMP_REQUEST_DEBOUNCE_MS) {
            return false;
        }
        lastJumpRequestAt = now;
        const startValue = Number(startSeconds);
        if (!Number.isFinite(startValue) || startValue < 0) {
            return false;
        }
        const preRollSeconds = getActiveJumpPreRollSeconds();
        const targetSeconds = Math.max(0, startValue - preRollSeconds);
        const payload = {
            position_ms: Math.round(targetSeconds * 1000),
            line_index: lineIndex,
            line_start_ms: Math.round(startValue * 1000),
            pre_roll_ms: Math.round(preRollSeconds * 1000),
            source: 'click'
        };
        const nativeEmitted = sendNativeTransportJump(targetSeconds, { requestTransportRefresh: true });
        if (nativeEmitted) {
            return true;
        }

        if (!eventBus || typeof eventBus.emitToBackend !== 'function') {
            return false;
        }
        try {
            eventBus.emitToBackend('time:jump', payload);
            return true;
        } catch (err) {
            console.error('[Prompter][jump] emitToBackend failed', err);
            return false;
        }
    }

    function onSubtitleContainerClick(event) {
        try {
            if (!settings.jumpOnClickEnabled) {
                return;
            }
            if (event && event.button !== undefined && event.button !== 0) {
                return;
            }
            if (event && (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)) {
                return;
            }
            const selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
            if (selection && typeof selection.toString === 'function' && selection.toString().trim().length > 0) {
                return;
            }
            const container = event && event.currentTarget ? event.currentTarget : null;
            if (!container || !container.dataset) {
                return;
            }
            const index = Number(container.dataset.index);
            if (!Number.isInteger(index) || index < 0 || index >= subtitleData.length) {
                return;
            }
            const line = subtitleData[index];
            if (!line || typeof line.start_time !== 'number') {
                return;
            }
            if (shouldBlockJumpDueToTransport()) {
                console.debug('[Prompter][jump] suppressed by transport guard', {
                    playState: transportPlayState,
                    preventPlay: settings.jumpPreventWhilePlaying,
                    preventRec: settings.jumpPreventWhileRecording
                });
                return;
            }
            const emitted = requestJumpToLine(index, line.start_time);
            focusLineElement(index, { element: container });
            if (!emitted) {
                console.debug('[Prompter][jump] request not emitted (backend unavailable or throttled)');
            }
        } catch (err) {
            console.error('[Prompter][jump] subtitle click handler error', err);
        }
    }

    function detachSharedProgress() {
        if (sharedProgressContainer.parentNode) {
            if (sharedProgressContainer.parentNode.classList) {
                sharedProgressContainer.parentNode.classList.remove('has-progress');
            }
            sharedProgressContainer.parentNode.removeChild(sharedProgressContainer);
        }
        sharedProgressHost = null;
        sharedProgressIndex = -1;
        if (sharedProgressValue !== 0) {
            sharedProgressBar.style.transform = 'scaleX(0)';
        }
        sharedProgressValue = 0;
    }

    function resetTransportProgress() {
        transportProgressValue = 0;
        if (transportProgressBarEl) {
            transportProgressBarEl.style.transform = 'scaleX(0)';
        }
        if (transportProgressContainer && transportProgressContainer.length) {
            transportProgressContainer.removeClass('is-active');
        }
    }

    function clearTimecodeProgress() {
        if (activeTimecodeProgressIndex === -1) {
            timecodeProgressValue = 0;
            return;
        }
        const wrapper = subtitleTimeElements[activeTimecodeProgressIndex] || null;
        const progressEl = subtitleTimeProgressElements[activeTimecodeProgressIndex] || null;
        if (wrapper && wrapper.classList) {
            wrapper.classList.remove('has-time-progress');
        }
        if (progressEl) {
            progressEl.style.transform = 'scaleX(0)';
        }
        activeTimecodeProgressIndex = -1;
        timecodeProgressValue = 0;
    }

    function setTimecodeProgress(index, fraction) {
        if (!Number.isInteger(index) || index < 0 || index >= subtitleTimeElements.length) {
            clearTimecodeProgress();
            return;
        }
        const wrapper = subtitleTimeElements[index];
        const progressEl = subtitleTimeProgressElements[index];
        if (!wrapper || !progressEl) {
            clearTimecodeProgress();
            return;
        }
        if (activeTimecodeProgressIndex !== index) {
            clearTimecodeProgress();
            activeTimecodeProgressIndex = index;
            timecodeProgressValue = -1;
            if (wrapper.classList) {
                wrapper.classList.add('has-time-progress');
            }
        }
        const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
        if (Math.abs(clamped - timecodeProgressValue) < 0.001) {
            return;
        }
        timecodeProgressValue = clamped;
        progressEl.style.transform = `scaleX(${clamped})`;
    }

    function setTransportProgress(fraction) {
        if (!transportProgressBarEl) return;
        const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
        if (Math.abs(clamped - transportProgressValue) < 0.001) return;
        transportProgressValue = clamped;
        transportProgressBarEl.style.transform = `scaleX(${clamped})`;
        if (transportProgressContainer && transportProgressContainer.length) {
            transportProgressContainer.toggleClass('is-active', clamped > 0);
        }
    }

    function attachSharedProgressToIndex(index) {
        if (index < 0 || index >= subtitleContentElements.length) { detachSharedProgress(); return; }
        const contentEl = subtitleContentElements[index];
        if (!contentEl) { detachSharedProgress(); return; }
        if (sharedProgressIndex === index && sharedProgressHost === contentEl) return;
        detachSharedProgress();
        contentEl.appendChild(sharedProgressContainer);
        contentEl.classList.add('has-progress');
        sharedProgressHost = contentEl;
        sharedProgressIndex = index;
        sharedProgressValue = -1;
    }

    function extractLeadingRole(rawText, trimInline) {
        if (!rawText || rawText.length < 3) return null;
        if (rawText.charCodeAt(0) !== 91) return null; // '['
        const len = rawText.length;
        let idx = 1;
        while (idx < len && rawText.charCodeAt(idx) !== 93) { // ']'
            idx++;
        }
        if (idx >= len) return null;
        const role = rawText.slice(1, idx);
        if (!trimInline) {
            return { role, text: rawText };
        }
        let next = idx + 1;
        while (next < len) {
            const code = rawText.charCodeAt(next);
            if (code === 32 || code === 9) { // space or tab
                next++;
                continue;
            }
            break;
        }
        return { role, text: next < len ? rawText.slice(next) : '' };
    }

    function getCachedRoleParts(line, rawText) {
        if (!line || typeof rawText !== 'string') return null;
        const cache = line.__cachedRoleParts;
        if (cache && cache.raw === rawText) {
            return cache.hasRole ? cache : null;
        }
        const extracted = extractLeadingRole(rawText, true);
        if (!extracted) {
            line.__cachedRoleParts = { raw: rawText, role: '', textTrimmed: rawText, textInline: rawText, hasRole: false };
            return null;
        }
        const nextCache = {
            raw: rawText,
            role: extracted.role,
            textTrimmed: extracted.text,
            textInline: rawText,
            hasRole: true
        };
        line.__cachedRoleParts = nextCache;
        return nextCache;
    }

    function disconnectVisibilityObserver() {
        if (subtitleObserver) {
            subtitleObserver.disconnect();
            subtitleObserver = null;
        }
    }

    function resetVisibilityTracking() {
        visibleIndices.clear();
        visibleRangeStart = 0;
        visibleRangeEnd = -1;
        lastVisibleStart = 0;
        lastVisibleEnd = 0;
    }

    function setupVisibilityObserver() {
        resetVisibilityTracking();
        disconnectVisibilityObserver();
        if (!textDisplayWrapperEl || !subtitleElements.length || typeof IntersectionObserver === 'undefined') {
            if (supportsInert) {
                subtitleElements.forEach(el => {
                    if (el) el.inert = false;
                });
            }
            visibleRangeStart = 0;
            visibleRangeEnd = subtitleElements.length ? subtitleElements.length - 1 : -1;
            schedulePaintVisible({ immediate: true });
            return;
        }
        subtitleObserver = new IntersectionObserver(handleSubtitleIntersection, {
            root: textDisplayWrapperEl,
            threshold: [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.99, 1]
        });
        subtitleElements.forEach((el, idx) => {
            if (!el) return;
            el.dataset.frzzIndex = String(idx);
            if (supportsInert) {
                el.inert = false;
            }
            subtitleObserver.observe(el);
        });
        visibleRangeStart = 0;
        visibleRangeEnd = -1;
    }

    function handleSubtitleIntersection(entries) {
        let changed = false;
        for (const entry of entries) {
            const target = entry.target;
            const idx = target && target.dataset ? parseInt(target.dataset.frzzIndex, 10) : NaN;
            if (!Number.isInteger(idx)) continue;
            const isVisible = entry.isIntersecting && entry.intersectionRatio > 0;
            // Keep nodes searchable/focusable even when outside viewport; avoid toggling inert
            // which breaks browser find-in-page for off-screen content.
            if (isVisible) {
                if (!visibleIndices.has(idx)) {
                    visibleIndices.add(idx);
                    changed = true;
                }
                paintLine(idx);
            } else if (visibleIndices.delete(idx)) {
                changed = true;
                clearLinePaint(idx);
            }
        }
        if (changed) {
            recomputeVisibleRangeFromVisibleSet();
        }
    }

    function recomputeVisibleRangeFromVisibleSet() {
        if (!visibleIndices.size) {
            visibleRangeStart = 0;
            visibleRangeEnd = -1;
        } else {
            let min = Infinity;
            let max = -1;
            visibleIndices.forEach(idx => {
                if (idx < min) min = idx;
                if (idx > max) max = idx;
            });
            visibleRangeStart = Math.max(0, min);
            visibleRangeEnd = Math.min(subtitleElements.length - 1, max);
        }
        schedulePaintVisible();
    }

    function getLineTimingBounds(index) {
        if (!Array.isArray(subtitleData) || !Number.isInteger(index) || index < 0 || index >= subtitleData.length) {
            return null;
        }
        const line = subtitleData[index];
        if (!line) return null;
        const start = Number.isFinite(line.start_time) ? line.start_time : null;
        let end = Number.isFinite(line.end_time) ? line.end_time : null;
        if (!Number.isFinite(end)) {
            const next = subtitleData[index + 1];
            if (next && Number.isFinite(next.start_time)) {
                end = next.start_time;
            }
        }
        if (start === null && end === null) {
            return null;
        }
        return { start, end };
    }

    function computeTimelineDurationConstraint(index, currentTime, isLookahead) {
        let referenceTime = Number.isFinite(currentTime) ? currentTime : null;
        if (referenceTime === null && Number.isFinite(lastPlaybackTimeSeconds)) {
            referenceTime = lastPlaybackTimeSeconds;
        }
        if (referenceTime === null) {
            return null;
        }
        const bounds = getLineTimingBounds(index);
        if (!bounds) {
            return null;
        }
        const { start, end } = bounds;
        let budgetMs = null;
        if (isLookahead && Number.isFinite(start)) {
            const millisUntilStart = Math.max(0, (start - referenceTime) * 1000);
            if (millisUntilStart > 0) {
                const lookaheadBudget = millisUntilStart * TIMELINE_LOOKAHEAD_COMPLETION_RATIO;
                budgetMs = Math.max(MIN_TIMELINE_SCROLL_MS, lookaheadBudget);
            }
        }
        if (Number.isFinite(end)) {
            const millisUntilEnd = Math.max(0, (end - referenceTime) * 1000);
            if (millisUntilEnd > 0) {
                const activeBudget = millisUntilEnd * TIMELINE_ACTIVE_COMPLETION_RATIO;
                budgetMs = budgetMs === null
                    ? Math.max(MIN_TIMELINE_SCROLL_MS, activeBudget)
                    : Math.min(budgetMs, Math.max(MIN_TIMELINE_SCROLL_MS, activeBudget));
            }
        }
        if (budgetMs === null) {
            return null;
        }
        return clampNumber(Math.round(budgetMs), MIN_TIMELINE_SCROLL_MS, MAX_AUTO_SCROLL_ANIMATION_MS);
    }

    function computeSubtReaderInertiaEase(progress) {
        const clamped = clampNumber(progress, 0, 1);
        if (clamped <= 0 || clamped >= 1) {
            return clamped;
        }
        const eased = 0.5 + 0.5 * Math.cos((Math.PI * clamped) - Math.PI);
        return eased * eased;
    }

    function resetSubtReaderLineState() {
        subtReaderInertiaState.activeIndex = -1;
        subtReaderInertiaState.lastTarget = null;
        subtReaderInertiaState.lastRawProgress = 0;
    }

    function resetSubtReaderInertiaState() {
        resetSubtReaderLineState();
    }

    function computeSubtReaderInertiaTarget(index, currentTime) {
        if (!settings.autoScroll || !Number.isFinite(currentTime)) return null;
        if (!Array.isArray(subtitleData) || index < 0 || index >= subtitleData.length - 1) return null;
        const activeMode = sanitizeAutoScrollMode(settings.autoScrollMode, defaultSettings.autoScrollMode);
        if (activeMode !== 'line') return null;
        if (settings.autoScrollDynamicSpeedEnabled === false) return null;
        const wrapper = textDisplayWrapperEl || textDisplayWrapper[0] || null;
        if (!wrapper) return null;
        const currentLine = subtitleData[index];
        const nextLine = subtitleData[index + 1];
        if (!currentLine || !nextLine) return null;
        const timeUntilNext = nextLine.start_time - currentTime;
        if (!Number.isFinite(timeUntilNext) || timeUntilNext <= 0) return null;
        if (timeUntilNext > SUBTREADER_INERTIA_WINDOW_SECONDS) return null;
        if (wrapper.clientHeight <= 0) return null;

        const basePlan = computeAutoScrollPlan(index, { force: true, currentTime });
        const nextPlan = computeAutoScrollPlan(index + 1, { force: true, currentTime });
        if (!basePlan || !nextPlan) return null;

        const baseTarget = basePlan.targetScrollTop;
        const nextTarget = nextPlan.targetScrollTop;
        if (!Number.isFinite(baseTarget) || !Number.isFinite(nextTarget)) return null;

        const targetDelta = nextTarget - baseTarget;
        if (Math.abs(targetDelta) < SUBTREADER_INERTIA_MIN_DISTANCE_PX) return null;

        const rawProgress = clampNumber(1 - (timeUntilNext / SUBTREADER_INERTIA_WINDOW_SECONDS), 0, 1);
        const easedProgress = computeSubtReaderInertiaEase(rawProgress);
        const interpolatedTarget = baseTarget + (targetDelta * easedProgress);
        const maxScrollTop = Math.max(0, wrapper.scrollHeight - wrapper.clientHeight);

        return {
            target: clampNumber(interpolatedTarget, 0, maxScrollTop),
            rawProgress,
            easedProgress
        };
    }

    function applySubtReaderInertia(index, currentTime) {
        if (!settings.autoScroll || !Number.isFinite(currentTime)) {
            if (subtReaderInertiaState.activeIndex !== -1) {
                resetSubtReaderLineState();
            }
            return;
        }
        const activeMode = sanitizeAutoScrollMode(settings.autoScrollMode, defaultSettings.autoScrollMode);
        if (activeMode !== 'line') {
            if (subtReaderInertiaState.activeIndex !== -1) {
                resetSubtReaderLineState();
            }
            return;
        }
        if (settings.autoScrollDynamicSpeedEnabled === false) {
            if (subtReaderInertiaState.activeIndex !== -1) {
                resetSubtReaderLineState();
            }
            return;
        }
        if (scrollAnimationFrame) {
            return;
        }
        const wrapper = textDisplayWrapperEl || textDisplayWrapper[0] || null;
        if (!wrapper) return;
        const inertiaResult = computeSubtReaderInertiaTarget(index, currentTime);
        if (!inertiaResult) {
            if (subtReaderInertiaState.activeIndex !== -1) {
                resetSubtReaderLineState();
            }
            return;
        }
        const delta = inertiaResult.target - wrapper.scrollTop;
        if (Math.abs(delta) < SUBTREADER_INERTIA_MIN_DISTANCE_PX) {
            subtReaderInertiaState.activeIndex = index;
            subtReaderInertiaState.lastTarget = inertiaResult.target;
            subtReaderInertiaState.lastRawProgress = inertiaResult.rawProgress;
            return;
        }
        wrapper.scrollTop = inertiaResult.target;
        subtReaderInertiaState.activeIndex = index;
        subtReaderInertiaState.lastTarget = inertiaResult.target;
        subtReaderInertiaState.lastRawProgress = inertiaResult.rawProgress;
    }

    // Measure target scroll position ahead of DOM mutations to avoid layout thrashing.
    function computeAutoScrollPlan(targetIndex, options = {}) {
        if (typeof targetIndex !== 'number' || targetIndex < 0 || targetIndex >= subtitleElements.length) {
            return undefined;
        }
        const wrapper = textDisplayWrapperEl || textDisplayWrapper[0] || null;
        if (!wrapper) return undefined;
        const targetNode = subtitleElements[targetIndex];
        if (!targetNode) return undefined;
        const wrapperHeight = wrapper.clientHeight || 0;
        if (!wrapperHeight) return undefined;
        const autoScrollMode = sanitizeAutoScrollMode(settings.autoScrollMode, defaultSettings.autoScrollMode);
        const rawTopPercent = sanitizeAutoScrollPercent(
            settings.autoScrollWindowTopPercent,
            defaultSettings.autoScrollWindowTopPercent,
            0,
            90
        );
        const rawBottomPercent = sanitizeAutoScrollPercent(
            settings.autoScrollWindowBottomPercent,
            defaultSettings.autoScrollWindowBottomPercent,
            rawTopPercent + MIN_AUTO_SCROLL_WINDOW_GAP,
            100
        );
        const windowTopPercent = rawTopPercent;
        const windowBottomPercent = rawBottomPercent <= windowTopPercent + MIN_AUTO_SCROLL_WINDOW_GAP
            ? Math.min(100, windowTopPercent + MIN_AUTO_SCROLL_WINDOW_GAP)
            : rawBottomPercent;
        const windowTopFraction = clampNumber(windowTopPercent / 100, 0, 0.95);
        const windowBottomFraction = clampNumber(windowBottomPercent / 100, windowTopFraction + 0.01, 1);
        const targetOffsetTop = typeof targetNode.offsetTop === 'number' ? targetNode.offsetTop : 0;
        const currentScrollTop = wrapper.scrollTop;
        const relativeTop = targetOffsetTop - currentScrollTop;
        const elementHeight = Math.max(targetNode.offsetHeight || 1, 1);
        const topThreshold = wrapperHeight * windowTopFraction;
        const bottomThreshold = (wrapperHeight * windowBottomFraction) - elementHeight;
        const currentTimeSeconds = Number.isFinite(options.currentTime) ? options.currentTime : null;
        const lineAnchorPercent = sanitizeAutoScrollPercent(
            settings.autoScrollLineAnchorPercent,
            defaultSettings.autoScrollLineAnchorPercent,
            0,
            100
        );
        let anchorFraction = windowTopFraction;
        if (autoScrollMode === 'line') {
            anchorFraction = clampNumber(lineAnchorPercent / 100, 0.05, 0.95);
        }
        const lookaheadMode = options.lookahead === true;
        const lookaheadOffsetPx = lookaheadMode
            ? Math.min(elementHeight * 0.6, wrapperHeight * 0.25)
            : 0;
        const dynamicSpeedEnabled = settings.autoScrollDynamicSpeedEnabled !== false;
        const speedFactor = getScrollSpeedMultiplier();
        const anchorTargetRelativeTop = (wrapperHeight * anchorFraction) + lookaheadOffsetPx;
        const forceScroll = options.force === true;
        if (!forceScroll) {
            if (autoScrollMode === 'line') {
                const anchorTolerancePx = Math.max(12, Math.min(elementHeight * 0.5, wrapperHeight * 0.1));
                const currentCenter = relativeTop + (elementHeight * 0.5);
                if (Math.abs(currentCenter - anchorTargetRelativeTop) <= anchorTolerancePx) {
                    return null;
                }
            } else if (relativeTop >= topThreshold && relativeTop <= bottomThreshold) {
                return null;
            }
        }
        let desiredScrollTop;
        if (autoScrollMode === 'line') {
            desiredScrollTop = targetOffsetTop - anchorTargetRelativeTop + (elementHeight * 0.5);
        } else {
            desiredScrollTop = targetOffsetTop - anchorTargetRelativeTop;
        }
        const maxScrollTop = Math.max(0, wrapper.scrollHeight - wrapperHeight);
        const clampedTarget = clampNumber(desiredScrollTop, 0, maxScrollTop);
        const distance = Math.abs(clampedTarget - currentScrollTop);
        if (!forceScroll && distance < 0.5) {
            return null;
        }
        let durationMs;
        let easingFn;
        if (autoScrollMode === 'line') {
            const baseMs = sanitizeAutoScrollLineEasingBaseMs(settings.autoScrollLineEasingBaseMs, defaultSettings.autoScrollLineEasingBaseMs);
            const perPixel = sanitizeAutoScrollLineEasingPerPixel(settings.autoScrollLineEasingPerPixel, defaultSettings.autoScrollLineEasingPerPixel);
            const maxMs = sanitizeAutoScrollLineEasingMaxMs(settings.autoScrollLineEasingMaxMs, defaultSettings.autoScrollLineEasingMaxMs);
            if (dynamicSpeedEnabled) {
                const adjustedBase = Math.max(40, baseMs / speedFactor);
                const adjustedPerPixel = Math.max(0, perPixel / speedFactor);
                const computed = adjustedBase + (Math.abs(distance) * adjustedPerPixel);
                durationMs = clampNumber(Math.round(computed), 60, maxMs);
                if (lookaheadMode) {
                    durationMs = Math.min(durationMs, Math.max(120, adjustedBase));
                }
            } else {
                const staticDuration = Math.max(60, DEFAULT_LINE_STATIC_DURATION_MS / speedFactor);
                durationMs = clampNumber(Math.round(staticDuration), 60, maxMs);
            }
            easingFn = easeInOutCubic;
        } else {
            if (dynamicSpeedEnabled) {
                const distanceComponent = Math.min(1400, distance * PAGE_DYNAMIC_DISTANCE_COEFFICIENT);
                const baseDuration = Math.max(PAGE_DYNAMIC_BASE_DURATION_MS, distanceComponent);
                let computedDuration = clampNumber(
                    Math.round(baseDuration / speedFactor),
                    80,
                    MAX_AUTO_SCROLL_ANIMATION_MS
                );
                if (lookaheadMode) {
                    const cappedBase = Math.max(220, PAGE_DYNAMIC_BASE_DURATION_MS / speedFactor);
                    computedDuration = Math.min(computedDuration, cappedBase);
                }
                durationMs = computedDuration;
            } else {
                durationMs = clampNumber(
                    Math.round(DEFAULT_PAGE_STATIC_DURATION_MS / speedFactor),
                    80,
                    MAX_AUTO_SCROLL_ANIMATION_MS
                );
            }
            easingFn = easeOutCubic;
        }
        const timelineConstraintMs = computeTimelineDurationConstraint(targetIndex, currentTimeSeconds, lookaheadMode);
        if (timelineConstraintMs !== null && Number.isFinite(durationMs)) {
            durationMs = Math.min(durationMs, timelineConstraintMs);
            durationMs = Math.max(MIN_TIMELINE_SCROLL_MS, durationMs);
        }
        return {
            targetScrollTop: clampedTarget,
            durationMs,
            easing: easingFn,
            mode: autoScrollMode,
            distance,
            lookahead: lookaheadMode
        };
    }

    function autoScrollToIndex(targetIndex, precomputedPlan) {
        if (typeof targetIndex !== 'number' || targetIndex < 0 || targetIndex >= subtitleElements.length) {
            return;
        }
        const plan = (typeof precomputedPlan === 'undefined') ? computeAutoScrollPlan(targetIndex) : precomputedPlan;
        if (!plan) {
            return;
        }
        smoothScrollWrapperTo(plan.targetScrollTop, {
            durationMs: plan.durationMs,
            easing: plan.easing
        });
    }

    function invalidateAllLinePaint(options = {}) {
        paintGeneration = (paintGeneration + 1) >>> 0;
        if (options.resetBounds) {
            lastVisibleStart = 0;
            lastVisibleEnd = 0;
        }
        if (options.schedule !== false) {
            schedulePaintVisible(options.immediate ? { immediate: true } : undefined);
        }
    }


    function schedulePaintVisible(options) {
        if (!subtitleElements.length) return;
        const immediate = options && options.immediate;
        if (immediate) {
            paintVisibleRange();
            return;
        }
        if (paintScheduled) return;
        paintScheduled = true;
        requestAnimationFrame(() => {
            paintScheduled = false;
            paintVisibleRange();
        });
    }

    function paintVisibleRange() {
        if (!subtitleElements.length) return;
        const startIndex = visibleRangeStart;
        const endIndex = visibleRangeEnd;
        if (endIndex < startIndex) return;
        paintRange(startIndex, endIndex);
        lastVisibleStart = startIndex;
        lastVisibleEnd = endIndex;
    }

    function paintRange(start, end) {
        if (start > end) return;
        for (let i = start; i <= end; i++) {
            paintLine(i);
        }
    }

    function paintLine(index, force = false) {
        if (index < 0 || index >= subtitleElements.length) return;
        if (!force && subtitlePaintStates[index] === paintGeneration) return;
        subtitlePaintStates[index] = paintGeneration;

        if (!subtitleStyleMetadata || index >= subtitleStyleMetadata.length) return;
        const meta = subtitleStyleMetadata[index];
        if (!meta) return;

        const container = subtitleElements[index];
        if (meta.checkerboardClass && container) {
            if (force || !meta.checkerboardApplied || !container.classList.contains(meta.checkerboardClass)) {
                container.classList.add(meta.checkerboardClass);
            }
            meta.checkerboardApplied = true;
        }

        const colorInfo = meta.colorInfo;
        if (!colorInfo) return;

        if (!force && meta.colorApplied) return;

        const baseColor = colorInfo.color;
        const useLightened = !!settings.roleFontColorEnabled;
        const lightened = useLightened ? (getLightenedColorCached(baseColor, true) || null) : null;

        const roleEl = colorInfo.roleElement;
        if (roleEl) {
            const bgColor = lightened ? lightened.bg : baseColor;
            if (roleEl.style.backgroundColor !== bgColor) {
                roleEl.style.backgroundColor = bgColor;
            }
            const desiredText = useLightened
                ? ((lightened && lightened.text) ? lightened.text : '#000000')
                : (isColorLight(baseColor) ? '#000000' : '#ffffff');
            if (roleEl.style.color !== desiredText) {
                roleEl.style.color = desiredText;
            }
            if (!roleEl.classList.contains('role-colored')) {
                roleEl.classList.add('role-colored');
            }
        }

        const columnSwatch = colorInfo.columnSwatch;
        if (columnSwatch) {
            const desiredBg = lightened ? lightened.bg : baseColor;
            if (columnSwatch.style.backgroundColor !== desiredBg) {
                columnSwatch.style.backgroundColor = desiredBg;
            }
        }

        const inlineSwatch = colorInfo.inlineSwatch;
        if (inlineSwatch) {
            const desiredBg = lightened ? lightened.bg : baseColor;
            if (inlineSwatch.style.backgroundColor !== desiredBg) {
                inlineSwatch.style.backgroundColor = desiredBg;
            }
        }

        meta.colorApplied = true;
    }

    function clearLinePaint(index) {
        if (index < 0 || index >= subtitlePaintStates.length) return;
        subtitlePaintStates[index] = -1;
        if (!subtitleStyleMetadata || index >= subtitleStyleMetadata.length) return;
        const meta = subtitleStyleMetadata[index];
        if (!meta) return;
        const container = subtitleElements[index];
        if (container && meta.checkerboardClass && container.classList.contains(meta.checkerboardClass)) {
            container.classList.remove(meta.checkerboardClass);
        }
        meta.checkerboardApplied = false;

        const colorInfo = meta.colorInfo;
        if (colorInfo) {
            const roleEl = colorInfo.roleElement;
            if (roleEl) {
                if (roleEl.style.backgroundColor) roleEl.style.backgroundColor = '';
                if (roleEl.style.color) roleEl.style.color = '';
                if (roleEl.classList.contains('role-colored')) {
                    roleEl.classList.remove('role-colored');
                }
            }
            const columnSwatch = colorInfo.columnSwatch;
            if (columnSwatch && columnSwatch.style.backgroundColor) {
                columnSwatch.style.backgroundColor = '';
            }
            const inlineSwatch = colorInfo.inlineSwatch;
            if (inlineSwatch && inlineSwatch.style.backgroundColor) {
                inlineSwatch.style.backgroundColor = '';
            }
            meta.colorApplied = false;
        }
    }

    function handleWrapperScroll() {
        schedulePaintVisible();
    }

    if (textDisplayWrapperEl) {
        textDisplayWrapperEl.addEventListener('scroll', handleWrapperScroll, { passive: true });
    }
    window.addEventListener('resize', () => {
        schedulePaintVisible();
        if (currentLineIndex !== -1 && settings.autoScroll) {
            requestAnimationFrame(() => autoScrollToIndex(currentLineIndex));
        }
    }, { passive: true });
    
    function getScrollSpeedCaption(speed) { if (speed === 1) return "Я БЛИТЦ! СКОРОСТЬ БЕЗ ГРАНИЦ"; if (speed >= 10 && speed <= 40) return "Ой, что-то меня укачало"; if (speed >= 50 && speed <= 70) return "Да не укачивает меня, просто резко встал"; if (speed >= 80 && speed <= 100) return "У меня хороший вестибу-бу-булярный аппарат"; if (speed >= 110 && speed <= 150) return "Это по вашему скорость?"; if (speed >= 160 && speed <= 200) return "АМЕРИКАНСКИЕ ГОРКИ! Ю-ХУУУ!!!"; if (speed === 500) return "Вы Борис?"; return ""; }

    function getScrollSpeedMultiplier() {
        const rawSpeed = clampNumber(settings.scrollSpeed || defaultSettings.scrollSpeed, 1, 1000);
        const multiplier = (rawSpeed / 100) * SPEED_BASELINE_FACTOR;
        return Math.max(MIN_SPEED_MULTIPLIER, Math.min(MAX_SPEED_MULTIPLIER, multiplier));
    }

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

    function renderTitle() {
        console.debug('[Prompter][title] renderTitle', { titleMode: settings.titleMode, currentProjectName });
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
        scheduleSettingsTileReflow();
    }

    function normalizeHighlightFeatureValues(source) {
        const raw = source || {};
        return {
            highlightCurrentEnabled: raw.highlightCurrentEnabled !== false,
            highlightPreviousEnabled: raw.highlightPreviousEnabled !== false,
            highlightPauseEnabled: raw.highlightPauseEnabled !== false,
            progressBarEnabled: raw.progressBarEnabled !== false,
            progressBarMode: sanitizeProgressBarMode(raw.progressBarMode, defaultSettings.progressBarMode)
        };
    }

    function applyHighlightUIStateFromValues(values, options = {}) {
        const normalized = normalizeHighlightFeatureValues(values);
        const syncControls = options.syncControls !== false;
        if (syncControls) {
            if (highlightCurrentEnabledCheckbox.length) {
                highlightCurrentEnabledCheckbox.prop('checked', normalized.highlightCurrentEnabled);
            }
            if (highlightPreviousEnabledCheckbox.length) {
                highlightPreviousEnabledCheckbox.prop('checked', normalized.highlightPreviousEnabled);
            }
            if (highlightPauseEnabledCheckbox.length) {
                highlightPauseEnabledCheckbox.prop('checked', normalized.highlightPauseEnabled);
            }
            if (progressBarEnabledCheckbox.length) {
                progressBarEnabledCheckbox.prop('checked', normalized.progressBarEnabled);
            }
            if (progressBarModeSelect.length) {
                progressBarModeSelect.val(normalized.progressBarMode);
            }
        }

        if (highlightCurrentOptions && highlightCurrentOptions.length) {
            highlightCurrentOptions.toggle(normalized.highlightCurrentEnabled);
        }
        if (highlightPreviousOptions && highlightPreviousOptions.length) {
            highlightPreviousOptions.toggle(normalized.highlightPreviousEnabled);
        }
        if (highlightPreviousTile && highlightPreviousTile.length) {
            highlightPreviousTile.removeClass('is-disabled');
            highlightPreviousTile.find('input, select, button, textarea').each(function() {
                const $el = $(this);
                if ($el.is('#highlight-previous-enabled')) {
                    return;
                }
                const shouldEnable = normalized.highlightPreviousEnabled;
                $el.prop('disabled', !shouldEnable);
                if (typeof $el.data === 'function' && $el.data('spectrum')) {
                    $el.spectrum(shouldEnable ? 'enable' : 'disable');
                }
            });
        }
        if (highlightProgressOptions && highlightProgressOptions.length) {
            highlightProgressOptions.toggle(normalized.progressBarEnabled);
        }
        if (progressBarModeWrapper && progressBarModeWrapper.length) {
            progressBarModeWrapper.toggle(normalized.progressBarEnabled);
        }
        if (progressBarModeSelect && progressBarModeSelect.length) {
            progressBarModeSelect.prop('disabled', !normalized.progressBarEnabled);
        }
        if (progressBarColorInput && progressBarColorInput.length) {
            progressBarColorInput.prop('disabled', !normalized.progressBarEnabled);
            if (typeof progressBarColorInput.data === 'function' && progressBarColorInput.data('spectrum')) {
                progressBarColorInput.spectrum(normalized.progressBarEnabled ? 'enable' : 'disable');
            }
            const copyButton = progressBarColorInput.closest('.input-with-button').find('.copy-color-btn');
            if (copyButton && copyButton.length) {
                copyButton.prop('disabled', !normalized.progressBarEnabled);
            }
        }
        if ((!normalized.highlightPreviousEnabled) || (normalized.highlightPauseEnabled && normalized.highlightCurrentEnabled)) {
            if (subtitleElements && subtitleElements.length) {
                subtitleElements.forEach(el => {
                    if (el && el.classList) {
                        el.classList.remove('previous-line');
                    }
                });
            }
            clearPreviousLineHighlight();
        }
        scheduleSettingsTileReflow();
        return normalized;
    }

    function getHighlightFeatureValuesFromUI() {
        return {
            highlightCurrentEnabled: !highlightCurrentEnabledCheckbox.length || highlightCurrentEnabledCheckbox.is(':checked'),
            highlightPreviousEnabled: !highlightPreviousEnabledCheckbox.length || highlightPreviousEnabledCheckbox.is(':checked'),
            highlightPauseEnabled: !highlightPauseEnabledCheckbox.length || highlightPauseEnabledCheckbox.is(':checked'),
            progressBarEnabled: !progressBarEnabledCheckbox.length || progressBarEnabledCheckbox.is(':checked'),
            progressBarMode: progressBarModeSelect.length ? progressBarModeSelect.val() : defaultSettings.progressBarMode
        };
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

    function getAutoScrollTrackColors() {
        if (typeof document === 'undefined' || !document.body) {
            return { base: '#555', active: '#4aa8ff' };
        }
        const isLight = document.body.classList.contains('light-theme');
        return isLight
            ? { base: '#c9c9c9', active: '#0d66d0' }
            : { base: '#555', active: '#4aa8ff' };
    }

    function updateAutoScrollWindowTrackGradient(topPercent, bottomPercent) {
        if (!autoScrollWindowTrack.length) return;
        const colors = getAutoScrollTrackColors();
        const start = Math.max(0, Math.min(topPercent, bottomPercent));
        const end = Math.max(start, Math.min(100, Math.max(topPercent, bottomPercent)));
        const trackEl = autoScrollWindowTrack[0];
        trackEl.style.setProperty('--range-start', start.toFixed(2));
        trackEl.style.setProperty('--range-end', end.toFixed(2));
        trackEl.style.setProperty('--track-base-color', colors.base);
        trackEl.style.setProperty('--track-active-color', colors.active);
    }

    function refreshFrzzSliderFill(input) {
        const node = input && input.length !== undefined ? input[0] : input;
        if (!node) return;
        const min = Number(node.min || 0);
        const max = Number(node.max || 100);
        const rawValue = Number(node.value ?? min);
        const percent = max <= min ? 0 : ((rawValue - min) * 100) / (max - min);
        const clamped = Math.max(0, Math.min(100, percent));
        node.style.setProperty('--frzz-slider-stop', `${clamped}%`);
    }

    function updateAutoScrollWindowUI(topPercent, bottomPercent, options = {}) {
        if (!autoScrollWindowTopInput.length || !autoScrollWindowBottomInput.length) {
            return { top: topPercent, bottom: bottomPercent };
        }
        const { source } = options;
        const sanitizedTop = sanitizeAutoScrollPercent(topPercent, defaultSettings.autoScrollWindowTopPercent, 0, 90);
        let sanitizedBottom = sanitizeAutoScrollPercent(bottomPercent, defaultSettings.autoScrollWindowBottomPercent, 0, 100);
        let adjustedTop = sanitizedTop;
        let adjustedBottom = sanitizedBottom;
        const minGap = MIN_AUTO_SCROLL_WINDOW_GAP;

        if (source === 'top') {
            const maxAllowed = Math.max(0, adjustedBottom - minGap);
            adjustedTop = Math.min(adjustedTop, maxAllowed);
            adjustedTop = Math.max(0, adjustedTop);
        } else if (source === 'bottom') {
            const minAllowed = Math.min(100, adjustedTop + minGap);
            adjustedBottom = Math.max(adjustedBottom, minAllowed);
            adjustedBottom = Math.min(100, adjustedBottom);
        } else {
            if (adjustedBottom < adjustedTop + minGap) {
                adjustedBottom = Math.min(100, adjustedTop + minGap);
            }
            if (adjustedTop > adjustedBottom - minGap) {
                adjustedTop = Math.max(0, adjustedBottom - minGap);
            }
        }

        adjustedTop = clampNumber(Math.round(adjustedTop), 0, 100);
        adjustedBottom = clampNumber(Math.round(adjustedBottom), 0, 100);

        // Only set the actual input value for the active handle to avoid fighting the user's drag.
        if (source === 'top') {
            // While dragging top, only update its value (attributes stay at full 0-100 range)
            autoScrollWindowTopInput.val(adjustedTop);
        } else if (source === 'bottom') {
            // While dragging bottom, only update its value
            autoScrollWindowBottomInput.val(adjustedBottom);
        } else {
            // initialization / external updates: sync both handles
            autoScrollWindowTopInput.val(adjustedTop);
            autoScrollWindowBottomInput.val(adjustedBottom);
        }

        if (autoScrollWindowTopValue.length) {
            autoScrollWindowTopValue.text(`${adjustedTop}%`);
        }
        if (autoScrollWindowBottomValue.length) {
            autoScrollWindowBottomValue.text(`${adjustedBottom}%`);
        }
        updateAutoScrollWindowTrackGradient(adjustedTop, adjustedBottom);
        return { top: adjustedTop, bottom: adjustedBottom };
    }

    function updateAutoScrollLineAnchorSlider(value) {
        if (!autoScrollLineAnchorInput.length) return value;
        const sanitizedValue = sanitizeAutoScrollPercent(
            value,
            defaultSettings.autoScrollLineAnchorPercent,
            0,
            100
        );
        autoScrollLineAnchorInput.val(sanitizedValue);
        if (autoScrollLineAnchorValue.length) {
            autoScrollLineAnchorValue.text(`${sanitizedValue}%`);
        }
        if (autoScrollLineAnchorInput.hasClass('frzz-slider')) {
            refreshFrzzSliderFill(autoScrollLineAnchorInput);
        }
        return sanitizedValue;
    }

    function updateAutoScrollControlsState(enabled, modeCandidate) {
        const isEnabled = !!enabled;
        const resolvedMode = sanitizeAutoScrollMode(
            modeCandidate,
            settings.autoScrollMode || defaultSettings.autoScrollMode
        );
        if (autoScrollSettingsWrapper && autoScrollSettingsWrapper.length) {
            autoScrollSettingsWrapper.css('display', isEnabled ? '' : 'none');
        }
        if (scrollSpeedWrapper && scrollSpeedWrapper.length) {
            scrollSpeedWrapper.css('display', isEnabled ? '' : 'none');
        }
        if (scrollSpeedSlider && scrollSpeedSlider.length) {
            scrollSpeedSlider.prop('disabled', !isEnabled);
        }
        if (autoScrollModeSelect && autoScrollModeSelect.length) {
            autoScrollModeSelect.prop('disabled', !isEnabled);
            autoScrollModeSelect.val(resolvedMode);
        }
        if (autoScrollDynamicSpeedWrapper && autoScrollDynamicSpeedWrapper.length) {
            autoScrollDynamicSpeedWrapper.css('display', isEnabled ? '' : 'none');
        }
        if (autoScrollDynamicSpeedToggle && autoScrollDynamicSpeedToggle.length) {
            autoScrollDynamicSpeedToggle.prop('disabled', !isEnabled);
        }
        const showWindowSettings = isEnabled && resolvedMode === 'page';
        if (autoScrollWindowWrapper && autoScrollWindowWrapper.length) {
            autoScrollWindowWrapper.css('display', showWindowSettings ? '' : 'none');
            autoScrollWindowWrapper.find('input[type="range"]').prop('disabled', !showWindowSettings);
        }
        if (autoScrollWindowTopInput && autoScrollWindowTopInput.length) {
            autoScrollWindowTopInput.prop('disabled', !showWindowSettings);
        }
        if (autoScrollWindowBottomInput && autoScrollWindowBottomInput.length) {
            autoScrollWindowBottomInput.prop('disabled', !showWindowSettings);
        }
        const showLineOptions = isEnabled && resolvedMode === 'line';
        if (autoScrollLineAnchorWrapper && autoScrollLineAnchorWrapper.length) {
            autoScrollLineAnchorWrapper.css('display', showLineOptions ? '' : 'none');
            autoScrollLineAnchorWrapper.find('input').prop('disabled', !showLineOptions);
        }
        if (autoScrollLineAnchorInput && autoScrollLineAnchorInput.length) {
            autoScrollLineAnchorInput.prop('disabled', !showLineOptions);
        }
        if (typeof document !== 'undefined' && document.body) {
            document.body.setAttribute('data-auto-scroll-mode', resolvedMode);
        }
        if (showLineOptions) {
            updateAutoScrollLineAnchorSlider(autoScrollLineAnchorInput.val());
        }
        scheduleSettingsTileReflow();
    }

    function resetAutoScrollState() {
        resetSubtReaderInertiaState();
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
                        else if (el.is('input[type="number"]')) {
                            const stepAttr = el.attr('step');
                            const rawValue = el.val();
                            if (stepAttr && stepAttr.indexOf('.') !== -1) {
                                tempSettings[key] = parseFloat(rawValue);
                            } else {
                                tempSettings[key] = parseInt(rawValue, 10);
                            }
                        }
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

            const sanitizedPreRoll = sanitizeJumpPreRollSeconds(tempSettings.jumpPreRollSeconds, settings.jumpPreRollSeconds || defaultSettings.jumpPreRollSeconds);
            if (settings.jumpPreRollSeconds !== sanitizedPreRoll) {
                settings.jumpPreRollSeconds = sanitizedPreRoll;
            }
            tempSettings.jumpPreRollSeconds = sanitizedPreRoll;
            const jumpEnabled = !!tempSettings.jumpOnClickEnabled;
            tempSettings.jumpOnClickEnabled = jumpEnabled;
            settings.jumpOnClickEnabled = jumpEnabled;
            const jumpPreventPlay = !!tempSettings.jumpPreventWhilePlaying;
            const jumpPreventRecord = !!tempSettings.jumpPreventWhileRecording;
            tempSettings.jumpPreventWhilePlaying = jumpPreventPlay;
            tempSettings.jumpPreventWhileRecording = jumpPreventRecord;
            settings.jumpPreventWhilePlaying = jumpPreventPlay;
            settings.jumpPreventWhileRecording = jumpPreventRecord;

            const autoScrollEnabled = !!tempSettings.autoScroll;
            tempSettings.autoScroll = autoScrollEnabled;
            settings.autoScroll = autoScrollEnabled;

            const dynamicSpeedEnabled = tempSettings.autoScrollDynamicSpeedEnabled !== false;
            tempSettings.autoScrollDynamicSpeedEnabled = dynamicSpeedEnabled;
            settings.autoScrollDynamicSpeedEnabled = dynamicSpeedEnabled;

            const sanitizedAutoScrollMode = sanitizeAutoScrollMode(
                tempSettings.autoScrollMode,
                settings.autoScrollMode || defaultSettings.autoScrollMode
            );
            tempSettings.autoScrollMode = sanitizedAutoScrollMode;
            settings.autoScrollMode = sanitizedAutoScrollMode;

            const sanitizedWindowTop = sanitizeAutoScrollPercent(
                tempSettings.autoScrollWindowTopPercent,
                settings.autoScrollWindowTopPercent || defaultSettings.autoScrollWindowTopPercent,
                0,
                90
            );
            let sanitizedWindowBottom = sanitizeAutoScrollPercent(
                tempSettings.autoScrollWindowBottomPercent,
                settings.autoScrollWindowBottomPercent || defaultSettings.autoScrollWindowBottomPercent,
                sanitizedWindowTop + MIN_AUTO_SCROLL_WINDOW_GAP,
                100
            );
            if (sanitizedWindowBottom - sanitizedWindowTop < MIN_AUTO_SCROLL_WINDOW_GAP) {
                sanitizedWindowBottom = Math.min(100, sanitizedWindowTop + MIN_AUTO_SCROLL_WINDOW_GAP);
            }
            tempSettings.autoScrollWindowTopPercent = sanitizedWindowTop;
            tempSettings.autoScrollWindowBottomPercent = sanitizedWindowBottom;
            settings.autoScrollWindowTopPercent = sanitizedWindowTop;
            settings.autoScrollWindowBottomPercent = sanitizedWindowBottom;
            updateAutoScrollWindowUI(sanitizedWindowTop, sanitizedWindowBottom);
            const sanitizedLineAnchorPercent = sanitizeAutoScrollPercent(
                tempSettings.autoScrollLineAnchorPercent,
                settings.autoScrollLineAnchorPercent || defaultSettings.autoScrollLineAnchorPercent,
                0,
                100
            );
            tempSettings.autoScrollLineAnchorPercent = sanitizedLineAnchorPercent;
            settings.autoScrollLineAnchorPercent = sanitizedLineAnchorPercent;
            if (autoScrollLineAnchorInput.length) {
                updateAutoScrollLineAnchorSlider(sanitizedLineAnchorPercent);
            }

            const sanitizedLineEasingBaseMs = sanitizeAutoScrollLineEasingBaseMs(
                tempSettings.autoScrollLineEasingBaseMs,
                settings.autoScrollLineEasingBaseMs || defaultSettings.autoScrollLineEasingBaseMs
            );
            const sanitizedLineEasingPerPixel = sanitizeAutoScrollLineEasingPerPixel(
                tempSettings.autoScrollLineEasingPerPixel,
                settings.autoScrollLineEasingPerPixel || defaultSettings.autoScrollLineEasingPerPixel
            );
            let sanitizedLineEasingMaxMs = sanitizeAutoScrollLineEasingMaxMs(
                tempSettings.autoScrollLineEasingMaxMs,
                settings.autoScrollLineEasingMaxMs || defaultSettings.autoScrollLineEasingMaxMs
            );
            if (sanitizedLineEasingMaxMs < sanitizedLineEasingBaseMs) {
                sanitizedLineEasingMaxMs = Math.max(sanitizedLineEasingBaseMs, sanitizedLineEasingMaxMs);
            }
            tempSettings.autoScrollLineEasingBaseMs = sanitizedLineEasingBaseMs;
            tempSettings.autoScrollLineEasingPerPixel = sanitizedLineEasingPerPixel;
            tempSettings.autoScrollLineEasingMaxMs = sanitizedLineEasingMaxMs;
            settings.autoScrollLineEasingBaseMs = sanitizedLineEasingBaseMs;
            settings.autoScrollLineEasingPerPixel = sanitizedLineEasingPerPixel;
            settings.autoScrollLineEasingMaxMs = sanitizedLineEasingMaxMs;

            if (typeof document !== 'undefined' && document.body) {
                document.body.setAttribute('data-auto-scroll-mode', sanitizedAutoScrollMode);
            }
            updateAutoScrollControlsState(!!tempSettings.autoScroll, sanitizedAutoScrollMode);
            resetAutoScrollState();

            const navigationCompactMode = tempSettings.navigationCompactMode === true;
            tempSettings.navigationCompactMode = navigationCompactMode;
            settings.navigationCompactMode = navigationCompactMode;

            const transportTimecodeVisible = tempSettings.transportTimecodeVisible !== false;
            tempSettings.transportTimecodeVisible = transportTimecodeVisible;
            settings.transportTimecodeVisible = transportTimecodeVisible;

            const highlightCurrentEnabled = tempSettings.highlightCurrentEnabled !== false;
            tempSettings.highlightCurrentEnabled = highlightCurrentEnabled;
            settings.highlightCurrentEnabled = highlightCurrentEnabled;

            const highlightPreviousEnabled = tempSettings.highlightPreviousEnabled !== false;
            tempSettings.highlightPreviousEnabled = highlightPreviousEnabled;
            settings.highlightPreviousEnabled = highlightPreviousEnabled;

            const highlightPauseEnabled = tempSettings.highlightPauseEnabled !== false;
            tempSettings.highlightPauseEnabled = highlightPauseEnabled;
            settings.highlightPauseEnabled = highlightPauseEnabled;

            const progressBarEnabled = tempSettings.progressBarEnabled !== false;
            tempSettings.progressBarEnabled = progressBarEnabled;
            settings.progressBarEnabled = progressBarEnabled;

            const sanitizedProgressBarMode = sanitizeProgressBarMode(
                tempSettings.progressBarMode,
                settings.progressBarMode || defaultSettings.progressBarMode
            );
            tempSettings.progressBarMode = sanitizedProgressBarMode;
            settings.progressBarMode = sanitizedProgressBarMode;

            const highlightFeatureState = applyHighlightUIStateFromValues(tempSettings);
            const useSubtitleProgress = highlightFeatureState.progressBarEnabled && highlightFeatureState.progressBarMode === 'subtitle';
            const useTimecodeProgress = highlightFeatureState.progressBarEnabled && highlightFeatureState.progressBarMode === 'timecode';

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
            $('body').toggleClass('transport-timecode-hidden', !transportTimecodeVisible);
            $('body').toggleClass('progress-disabled', !highlightFeatureState.progressBarEnabled);
            $('body').toggleClass('progress-mode-timecode', useTimecodeProgress);
            updateAutoScrollWindowTrackGradient(
                tempSettings.autoScrollWindowTopPercent ?? sanitizedWindowTop,
                tempSettings.autoScrollWindowBottomPercent ?? sanitizedWindowBottom
            );
            // Expose role display style for CSS-based adjustments
            document.body.setAttribute('data-role-style', tempSettings.roleDisplayStyle || '');
            navigationPanel.toggleClass('top-panel', tempSettings.navigationPanelPosition === 'top');
            navigationPanel.toggleClass('compact-mode', navigationCompactMode);
            updateNavigationCollapsedUI();
            $('body').toggleClass('columns-swapped', tempSettings.swapColumns);
            $('body').toggleClass('hide-empty-role-column', tempSettings.autoHideEmptyColumn);
            textDisplay.css({'font-family': tempSettings.fontFamily});
            const sanitizedFilterBehavior = sanitizeFilterHiddenBehavior(
                tempSettings.filterHiddenBehavior,
                settings.filterHiddenBehavior || defaultSettings.filterHiddenBehavior
            );
            const sanitizedFilterDimPercent = sanitizeFilterDimPercent(
                tempSettings.filterDimPercent,
                settings.filterDimPercent || defaultSettings.filterDimPercent
            );
            tempSettings.filterHiddenBehavior = sanitizedFilterBehavior;
            tempSettings.filterDimPercent = sanitizedFilterDimPercent;
            settings.filterHiddenBehavior = sanitizedFilterBehavior;
            settings.filterDimPercent = sanitizedFilterDimPercent;
            if (filterHiddenBehaviorSelect.length) {
                filterHiddenBehaviorSelect.val(sanitizedFilterBehavior);
            }
            if (filterDimPercentSlider.length) {
                filterDimPercentSlider.val(sanitizedFilterDimPercent);
                filterDimPercentValue.text(sanitizedFilterDimPercent + '%');
                refreshFrzzSliderFill(filterDimPercentSlider);
            }
            updateFilterHiddenControlsVisibility(sanitizedFilterBehavior);

            if (!useSubtitleProgress) {
                detachSharedProgress();
            }
            resetTransportProgress();
            clearTimecodeProgress();
            if (subtitleElements && subtitleElements.length && (!highlightFeatureState.highlightCurrentEnabled || !highlightFeatureState.highlightPauseEnabled || !highlightFeatureState.highlightPreviousEnabled)) {
                subtitleElements.forEach(el => {
                    if (!el) {
                        return;
                    }
                    if (!highlightFeatureState.highlightCurrentEnabled) {
                        el.classList.remove('current-line');
                    }
                    if (!highlightFeatureState.highlightPauseEnabled) {
                        el.classList.remove('pause-highlight');
                    }
                    if (!highlightFeatureState.highlightPreviousEnabled) {
                        el.classList.remove('previous-line');
                    }
                });
            }
            if (!highlightFeatureState.highlightPreviousEnabled) {
                lastPreviousLineIndex = -1;
            }

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
            styleText += generateHighlightRules('previous-line', tempSettings.highlightPauseBg, false, null);
            styleText += generateHighlightRules('click-highlight', tempSettings.highlightClickBg, tempSettings.highlightCurrentRoleEnabled, tempSettings.highlightCurrentRoleBg);
            styleText += `.subtitle-progress-bar, .subtitle-time-progress { background-color: ${tempSettings.progressBarColor}; }`;
            
            settingsStyle.text(styleText);
            if (transportProgressBarEl) {
                transportProgressBarEl.style.backgroundColor = tempSettings.progressBarColor || defaultSettings.progressBarColor;
            }
            updateFilterRuntimeFromSettings();
            recomputeFilteringState({ reason: 'settings_apply', force: true });
            // After applying font/UI scale, re-evaluate navigation panel wrapping
            scheduleTransportWrapEvaluation();
            // Ensure visual title reflects authoritative settings + currentProjectName
            renderTitle();
            if (currentLineIndex !== -1) {
                updateTeleprompter(lastPlaybackTimeSeconds);
            }
            invalidateAllLinePaint({ schedule: true });
            console.debug('[Prompter][applySettings] done');
            updateJumpControlsState(tempSettings.jumpOnClickEnabled);
        } catch (e) { console.error("Error in applySettings:", e); }
    }

    // ++ НОВАЯ ФУНКЦИЯ: Обновляет весь UI в соответствии с объектом settings ++
    function updateUIFromSettings() {
        const s = settings;
        // Helper to ensure a select reflects a value even if option missing (inject fallback)
        function ensureSelectValue($sel, val){
            if(!$sel || !$sel.length) return;
            const normalized = val === undefined || val === null ? '' : String(val);
            const existingOption = $sel.find('option').filter(function(){ return String($(this).val()) === normalized; });
            if(existingOption.length === 0){
                const label = normalized.length ? normalized : '—';
                $('<option>', { value: normalized, text: label, 'data-auto-option': '1' }).appendTo($sel);
            }
            $sel.val(normalized);
        }
        Object.keys(s).forEach(key => {
            const id = '#' + key.replace(/([A-Z])/g, "-$1").toLowerCase();
            const el = $(id);
            if (el.length) {
                if (el.is(':checkbox')) { el.prop('checked', s[key]); }
                else if (el.is('select')) { ensureSelectValue(el, s[key]); }
                else if (el.is('input[type="range"]')) {
                    if (key === 'scrollSpeed') {
                        const closestIndex = speedSteps.reduce((prev, curr, index) =>
                            (Math.abs(curr - s[key]) < Math.abs(speedSteps[prev] - s[key]) ? index : prev), 0);
                        el.val(closestIndex);
                    } else { el.val(s[key]); }
                    if (el.hasClass('frzz-slider')) {
                        refreshFrzzSliderFill(el);
                    }
                }
                else if (el.is('input[type="number"]')) {
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
        if (filterHiddenBehaviorSelect.length) {
            ensureSelectValue(filterHiddenBehaviorSelect, s.filterHiddenBehavior || defaultSettings.filterHiddenBehavior);
        }
        if (filterDimPercentSlider.length) {
            const dimPercent = sanitizeFilterDimPercent(s.filterDimPercent, defaultSettings.filterDimPercent);
            filterDimPercentSlider.val(dimPercent);
            filterDimPercentValue.text(dimPercent + '%');
            refreshFrzzSliderFill(filterDimPercentSlider);
        }

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
        updateAutoScrollControlsState(s.autoScroll, s.autoScrollMode);
        if (autoScrollDynamicSpeedToggle && autoScrollDynamicSpeedToggle.length) {
            autoScrollDynamicSpeedToggle.prop('checked', s.autoScrollDynamicSpeedEnabled !== false);
        }
        // Explicitly set value for auto-find keywords input (was missing, causing empty overwrite on save)
        const autoFindKeywordsInput = $('#auto-find-keywords');
        if (autoFindKeywordsInput.length) {
            autoFindKeywordsInput.val(s.autoFindKeywords || defaultSettings.autoFindKeywords);
        }
    setRoleOptionsVisibility(s.processRoles);
    setCheckerboardOptionsVisibility(s.checkerboardEnabled);
    updateFilterHiddenControlsVisibility(s.filterHiddenBehavior || defaultSettings.filterHiddenBehavior);
        highlightClickOptionsWrapper.toggle(s.highlightClickEnabled);
        highlightRoleColorWrapper.toggle(s.highlightCurrentRoleEnabled);
        applyHighlightUIStateFromValues(s, { syncControls: false });
        if (jumpOnClickCheckbox.length) {
            jumpOnClickCheckbox.prop('checked', !!s.jumpOnClickEnabled);
        }
        if (jumpPreRollInput.length) {
            jumpPreRollInput.val(sanitizeJumpPreRollSeconds(s.jumpPreRollSeconds, defaultSettings.jumpPreRollSeconds));
        }
        if (jumpPreventWhilePlayingCheckbox.length) {
            jumpPreventWhilePlayingCheckbox.prop('checked', !!s.jumpPreventWhilePlaying);
        }
        if (jumpPreventWhileRecordingCheckbox.length) {
            jumpPreventWhileRecordingCheckbox.prop('checked', !!s.jumpPreventWhileRecording);
        }
        updateJumpControlsState(s.jumpOnClickEnabled);

        scheduleSettingsTileReflow();

        const scrollIndex = parseInt(scrollSpeedSlider.val(), 10);
        const scrollValue = speedSteps[scrollIndex] || 60;
        scrollSpeedValue.text(scrollValue + '%');
        scrollSpeedCaption.text(getScrollSpeedCaption(scrollValue));
        updateAutoScrollWindowUI(
            s.autoScrollWindowTopPercent,
            s.autoScrollWindowBottomPercent
        );
        updateAutoScrollLineAnchorSlider(s.autoScrollLineAnchorPercent);
    // Display value as entered (no conversion) for user clarity
    uiScaleValue.text(s.uiScale + '%');
        lineSpacingValue.text(s.lineSpacing + '%');
        roleColumnScaleValue.text(s.roleColumnScale + '%');
        updateScaleWrapperVisibility();

        setActiveTimecodeFormat(s.timecodeDisplayFormat, { updateUI: false, refresh: false, reason: 'ui_sync' });
    }

    function encodeStringToBase64Url(str) {
        try {
            const bytes = new TextEncoder().encode(str);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) {
                bin += String.fromCharCode(bytes[i]);
            }
            return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
        } catch (err) {
            console.error('[Prompter][settings] encodeStringToBase64Url failed', err);
            return '';
        }
    }

    function persistSettingsToBackend(sourceSettings, options = {}) {
        if (!sourceSettings || typeof sourceSettings !== 'object') {
            console.warn('[Prompter][settings] persist skipped: invalid source');
            return;
        }
        const reason = options.reason || 'manual';
        const deferMs = Number.isFinite(options.deferMs) ? options.deferMs : 150;
        const settingsForFile = { ...sourceSettings };
        delete settingsForFile.actorRoleMappingText;
        delete settingsForFile.actorColors;
        delete settingsForFile.settingsMigratedFrom;
        const settingsString = JSON.stringify(settingsForFile, null, 2);
        const b64url = '__B64__' + encodeStringToBase64Url(settingsString);
        const encodedChunks = chunkString(b64url, SETTINGS_CHUNK_SIZE);
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_total_encoded_len/${b64url.length}`);
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_total_decoded_len/${settingsString.length}`);
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_chunks/${encodedChunks.length}`);
        encodedChunks.forEach((ch, idx) => wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/settings_data_${idx}/${ch}`));
        wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/SAVE_SETTINGS');
        setTimeout(() => { wwr_req(REASCRIPT_ACTION_ID); }, deferMs);
        console.info('[Prompter][settings] persisted', { reason, chunks: encodedChunks.length, encodedLen: b64url.length });
    }

    async function loadSettings() {
        const t0 = performance.now();
        console.info('[Prompter][loadSettings] start', { emu: isEmuMode() });
        if (isEmuMode()) {
            // In EMU mode we do NOT fetch root settings.json, rely on defaults; reference/settings.json will be applied in loadEmuData
            settings = migrateSettingsObject({ ...defaultSettings });
            setActiveTimecodeFormat(settings.timecodeDisplayFormat, { updateUI: false, refresh: false, reason: 'load_settings_emu' });
            setProjectFps(settings.frameRate, { source: 'settings', forceEmit: true });
            $('#ui-scale').attr({ min:50, max:300, step:25 });
            initializeColorPickers();
            updateFilterRuntimeFromSettings();
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
                settings = { ...defaultSettings };
            }
            const migrationMeta = {};
            settings = migrateSettingsObject(settings, migrationMeta);
            setActiveTimecodeFormat(settings.timecodeDisplayFormat, { updateUI: false, refresh: false, reason: 'load_settings' });
            setProjectFps(settings.frameRate, { source: 'settings', forceEmit: true });

            if (settings.uiScale > 150) {
                const adjusted = Math.round(settings.uiScale / 2);
                if (adjusted !== settings.uiScale) {
                    settings.uiScale = adjusted;
                    migrationMeta.changed = true;
                }
            }
            const boundedUiScale = Math.min(300, Math.max(50, settings.uiScale));
            if (boundedUiScale !== settings.uiScale) {
                settings.uiScale = boundedUiScale;
                migrationMeta.changed = true;
            }
            const snappedUiScale = Math.round((settings.uiScale - 50) / 25) * 25 + 50;
            if (snappedUiScale !== settings.uiScale) {
                settings.uiScale = Math.min(300, snappedUiScale);
                migrationMeta.changed = true;
            }
            if (typeof settings.highlightClickDuration !== 'number' || settings.highlightClickDuration <= 0 || settings.highlightClickDuration > 60000) {
                settings.highlightClickDuration = defaultSettings.highlightClickDuration;
                migrationMeta.changed = true;
            }
            updateFilterRuntimeFromSettings();

            try {
                localStorage.setItem('teleprompterSettings', JSON.stringify(settings));
            } catch (storageErr) {
                console.debug('[Prompter][loadSettings] localStorage persist failed', storageErr);
            }

            if (fileSettings && migrationMeta.changed) {
                persistSettingsToBackend(settings, { reason: 'migration', deferMs: 200 });
                console.info('[Prompter][loadSettings] migrated legacy settings', {
                    fromSchema: migrationMeta.migratedFrom,
                    legacySchema: migrationMeta.legacySchema
                });
                delete settings.settingsMigratedFrom;
            }
        } catch(e) {
            console.warn('[Prompter][loadSettings] Error during parse/migration, reverting to defaults:', e);
            settings = migrateSettingsObject({ ...defaultSettings });
            setActiveTimecodeFormat(settings.timecodeDisplayFormat, { updateUI: false, refresh: false, reason: 'load_settings_fallback' });
            setProjectFps(settings.frameRate, { source: 'settings', forceEmit: true });
        }
        // Reflect slider attributes
    $('#ui-scale').attr({ min:50, max:300, step:25 });
    initializeColorPickers();
        updateUIFromSettings();
        applySettings();
        try {
            localStorage.setItem('teleprompterSettings', JSON.stringify(settings));
        } catch (persistErr) {
            console.debug('[Prompter][loadSettings] final localStorage sync failed', persistErr);
        }
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
            settings.dataModelVersion = DATA_MODEL_VERSION;
            settings.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
            const settingsToSave = {};
            Object.keys(defaultSettings).forEach(key => {
                const id = '#' + key.replace(/([A-Z])/g, "-$1").toLowerCase();
                const el = $(id);
                if (el.length) {
                    if (el.is(':checkbox')) { settingsToSave[key] = el.is(':checked'); }
                    else if (el.is('input[type="range"]')) { const val = parseInt(el.val(), 10); settingsToSave[key] = key === 'scrollSpeed' ? speedSteps[val] : val; }
                    else if (el.is('input[type="number"]')) {
                        const stepAttr = el.attr('step');
                        const rawValue = el.val();
                        if (key === 'jumpPreRollSeconds') {
                            settingsToSave[key] = sanitizeJumpPreRollSeconds(parseFloat(rawValue), defaultSettings.jumpPreRollSeconds);
                        } else if (stepAttr && stepAttr.indexOf('.') !== -1) {
                            settingsToSave[key] = parseFloat(rawValue);
                        } else {
                            settingsToSave[key] = parseInt(rawValue, 10);
                        }
                    }
                    else { const color = el.spectrum("get"); if (color && color.toRgbString) { settingsToSave[key] = color.toRgbString(); } else { settingsToSave[key] = el.val(); } }
                } else { settingsToSave[key] = settings[key]; }
            });
            settingsToSave.timecodeDisplayFormat = normalizeTimecodeDisplayFormatValue(
                settingsToSave.timecodeDisplayFormat,
                settings.timecodeDisplayFormat || defaultSettings.timecodeDisplayFormat
            );
            if (isNaN(settingsToSave.highlightClickDuration) || settingsToSave.highlightClickDuration <= 0 || settingsToSave.highlightClickDuration > 60000) {
                settingsToSave.highlightClickDuration = defaultSettings.highlightClickDuration;
            }
            settingsToSave.progressBarMode = sanitizeProgressBarMode(
                settingsToSave.progressBarMode,
                settings.progressBarMode || defaultSettings.progressBarMode
            );
            settingsToSave.highlightCurrentEnabled = settingsToSave.highlightCurrentEnabled !== false;
            settingsToSave.highlightPreviousEnabled = settingsToSave.highlightPreviousEnabled !== false;
            settingsToSave.highlightPauseEnabled = settingsToSave.highlightPauseEnabled !== false;
            settingsToSave.progressBarEnabled = settingsToSave.progressBarEnabled !== false;
            settingsToSave.navigationCompactMode = !!settingsToSave.navigationCompactMode;
            settingsToSave.transportTimecodeVisible = settingsToSave.transportTimecodeVisible !== false;

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
            setActiveTimecodeFormat(settings.timecodeDisplayFormat, { updateUI: false, refresh: true, reason: 'save_settings' });
            settings.timecodeDisplayFormat = activeTimecodeFormat;
            settings.dataModelVersion = DATA_MODEL_VERSION;
            settings.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
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
            
            persistSettingsToBackend(settings, { reason: 'save' });
        } catch (e) { console.error("Error in saveSettings:", e); }
        finally { $('#settings-modal').hide(); }
    }
    
    function resetSettings() {
        try {
            if (confirm("Вы уверены, что хотите сбросить все настройки к значениям по умолчанию? Это действие нельзя будет отменить.")) {
                settings = migrateSettingsObject({ ...defaultSettings });
                setActiveTimecodeFormat(settings.timecodeDisplayFormat, { updateUI: false, refresh: true, reason: 'reset_settings' });
                localStorage.setItem('teleprompterSettings', JSON.stringify(settings));
                console.debug('[Prompter][resetSettings] Reset to defaults');
                
                updateUIFromSettings();
                applySettings();
                if (subtitleData.length > 0) handleTextResponse(subtitleData);

                persistSettingsToBackend(settings, { reason: 'reset' });
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
            return encodeStringToBase64Url(str);
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

    function scheduleExtStateRequests(requests, spacingMs = 35){
        if (!Array.isArray(requests) || requests.length === 0) return 0;
        const interval = Math.max(0, spacingMs | 0);
        requests.forEach((req, idx) => {
            setTimeout(() => {
                try {
                    wwr_req(req);
                } catch(err){ console.error('[Prompter][roles] extstate dispatch failed', err, req); }
            }, idx * interval);
        });
        return interval * Math.max(0, requests.length - 1);
    }
    function invalidateRolesCache(reason = 'manual') {
        rolesLoaded = false;
        console.debug('[Prompter][roles] cache invalidated', { reason });
        settings.actorRoleMappingText = '';
        settings.actorColors = {};
        roleToActor = {};
        actorToRoles = {};
        if (typeof regenerateActorColorListUI === 'function') {
            regenerateActorColorListUI();
        }
    }


    function clearRolesSaveTimers(){
        if (rolesStatusPollTimer) { clearTimeout(rolesStatusPollTimer); rolesStatusPollTimer = null; }
        if (rolesStatusFallbackTimer) { clearTimeout(rolesStatusFallbackTimer); rolesStatusFallbackTimer = null; }
    }

    function scheduleRolesStatusPoll(delayMs){
        if (!rolesSaveInFlight) return;
        if (rolesStatusPollTimer) clearTimeout(rolesStatusPollTimer);
        rolesStatusPollTimer = setTimeout(() => {
            if (!rolesSaveInFlight) return;
            wwr_req('GET/EXTSTATE/PROMPTER_WEBUI/roles_status');
        }, delayMs);
    }

    function handleRolesStatusMessage(status){
        console.debug('[Prompter][roles][status]', status);
        if (/NOT_FOUND|MISSING|NO_FILE/i.test(status)) {
            finalizeRolesLoad('empty', { backendStatus: status });
        } else if (/ERROR|FAIL/i.test(status)) {
            finalizeRolesLoad('error', { backendStatus: status });
        }
        if (!rolesSaveInFlight) return;
        if (status === 'PENDING' || status === '') {
            scheduleRolesStatusPoll(500);
            return;
        }
        const duration = rolesSaveStartedAt ? Math.round(performance.now() - rolesSaveStartedAt) : null;
        console.info('[Prompter][roles][saveRoles] backend status', { status, durationMs: duration });
        rolesSaveInFlight = false;
        clearRolesSaveTimers();
        if (/SUCCESS|NO_PROJECT_SAVED_FALLBACK/i.test(status) && subtitleData.length > 0) {
            handleTextResponse(subtitleData);
        }
    }

    function finalizeRolesLoad(status, extra = {}) {
        const info = {
            status,
            ...extra
        };
        console.info('[Prompter][roles][request] complete', info);
        return info;
    }

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
            rolesSaveInFlight = true;
            rolesSaveStartedAt = performance.now();
            rolesStatusRetryCount = 0;
            clearRolesSaveTimers();
            const queuedRequests = [
                'SET/EXTSTATEPERSIST/PROMPTER_WEBUI/roles_status/PENDING',
                `SET/EXTSTATEPERSIST/PROMPTER_WEBUI/roles_total_encoded_len/${b64url.length}`,
                `SET/EXTSTATEPERSIST/PROMPTER_WEBUI/roles_total_decoded_len/${jsonPretty.length}`,
                `SET/EXTSTATEPERSIST/PROMPTER_WEBUI/roles_chunks/${parts.length}`
            ];
            parts.forEach((ch, idx)=> {
                queuedRequests.push(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/roles_data_${idx}/${ch}`);
            });
            queuedRequests.push('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/SAVE_ROLES');
            const spacingMs = Math.min(60, Math.max(25, Math.round(parts.length / 2) + 25));
            const transmitWindow = scheduleExtStateRequests(queuedRequests, spacingMs);
            const dispatchDelay = Math.min(2600, Math.max(700, transmitWindow + 320));
            console.debug('[Prompter][roles][saveRoles] dispatch scheduled', {
                spacingMs,
                transmitWindow,
                dispatchDelay,
                requests: queuedRequests.length
            });
            const triggerAction = () => { wwr_req(REASCRIPT_ACTION_ID); };
            setTimeout(triggerAction, dispatchDelay);
            setTimeout(triggerAction, dispatchDelay + 280);
            scheduleRolesStatusPoll(dispatchDelay + 640);
            const scheduleRetry = () => {
                if (!rolesSaveInFlight) return;
                if (rolesStatusRetryCount >= 2) {
                    console.error('[Prompter][roles][saveRoles] backend did not respond (timeout)');
                    rolesSaveInFlight = false;
                    clearRolesSaveTimers();
                    return;
                }
                rolesStatusRetryCount += 1;
                console.warn('[Prompter][roles][saveRoles] backend still pending, retry', { attempt: rolesStatusRetryCount, chunks: parts.length });
                wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/SAVE_ROLES');
                setTimeout(triggerAction, 120);
                scheduleRolesStatusPoll(760);
                rolesStatusFallbackTimer = setTimeout(scheduleRetry, 2400);
            };
            rolesStatusFallbackTimer = setTimeout(scheduleRetry, dispatchDelay + 2400);
        } catch(err){
            console.error('[Prompter][roles] saveRoles failed', err);
            rolesSaveInFlight = false;
            clearRolesSaveTimers();
        }
    }

    function applyProjectName(nameCandidate, meta = {}) {
        const raw = typeof nameCandidate === 'string' ? nameCandidate : '';
        const normalized = raw.trim();
        const previous = currentProjectName || '';
        if (previous === normalized) {
            return { changed: false, value: normalized };
        }
        currentProjectName = normalized;
        renderTitle();
        if (normalized) {
            console.debug('[Prompter][projectData] project name applied', { name: normalized, source: meta.source || 'unknown' });
        } else {
            console.debug('[Prompter][projectData] project name cleared', { source: meta.source || 'unknown' });
        }
        return { changed: true, value: normalized };
    }

    function applyProjectFpsPayload(payload, meta = {}) {
        if (payload == null) {
            console.debug('[Prompter][projectData] fps payload missing', { source: meta.source || 'unknown' });
            return { applied: false, reason: 'empty' };
        }
        let numeric = NaN;
        let raw = '';
        let dropFrame;
        if (typeof payload === 'number') {
            numeric = payload;
            raw = String(payload);
        } else if (typeof payload === 'string') {
            raw = payload;
            const parsed = Number(payload);
            if (Number.isFinite(parsed)) {
                numeric = parsed;
            }
        } else if (typeof payload === 'object') {
            if (typeof payload.normalized === 'number') {
                numeric = payload.normalized;
            } else if (typeof payload.value === 'number') {
                numeric = payload.value;
            } else if (typeof payload.value === 'string') {
                const parsed = Number(payload.value);
                if (Number.isFinite(parsed)) {
                    numeric = parsed;
                }
            }
            if (typeof payload.dropFrame === 'boolean') {
                dropFrame = payload.dropFrame;
            } else if (typeof payload.drop_frame === 'boolean') {
                dropFrame = payload.drop_frame;
            }
            if (typeof payload.raw === 'string') {
                raw = payload.raw;
            } else if (typeof payload.raw === 'number') {
                raw = String(payload.raw);
            }
        }
        if (!Number.isFinite(numeric)) {
            console.warn('[Prompter][projectData] fps payload without numeric value', { payload, source: meta.source || 'unknown' });
            return { applied: false, reason: 'invalid_numeric' };
        }
        setProjectFps(numeric, {
            source: meta.source || 'project_data',
            dropFrame,
            raw,
            reason: meta.reason || 'project_data'
        });
        return { applied: true, value: numeric, dropFrame };
    }

    function applyRolesPayload(payload, meta = {}) {
        const baseSource = meta.source || 'project_data';
        let payloadSource = baseSource;
        let encoding = '';
        if (payload == null) {
            console.debug('[Prompter][projectData] roles payload missing', { source: baseSource });
            integrateLoadedRoles('', { ...meta, source: baseSource, reason: 'empty_payload' });
            return { applied: false, reason: 'empty' };
        }
        let jsonText = '';
        if (typeof payload === 'string') {
            jsonText = payload;
        } else if (typeof payload === 'object') {
            if (typeof payload.encoding === 'string') {
                encoding = payload.encoding.toLowerCase().trim();
            }
            if (typeof payload.json === 'string') {
                jsonText = payload.json;
            } else if (typeof payload.data === 'string') {
                jsonText = payload.data;
            }
            if (typeof payload.source === 'string' && payload.source.trim()) {
                payloadSource = payload.source.trim();
            }
        }
        if (!jsonText || !jsonText.trim()) {
            integrateLoadedRoles('', { ...meta, source: payloadSource, reason: 'empty_payload' });
            return { applied: false, reason: 'empty_json' };
        }
        if (encoding === 'base64url' || encoding === 'base64') {
            const decoded = rolesFromBase64Url(jsonText);
            if (!decoded) {
                console.warn('[Prompter][projectData] failed to decode roles payload', { encoding, source: payloadSource });
                integrateLoadedRoles('', { ...meta, source: payloadSource, reason: 'decode_failed' });
                return { applied: false, reason: 'decode_failed' };
            }
            jsonText = decoded;
        }
        integrateLoadedRoles(jsonText, { ...meta, source: payloadSource, encoding: encoding || 'plain' });
        return { applied: true, encoding: encoding || 'plain' };
    }

    function applyProjectDataSnapshot(snapshot, meta = {}) {
        if (!snapshot || typeof snapshot !== 'object') {
            console.warn('[Prompter][projectData] invalid snapshot', { snapshot, meta });
            return { status: 'invalid' };
        }
        const applied = {
            projectName: false,
            tracks: false,
            tracksCount: 0,
            fps: false,
            roles: false
        };
        if (Object.prototype.hasOwnProperty.call(snapshot, 'project_name')) {
            const nameResult = applyProjectName(snapshot.project_name, meta);
            applied.projectName = nameResult.changed;
        }
        if (Object.prototype.hasOwnProperty.call(snapshot, 'tracks')) {
            if (Array.isArray(snapshot.tracks)) {
                applyTracks(snapshot.tracks, meta);
                applied.tracks = true;
                applied.tracksCount = snapshot.tracks.length;
            } else if (snapshot.tracks === null) {
                applyTracks([], meta);
                applied.tracks = true;
                applied.tracksCount = 0;
            }
        }
        if (Object.prototype.hasOwnProperty.call(snapshot, 'fps')) {
            const fpsResult = applyProjectFpsPayload(snapshot.fps, meta);
            applied.fps = fpsResult.applied;
        }
        if (Object.prototype.hasOwnProperty.call(snapshot, 'roles')) {
            const rolesResult = applyRolesPayload(snapshot.roles, meta);
            applied.roles = rolesResult.applied;
        }
        projectDataCache = snapshot;
        return { status: 'applied', applied };
    }

    async function getProjectData(reason = 'manual', options = {}) {
        const opts = {
            allowCache: true,
            forceReload: false,
            clearCache: false,
            ...options
        };
        if (opts.clearCache) {
            clearProjectDataCache();
        }
        const startedAt = performance.now();
        const cachedSource = opts.allowCache ? (projectDataCache || loadProjectDataCache()) : null;
        if (!opts.forceReload && cachedSource) {
            const applyResult = applyProjectDataSnapshot(cachedSource, { source: 'cache', reason });
            statusIndicator.text('Данные проекта загружены из кэша.');
            const result = {
                status: 'cache',
                applied: applyResult.applied,
                data: cachedSource,
                durationMs: Math.round(performance.now() - startedAt)
            };
            console.debug('[Prompter][projectData] served from cache', { reason, durationMs: result.durationMs, applied: result.applied });
            return result;
        }
        if (projectDataInFlight) {
            console.debug('[Prompter][projectData] awaiting in-flight request', { reason });
            return projectDataInFlight;
        }
        if (isEmuMode()) {
            const sp = new URLSearchParams(window.location.search);
            let subtitlePath = normalizeReferencePath(sp.get('subtitle'), 'emu/subtitles');
            if (subtitlePath.toLowerCase().endsWith('.json')) subtitlePath = subtitlePath.slice(0, -5);
            const datasetDir = subtitlePath.includes('/') ? subtitlePath.slice(0, subtitlePath.lastIndexOf('/')) : '';
            let projectPath = normalizeReferencePath(sp.get('emuproject'), datasetDir ? `${datasetDir}/project-data` : 'emu/project-data');
            if (projectPath.toLowerCase().endsWith('.json')) projectPath = projectPath.slice(0, -5);
            const projectUrl = `reference/${projectPath}.json?_ts=${Date.now()}`;
            try {
                const projectResponse = await fetch(projectUrl);
                if (projectResponse.ok) {
                    const snapshot = await projectResponse.json();
                    storeProjectDataCache(snapshot);
                    const applyResult = applyProjectDataSnapshot(snapshot, { source: 'emu_reference_reload', reason: 'emu:project_reload' });
                    statusIndicator.text('Эмуляция: данные проекта обновлены.');
                    return {
                        status: 'emu_reference',
                        applied: applyResult.applied,
                        data: snapshot,
                        durationMs: Math.round(performance.now() - startedAt)
                    };
                }
                console.warn('[Prompter][projectData][emu] reference snapshot unavailable', { status: projectResponse.status, url: projectUrl });
            } catch (emuErr) {
                console.error('[Prompter][projectData][emu] snapshot fetch failed', emuErr);
            }
            const fallback = {
                project_name: 'EMU Project',
                tracks: [{ id: 0, name: 'Subtitles' }],
                fps: { value: DEFAULT_PROJECT_FPS, raw: String(DEFAULT_PROJECT_FPS), dropFrame: false },
                roles: null
            };
            storeProjectDataCache(fallback);
            const applyResult = applyProjectDataSnapshot(fallback, { source: 'emu_fallback', reason: 'emu:project' });
            statusIndicator.text('Эмуляция: данные проекта обновлены.');
            return {
                status: 'emu_fallback',
                applied: applyResult.applied,
                data: fallback,
                durationMs: Math.round(performance.now() - startedAt)
            };
        }

        const maxAttempts = Math.max(1, Number.isFinite(opts.retryAttempts) ? opts.retryAttempts : 3);
        const retryDelayMs = Number.isFinite(opts.retryDelayMs) ? Math.max(0, opts.retryDelayMs) : 250;

        const fetchFromBackend = async attempt => {
            const attemptStartedAt = performance.now();
            const deadline = attemptStartedAt + PROJECT_DATA_TIMEOUT_MS;
            statusIndicator.text(attempt > 1 ? `Повторная попытка обновления данных проекта... (${attempt})` : 'Обновляем данные проекта...');
            wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/command/GET_PROJECT_DATA');
            setTimeout(() => { wwr_req(REASCRIPT_ACTION_ID); }, 50);

            let latestStatusInfo = parseProjectDataStatus('PENDING');
            let observedPending = false;
            let pendingTimestamp = null;
            while (true) {
                if (performance.now() > deadline) {
                    throw new Error('timeout waiting project data status');
                }
                try {
                    const statusRaw = await requestExtStateValue(PROJECT_DATA_STATUS_KEY, Math.min(400, PROJECT_DATA_POLL_INTERVAL_MS + 200));
                    latestStatusInfo = parseProjectDataStatus(statusRaw);
                } catch (statusErr) {
                    console.debug('[Prompter][projectData] status poll failed, retrying', statusErr.message);
                    latestStatusInfo = parseProjectDataStatus('PENDING');
                }
                const statusTs = Number.isFinite(latestStatusInfo.timestamp) ? latestStatusInfo.timestamp : null;

                if (latestStatusInfo.normalized === 'error') {
                    const detailText = latestStatusInfo.detail || latestStatusInfo.state || latestStatusInfo.raw || 'unknown error';
                    throw new Error(`project data status error: ${detailText}`);
                }

                if (latestStatusInfo.normalized === 'pending' || latestStatusInfo.normalized === 'unknown' || latestStatusInfo.normalized === 'other') {
                    if (latestStatusInfo.normalized === 'pending') {
                        observedPending = true;
                        if (statusTs) {
                            pendingTimestamp = statusTs;
                        }
                    }
                    await delay(PROJECT_DATA_POLL_INTERVAL_MS);
                    continue;
                }

                if (latestStatusInfo.normalized === 'ok') {
                    const hasLastTimestamp = Number.isFinite(lastProjectDataTimestamp) && lastProjectDataTimestamp > 0;
                    if (statusTs && hasLastTimestamp && (lastProjectDataTimestamp - statusTs) > PROJECT_DATA_STATUS_TOLERANCE_MS) {
                        console.debug('[Prompter][projectData] ignoring stale OK status, waiting for fresh data', {
                            statusTimestamp: statusTs,
                            lastProjectDataTimestamp
                        });
                        observedPending = observedPending || pendingTimestamp !== null;
                        await delay(PROJECT_DATA_POLL_INTERVAL_MS);
                        continue;
                    }
                    if (!observedPending && (performance.now() - attemptStartedAt) < PROJECT_DATA_POLL_INTERVAL_MS * 2) {
                        console.debug('[Prompter][projectData] ignoring premature OK status, waiting for pending');
                        await delay(PROJECT_DATA_POLL_INTERVAL_MS);
                        continue;
                    }
                    break;
                }

                console.debug('[Prompter][projectData] unexpected status state, waiting', latestStatusInfo);
                await delay(PROJECT_DATA_POLL_INTERVAL_MS);
            }

            const finalStatusInfo = latestStatusInfo;
            if (!finalStatusInfo || finalStatusInfo.normalized !== 'ok') {
                throw new Error(`project data status: ${finalStatusInfo ? finalStatusInfo.state : 'unknown'}`);
            }

            let jsonRaw = await requestExtStateValue(PROJECT_DATA_JSON_KEY, 800);
            if ((jsonRaw || '').trim() === '__CHUNKED__') {
                console.debug('[Prompter][projectData] chunked payload detected');
                jsonRaw = await fetchProjectDataChunks();
            }
            if (!jsonRaw || !jsonRaw.trim()) {
                throw new Error('empty project data payload');
            }

            let parsed;
            try {
                parsed = JSON.parse(jsonRaw);
            } catch (parseErr) {
                throw new Error(`invalid project data json: ${parseErr.message}`);
            }

            const toleranceMs = PROJECT_DATA_STATUS_TOLERANCE_MS;
            const statusTimestamp = Number.isFinite(finalStatusInfo.timestamp) ? finalStatusInfo.timestamp : null;
            const meta = parsed && typeof parsed === 'object' ? parsed.meta || null : null;
            const metaRequestedRaw = meta !== null ? Number(meta.status_requested_at_ms) : NaN;
            const metaCompletedRaw = meta !== null ? Number(meta.status_completed_at_ms) : NaN;
            const metaRequested = Number.isFinite(metaRequestedRaw) ? metaRequestedRaw : null;
            const metaCompleted = Number.isFinite(metaCompletedRaw) ? metaCompletedRaw : null;

            if (pendingTimestamp && metaRequested && Math.abs(metaRequested - pendingTimestamp) > toleranceMs) {
                throw new Error(`project data request timestamp mismatch (${pendingTimestamp} vs ${metaRequested})`);
            }

            if (metaRequested && metaCompleted && metaRequested > metaCompleted + toleranceMs) {
                throw new Error('project data meta timestamps out of order');
            }

            if (statusTimestamp && metaCompleted && Math.abs(metaCompleted - statusTimestamp) > toleranceMs) {
                throw new Error('project data status completion timestamp mismatch');
            }

            let effectiveCompletedTs = null;
            if (metaCompleted && Number.isFinite(metaCompleted)) {
                effectiveCompletedTs = metaCompleted;
            } else if (statusTimestamp) {
                effectiveCompletedTs = statusTimestamp;
            }

            if (!Number.isFinite(effectiveCompletedTs)) {
                throw new Error('project data completion timestamp unavailable');
            }

            const hasPriorTimestamp = Number.isFinite(lastProjectDataTimestamp) && lastProjectDataTimestamp > 0;
            if (hasPriorTimestamp && (lastProjectDataTimestamp - effectiveCompletedTs) > toleranceMs) {
                throw new Error('stale project data payload (timestamp regressed)');
            }

            lastProjectDataTimestamp = hasPriorTimestamp
                ? Math.max(lastProjectDataTimestamp, effectiveCompletedTs)
                : effectiveCompletedTs;

            storeProjectDataCache(parsed);
            const applyResult = applyProjectDataSnapshot(parsed, { source: 'backend', reason });
            statusIndicator.text('Данные проекта обновлены.');
            const result = {
                status: 'ok',
                applied: applyResult.applied,
                data: parsed,
                statusTimestamp,
                completedTimestamp: metaCompleted || null,
                durationMs: Math.round(performance.now() - startedAt)
            };
            console.info('[Prompter][projectData] backend update', {
                reason,
                attempt,
                durationMs: result.durationMs,
                tracks: Array.isArray(parsed && parsed.tracks) ? parsed.tracks.length : undefined,
                hasRoles: !!(parsed && parsed.roles),
                statusTimestamp,
                metaCompleted
            });
            return result;
        };

        const pendingPromise = (async () => {
            let attempt = 0;
            let lastError = null;
            while (attempt < maxAttempts) {
                attempt += 1;
                try {
                    return await fetchFromBackend(attempt);
                } catch (err) {
                    lastError = err;
                    console.warn('[Prompter][projectData] fetch attempt failed', { attempt, maxAttempts, error: err.message });
                    if (attempt >= maxAttempts) {
                        statusIndicator.text('Не удалось обновить данные проекта.');
                        console.error('[Prompter][projectData] failed', err);
                        throw err;
                    }
                    await delay(retryDelayMs);
                }
            }
            throw lastError || new Error('project data update failed');
        })();

        projectDataInFlight = pendingPromise.finally(() => {
            projectDataInFlight = null;
        });
        return projectDataInFlight;
    }

    async function ensureRolesLoaded(options = {}) {
        const reason = options.reason || 'unspecified';
        if (rolesLoaded) {
            const cachedInfo = { status: 'cached', reason, durationMs: 0 };
            console.debug('[Prompter][roles][ensure] using cached roles', cachedInfo);
            return cachedInfo;
        }
        const startedAt = performance.now();
        try {
            const result = await getProjectData(`roles:${reason}`, { allowCache: true });
            const durationMs = Math.round(performance.now() - startedAt);
            if (rolesLoaded) {
                return { status: 'loaded', reason, durationMs, source: result && result.status ? result.status : 'unknown' };
            }
            return { status: 'empty', reason, durationMs, source: result && result.status ? result.status : 'unknown' };
        } catch (err) {
            console.error('[Prompter][roles][ensure] failed', err);
            return { status: 'error', reason, error: err.message };
        }
    }

    function integrateLoadedRoles(jsonText, meta = {}){
        const parseStart = performance.now();
        const perfNow = () => Math.round(performance.now() - parseStart);
        try {
            const raw = typeof jsonText === 'string' ? jsonText : '';
            const trimmed = raw.trim();
            if (!trimmed) {
                rolesLoaded = false;
                settings.actorRoleMappingText = '';
                settings.actorColors = {};
                roleToActor = {};
                actorToRoles = {};
                regenerateActorColorListUI();
                if (subtitleData.length > 0) {
                    handleTextResponse(subtitleData);
                }
                finalizeRolesLoad('empty', { ...meta, parseMs: perfNow(), reason: 'empty_payload' });
                return;
            }

            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            } catch (parseErr) {
                console.error('[Prompter][roles] integrateLoadedRoles parse failed', parseErr);
                rolesLoaded = false;
                finalizeRolesLoad('error', { ...meta, error: parseErr.message, parseMs: perfNow(), reason: 'json_parse_failed' });
                return;
            }

            if (!parsed || typeof parsed !== 'object') {
                rolesLoaded = false;
                finalizeRolesLoad('empty', { ...meta, parseMs: perfNow(), reason: 'invalid_payload' });
                return;
            }

            const mappingText = typeof parsed.actorRoleMappingText === 'string' ? parsed.actorRoleMappingText : '';
            const actorColorsObj = (parsed.actorColors && typeof parsed.actorColors === 'object') ? parsed.actorColors : {};

            settings.actorRoleMappingText = mappingText;
            settings.actorColors = { ...actorColorsObj };

            const mappedRolesCount = buildActorRoleMaps();
            const actorColorsCount = Object.keys(settings.actorColors || {}).length;
            const hasMappingText = mappingText.trim().length > 0;
            rolesLoaded = mappedRolesCount > 0 || actorColorsCount > 0 || hasMappingText;

            console.info('[Prompter][roles][integrateLoadedRoles] parsed', {
                hasMappingText,
                mappedRoles: mappedRolesCount,
                actorColors: actorColorsCount,
                source: meta.source || 'backend'
            });

            regenerateActorColorListUI();
            if (subtitleData.length > 0) {
                handleTextResponse(subtitleData);
            }

            const outcome = rolesLoaded ? 'loaded' : 'empty';
            finalizeRolesLoad(outcome, {
                ...meta,
                parseMs: perfNow(),
                mappedRoles: mappedRolesCount,
                actorColors: actorColorsCount,
                hasMappingText
            });
        } catch(err){
            rolesLoaded = false;
            console.error('[Prompter][roles] integrateLoadedRoles failed', err);
            finalizeRolesLoad('error', { ...meta, error: err.message, parseMs: perfNow() });
        }
    }
    
    function initialize() {
        try {
            const t0 = performance.now();
            console.info('[Prompter] initialize (REAPER mode)');
            statusIndicator.text('Подключение к REAPER...');
            wwr_start();
            if (typeof window !== 'undefined' && typeof window.wwr_req === 'function' && !wwr_is_enabled) {
                wwr_is_enabled = true;
                console.debug('[Prompter][wwr] enabled (initialize)');
            }
            eventBus.start();
            const cachedSnapshot = loadProjectDataCache();
            if (cachedSnapshot) {
                applyProjectDataSnapshot(cachedSnapshot, { source: 'cache', reason: 'initialize' });
                statusIndicator.text('Данные проекта загружены из кэша, обновляем...');
            }
            getProjectData('initialize', { allowCache: false, forceReload: true }).catch(err => {
                console.error('[Prompter] failed to refresh project data on init', err);
            });
            wwr_req_recur("TRANSPORT", 20);
            renderLoop();
            evaluateTransportWrap();
            const t1 = performance.now();
            console.info('[Prompter] initialize done', { ms: Math.round(t1 - t0) });
        } catch(e) { console.error("Error in initialize:", e); }
    }

    async function getText(trackId) {
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
        statusIndicator.text('Синхронизация ролей...');
        console.debug('[Prompter] ensure roles before subtitles', { trackId });
        let rolesEnsureInfo = null;
        try {
            rolesEnsureInfo = await ensureRolesLoaded({ reason: 'before_subtitles' });
            console.debug('[Prompter] roles ensure result', rolesEnsureInfo);
        } catch (err) {
            console.error('[Prompter][roles][ensure] failed before subtitles', err);
            rolesEnsureInfo = { status: 'error', error: err ? err.message : 'unknown' };
        }
        if (rolesEnsureInfo && rolesEnsureInfo.status === 'error') {
            console.warn('[Prompter] продолжим загрузку субтитров несмотря на ошибку загрузки ролей');
        }
        const ensureStatus = rolesEnsureInfo ? rolesEnsureInfo.status : null;
        const statusText = ensureStatus === 'timeout'
            ? `Роли не ответили вовремя, запрашиваем текст с дорожки ${trackId}...`
            : ensureStatus === 'error'
                ? `Ошибка при загрузке ролей, запрашиваем текст с дорожки ${trackId}...`
                : ensureStatus === 'empty'
                    ? `Роли не найдены, запрашиваем текст с дорожки ${trackId}...`
                    : `Запрос текста с дорожки ${trackId}...`;
        subtitleLoadInFlight = true; subtitleLoadTrackId = trackId;
        statusIndicator.text(statusText);
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
                .finally(() => {
                    subtitleLoadInFlight = false;
                    const t1 = performance.now();
                    const finalLog = {
                        ms: Math.round(t1 - t0),
                        rolesStatus: rolesEnsureInfo ? rolesEnsureInfo.status : 'n/a'
                    };
                    if (rolesEnsureInfo && typeof rolesEnsureInfo.durationMs === 'number') {
                        finalLog.rolesDurationMs = rolesEnsureInfo.durationMs;
                    }
                    console.debug('[Prompter] getText (real) total', finalLog);
                });
        }, 500);
    }
    
    wwr_onreply = function(results) {
        if (!results) return;
        if (!wwr_is_enabled) {
            if (typeof window !== 'undefined' && typeof window.wwr_req === 'function') {
                wwr_is_enabled = true;
                console.debug('[Prompter][wwr] enabled (first reply)');
            }
        }
        const lines = results.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split('\t');
            if (parts[0] === 'EXTSTATE' && parts[1] === 'PROMPTER_WEBUI') {
                const key = parts[2];
                const value = parts.slice(3).join('\t');
                resolveExtStateWaiter(key, value);
                if (key === 'roles_status') {
                    const status = parts.slice(3).join('\t');
                    handleRolesStatusMessage(status);
                } else if (key === 'event_queue') {
                    eventBus.ingestBackendQueue(value);
                }
            } else if (parts[0] === 'TRANSPORT') handleTransportResponse(parts);
        }
    };

    function applyTracks(tracks, meta = {}) {
        const list = Array.isArray(tracks) ? tracks : [];
        const reason = typeof meta.reason === 'string' ? meta.reason : '';
        const skipAutoFind = reason.startsWith('roles:') || reason.startsWith('emu:');
        const previousSelection = trackSelector.val();
        trackSelector.empty();
        list.forEach(track => {
            const rawId = track && typeof track.id !== 'undefined' ? track.id : '';
            let trackId = rawId;
            if (typeof rawId === 'string' && rawId.trim() !== '') {
                const parsedId = parseInt(rawId, 10);
                if (!Number.isNaN(parsedId)) trackId = parsedId;
            }
            let labelPrefix = '';
            if (typeof trackId === 'number' && Number.isFinite(trackId) && trackId >= 0) {
                labelPrefix = `${trackId + 1}: `;
            } else if (typeof rawId === 'string' && rawId.trim() !== '') {
                labelPrefix = `${rawId}: `;
            }
            const trackName = typeof track.name === 'string' ? track.name : '';
            const optionLabel = `${labelPrefix}${trackName}`;
            trackSelector.append(`<option value="${rawId}">${optionLabel}</option>`);
        });

        let selectionRestored = false;
        if (previousSelection !== undefined && previousSelection !== null && previousSelection !== '') {
            trackSelector.val(String(previousSelection));
            const restoredValue = trackSelector.val();
            selectionRestored = restoredValue !== null && String(restoredValue) === String(previousSelection);
        }

        if (list.length > 0) {
            statusIndicator.text('Список дорожек загружен.');
            if (skipAutoFind) {
                if (!selectionRestored && !trackSelector.val()) {
                    trackSelector.find('option:first').prop('selected', true);
                }
                console.debug('[Prompter][tracks] auto selection skipped', { reason, restored: selectionRestored, options: trackSelector.find('option').length });
            } else {
                autoFindSubtitleTrack();
            }
        } else {
            statusIndicator.text('Дорожки не найдены.');
        }

        if (!skipAutoFind && (!subtitleData || subtitleData.length === 0) && trackSelector.find('option').length > 0) {
            setTimeout(() => {
                if ((!subtitleData || subtitleData.length === 0) && trackSelector.find('option').length > 0) {
                    console.debug('[Prompter][tracks] retry initial text load');
                    if (!settings.autoFindTrack) {
                        trackSelector.find('option:first').prop('selected', true);
                        getText(trackSelector.val());
                    } else {
                        autoFindSubtitleTrack();
                    }
                }
            }, 800);
        } else if (skipAutoFind) {
            console.debug('[Prompter][tracks] retry initial text load skipped', { reason, restored: selectionRestored });
        }
        console.debug('[Prompter] tracks applied', { count: list.length });
    }

    function renderLoop() {
        try {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            let effectiveTimecode = latestTimecode;
            if (transportPlayState === 1 || transportPlayState === 5) {
                const deltaSeconds = Math.max(0, (now - transportLastUpdateAt) / 1000);
                effectiveTimecode = transportLastTimecode + deltaSeconds;
            }
            updateTeleprompter(effectiveTimecode);
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
    function normalizeReferencePath(value, fallback) {
        const raw = (typeof value === 'string' && value.trim() !== '') ? value.trim() : fallback;
        const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
        const safeParts = normalized.split('/').filter(part => part && part !== '.' && part !== '..');
        return safeParts.join('/');
    }
    let transportEmuTimer = null;
    function startTransportEmu(intervalMs = 50) {
        try {
            if (transportEmuTimer) { clearInterval(transportEmuTimer); transportEmuTimer = null; }
            let playState = getStartStatusFromQuery();
            let current = getStartSecondsFromQuery();
            latestTimecode = current;
            transportPlayState = playState;
            transportLastTimecode = current;
            transportLastUpdateAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
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
        if (emuDataLoadedOnce) {
            console.debug('[EMU] loadEmuData skipped (already loaded once)');
            return;
        }
        emuDataLoadedOnce = true;
        try {
            // Settings first (optional)
            const T0 = performance.now();
            // 1) Roles first
            if (!emuRolesFetchPromise) {
                emuRolesFetchAttempted = true;
                const cachedMissing = getEmuRolesMissingFlag();
                if (cachedMissing) {
                    console.debug('[EMU] roles.json fetch skipped (cached missing flag)');
                    emuRolesFetchPromise = Promise.resolve({ status: 'missing_cached' });
                } else {
                const urlTs = Date.now();
                const url = `reference/roles.json?_ts=${urlTs}`;
                const rStart = performance.now();
                console.debug('[EMU] roles.json request start', { url });
                emuRolesFetchPromise = fetch(url)
                    .then(async rr => {
                        const r1 = performance.now();
                        if (rr.ok) {
                            const rolesObj = await rr.json();
                            integrateLoadedRoles(JSON.stringify(rolesObj), { source: 'emu_reference' });
                            console.info('[EMU] roles.json loaded from reference', { ms: Math.round(r1 - rStart), url });
                            setEmuRolesMissingFlag(false);
                            return { status: 'ok' };
                        }
                        console.debug('[EMU] roles.json not found', { status: rr.status, ms: Math.round(r1 - rStart), url });
                        setEmuRolesMissingFlag(true);
                        return { status: 'missing', statusCode: rr.status };
                    })
                    .catch(err => {
                        console.debug('[EMU] roles.json not loaded', err);
                        setEmuRolesMissingFlag(true);
                        return { status: 'error', error: err ? err.message : 'unknown' };
                    })
                    .finally(() => {
                        const elapsed = Math.round(performance.now() - rStart);
                        console.debug('[EMU] roles.json request complete', { url, ms: elapsed });
                    });
                }
            } else {
                console.debug('[EMU] roles.json fetch skipped (already pending or finished)');
            }
            await emuRolesFetchPromise;
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
            const sp = new URLSearchParams(window.location.search);
            let subtitlePath = normalizeReferencePath(sp.get('subtitle'), 'emu/subtitles');
            if (subtitlePath.toLowerCase().endsWith('.json')) subtitlePath = subtitlePath.slice(0, -5);
            const subtitleDatasetDir = subtitlePath.includes('/') ? subtitlePath.slice(0, subtitlePath.lastIndexOf('/')) : '';
            let projectPath = normalizeReferencePath(sp.get('emuproject'), subtitleDatasetDir ? `${subtitleDatasetDir}/project-data` : 'emu/project-data');
            if (projectPath.toLowerCase().endsWith('.json')) projectPath = projectPath.slice(0, -5);
            const projectUrl = `reference/${projectPath}.json?_ts=${Date.now()}`;
            let projectApplied = false;
            const p0 = performance.now();
            try {
                console.info('[EMU] loading project data', { url: projectUrl });
                const projectResp = await fetch(projectUrl);
                if (projectResp.ok) {
                    const projectSnapshot = await projectResp.json();
                    storeProjectDataCache(projectSnapshot);
                    const applyInfo = applyProjectDataSnapshot(projectSnapshot, { source: 'emu_reference', reason: 'emu:project' });
                    statusIndicator.text('(EMU) Данные проекта загружены.');
                    console.info('[EMU] project data applied', {
                        ms: Math.round(performance.now() - p0),
                        tracks: applyInfo.applied.tracksCount,
                        project: projectSnapshot.project_name || 'n/a'
                    });
                    projectApplied = true;
                } else {
                    console.warn('[EMU] project data not found', { status: projectResp.status, url: projectUrl });
                }
            } catch (projectErr) {
                console.error('[EMU] project data load failed', projectErr);
            }

            if (!projectApplied) {
                const fallbackSnapshot = {
                    project_name: 'EMU Project',
                    tracks: [{ id: 0, name: 'Subtitles' }],
                    fps: { value: DEFAULT_PROJECT_FPS, raw: String(DEFAULT_PROJECT_FPS), dropFrame: false },
                    roles: null
                };
                storeProjectDataCache(fallbackSnapshot);
                applyProjectDataSnapshot(fallbackSnapshot, { source: 'emu_fallback', reason: 'emu:project_fallback' });
                statusIndicator.text('(EMU) Используется базовый набор данных проекта.');
            }

            const subtitleUrl = `reference/${subtitlePath}.json?_ts=${Date.now()}`;
            const f0 = performance.now();
            console.info('[EMU] loading subtitles', { url: subtitleUrl });
            statusIndicator.text('(EMU) Загрузка субтитров...');
            const resp = await fetch(subtitleUrl);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            await handleTextResponse(data);
            statusIndicator.text(`(EMU) Текст получен, всего ${Array.isArray(data) ? data.length : 0} реплик`);
            const f1 = performance.now();
            const T1 = performance.now();
            console.info('[EMU] subtitles loaded + rendered', { fetchAndRenderMs: Math.round(f1 - f0), totalMs: Math.round(T1 - T0), count: Array.isArray(data) ? data.length : 0, url: subtitleUrl });
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
            resetDataModel();
            subtitleData = subtitles;
            subtitlesLoadedOnce = true;
            currentLineIndex = -1;
            if (textDisplayEl) { textDisplayEl.textContent = ''; }
            else { textDisplay.empty(); }
            detachSharedProgress();
            sharedProgressBar.style.transform = 'scaleX(0)';
            clearTimecodeProgress();
            disconnectVisibilityObserver();
            resetVisibilityTracking();
            lastPreviousLineIndex = -1;
            const total = subtitleData.length;
            subtitleElements = new Array(total);
            subtitleContentElements = new Array(total);
            subtitleTimeElements = new Array(total);
            subtitleTimeLabelElements = new Array(total);
            subtitleTimeProgressElements = new Array(total);
            subtitlePaintStates = new Array(total);
            subtitleStyleMetadata = new Array(total);
            subtitleFilterStates = new Array(total);
            if (total === 0) {
                subtitleTimeElements = [];
                subtitleTimeLabelElements = [];
                subtitleTimeProgressElements = [];
                subtitleFilterStates = [];
                invalidateAllLinePaint({ resetBounds: true, schedule: false, immediate: true });
                finalizeDataModelUpdate();
                return;
            }
            // After loading subtitles we may need to refresh stats button visibility
            scheduleStatsButtonEvaluation();

            $('#dynamic-line-styles').remove();
            const displayNode = textDisplayEl || textDisplay[0];
            if (!displayNode) { console.error('[Prompter] text display container missing'); return; }

            const processRoles = !!settings.processRoles;
            const deduplicateRoles = !!settings.deduplicateRoles;
            const roleDisplayStyle = settings.roleDisplayStyle;
            const roleDisplayIsInline = roleDisplayStyle === 'inline';
            const roleDisplayIsColumn = roleDisplayStyle === 'column';
            const roleDisplayIsColumnWithSwatch = roleDisplayStyle === 'column_with_swatch';
            const enableColorSwatches = !!settings.enableColorSwatches;
            const checkerboardEnabled = !!settings.checkerboardEnabled;
            const checkerboardMode = settings.checkerboardMode;

            const includeRoleColumn = processRoles && (roleDisplayIsColumn || roleDisplayIsColumnWithSwatch);

            let lastRoleForCheckerboard = null;
            let lastColorForCheckerboard = null;
            let colorIndex = 0;

            // Build role->actor map once per render based on settings
            const tMap0 = performance.now();
            let roleMappingSize = 0;
            if (processRoles) {
                roleMappingSize = buildActorRoleMaps();
            }
            const tMap1 = performance.now();
            const shouldIgnoreLineColors = roleMappingSize > 0;
            const actorColorsMap = settings.actorColors || {};
            const configuredFrameRate = Number(settings.frameRate);
            const frameRate = Number.isFinite(configuredFrameRate) && configuredFrameRate > 0 ? configuredFrameRate : 24;
            const effectiveFormat = getEffectiveTimecodeFormat();
            const useActorMapping = shouldIgnoreLineColors;
            const useLineColor = !shouldIgnoreLineColors;
            let previousRoleRaw = null;

            // Build skeleton rows first, paint later
            const tBuild0 = performance.now();
            const dataModelFrameRate = PrompterTime.sanitizeFps(frameRate);
            const fragment = document.createDocumentFragment();
            for (let index = 0; index < total; index++) {
                const line = subtitleData[index];
                if (!line) {
                    subtitleFilterStates[index] = null;
                    continue;
                }

                subtitleStyleMetadata[index] = null;

                const rawText = line.text || '';
                let role = '';
                let displayText = rawText;
                if (processRoles && rawText.length > 0 && rawText.charCodeAt(0) === 91) {
                    const cachedParts = getCachedRoleParts(line, rawText);
                    if (cachedParts) {
                        role = cachedParts.role;
                        displayText = roleDisplayIsInline ? cachedParts.textInline : cachedParts.textTrimmed;
                    }
                }

                const container = document.createElement('div');
                container.className = 'subtitle-container';
                container.dataset.index = String(index);
                if (Number.isFinite(line.start_time)) {
                    container.dataset.startSeconds = String(line.start_time);
                } else {
                    delete container.dataset.startSeconds;
                }
                container.addEventListener('click', onSubtitleContainerClick);

                const contentElement = document.createElement('div');
                contentElement.className = 'subtitle-content';
                const bodyElement = document.createElement('div');
                bodyElement.className = 'subtitle-body';
                contentElement.appendChild(bodyElement);

                let roleAreaElement = null;
                if (includeRoleColumn) {
                    roleAreaElement = document.createElement('div');
                    roleAreaElement.className = 'role-area';
                }

                const textElement = document.createElement('span');
                textElement.className = 'subtitle-text';
                if (line.textHtml) {
                    textElement.innerHTML = line.textHtml;
                } else {
                    textElement.textContent = displayText;
                }

                subtitleContentElements[index] = contentElement;
                subtitlePaintStates[index] = -1;

                const showRoleInline = processRoles && !!role && !includeRoleColumn && roleDisplayIsInline;
                const showRoleInColumn = includeRoleColumn && !!role;

                let roleElement = null;
                if (includeRoleColumn) {
                    roleElement = document.createElement('span');
                    roleElement.className = 'subtitle-role column-role';
                } else if (showRoleInline) {
                    roleElement = document.createElement('span');
                    roleElement.className = 'subtitle-role inline-role';
                }

                let separatorElement = null;
                const includeSeparator = includeRoleColumn && !settings.swapColumns;
                if (includeSeparator) {
                    separatorElement = document.createElement('span');
                    separatorElement.className = 'subtitle-separator';
                }

                const sameRoleChain = !!(role && previousRoleRaw === role);
                previousRoleRaw = role || null;

                if (roleElement) {
                    if (roleElement.classList.contains('column-role')) {
                        const displayRole = showRoleInColumn ? ((deduplicateRoles && sameRoleChain) ? '\u00A0' : (role || '')) : '';
                        roleElement.textContent = displayRole;
                        roleElement.classList.toggle('role-hidden', !showRoleInColumn);
                    } else if (roleElement.classList.contains('inline-role')) {
                        roleElement.textContent = role;
                    }
                }

                let timeString;
                if (line.__cachedFrameRate === frameRate && line.__cachedTimecodeFormat === effectiveFormat && typeof line.__cachedTimecode === 'string') {
                    timeString = line.__cachedTimecode;
                } else {
                    timeString = formatTimecode(line.start_time, frameRate);
                    line.__cachedFrameRate = frameRate;
                    line.__cachedTimecodeFormat = effectiveFormat;
                    line.__cachedTimecode = timeString;
                }
                const timeElement = document.createElement('span');
                timeElement.className = 'subtitle-time';
                const timeLabelElement = document.createElement('span');
                timeLabelElement.className = 'subtitle-time-label';
                timeLabelElement.textContent = timeString;
                const timeProgressElement = document.createElement('span');
                timeProgressElement.className = 'subtitle-time-progress';
                timeProgressElement.setAttribute('aria-hidden', 'true');
                timeProgressElement.style.transform = 'scaleX(0)';
                timeElement.appendChild(timeLabelElement);
                timeElement.appendChild(timeProgressElement);
                subtitleTimeElements[index] = timeElement;
                subtitleTimeLabelElements[index] = timeLabelElement;
                subtitleTimeProgressElements[index] = timeProgressElement;

                let checkerboardClass = '';
                if (checkerboardEnabled) {
                    if (checkerboardMode === 'unconditional') {
                        checkerboardClass = `checkerboard-color-${(index % 2) + 1}`;
                    } else if (checkerboardMode === 'by_role') {
                        const currentRole = role || 'no_role';
                        if (currentRole !== lastRoleForCheckerboard) {
                            colorIndex = 1 - colorIndex;
                            lastRoleForCheckerboard = currentRole;
                        }
                        checkerboardClass = `checkerboard-color-${colorIndex + 1}`;
                    } else if (checkerboardMode === 'by_color') {
                        const currentColor = line.color || 'no_color';
                        if (currentColor !== lastColorForCheckerboard) {
                            colorIndex = 1 - colorIndex;
                            lastColorForCheckerboard = currentColor;
                        }
                        checkerboardClass = `checkerboard-color-${colorIndex + 1}`;
                    }
                }

                const actor = role && useActorMapping ? roleToActor[role] || null : null;
                const actorColor = actor ? actorColorsMap[actor] || null : null;
                const lineColor = useLineColor ? (line.color || null) : null;
                const finalRoleColorCandidate = actorColor || lineColor || null;

                let swatchElement = null;
                const showColumnSwatch = enableColorSwatches && finalRoleColorCandidate && roleDisplayIsColumn;
                const showInlineSwatch = enableColorSwatches && finalRoleColorCandidate && !roleDisplayIsColumn && !roleDisplayIsColumnWithSwatch && !showRoleInColumn;

                if (roleElement) {
                    if (actor) {
                        roleElement.title = actor;
                    } else if (roleElement.title) {
                        roleElement.removeAttribute('title');
                    }
                    // Clear inline styles upfront; visible rows get colors during paint pass.
                    roleElement.style.backgroundColor = '';
                    roleElement.style.color = '';
                    roleElement.classList.remove('role-colored');
                }

                if (enableColorSwatches && finalRoleColorCandidate) {
                    if (showColumnSwatch) {
                        swatchElement = document.createElement('span');
                        swatchElement.className = 'subtitle-color-swatch column-swatch';
                    } else if (showInlineSwatch) {
                        swatchElement = document.createElement('span');
                        swatchElement.className = 'subtitle-color-swatch inline-swatch';
                    }
                }

                const shouldColorRole = showRoleInColumn && roleDisplayIsColumnWithSwatch && enableColorSwatches && !!finalRoleColorCandidate;
                const shouldColorColumnSwatch = !!(swatchElement && swatchElement.classList.contains('column-swatch'));
                const shouldColorInlineSwatch = !!(swatchElement && swatchElement.classList.contains('inline-swatch'));

                let meta = null;
                if (checkerboardClass) {
                    meta = { checkerboardClass, checkerboardApplied: false, colorInfo: null, colorApplied: false };
                }
                if (shouldColorRole || shouldColorColumnSwatch || shouldColorInlineSwatch) {
                    if (!meta) {
                        meta = { checkerboardClass: checkerboardClass || '', checkerboardApplied: false, colorInfo: null, colorApplied: false };
                    }
                    meta.colorInfo = {
                        color: finalRoleColorCandidate,
                        roleElement: shouldColorRole ? roleElement : null,
                        columnSwatch: shouldColorColumnSwatch ? swatchElement : null,
                        inlineSwatch: shouldColorInlineSwatch ? swatchElement : null
                    };
                    meta.colorApplied = false;
                }
                if (meta) {
                    if (!meta.checkerboardClass && checkerboardClass) {
                        meta.checkerboardClass = checkerboardClass;
                    }
                    subtitleStyleMetadata[index] = meta;
                }

                if (separatorElement) {
                    const hasColumnVisuals = showRoleInColumn || showColumnSwatch;
                    separatorElement.classList.toggle('separator-hidden', !hasColumnVisuals);
                }

                container.classList.toggle('role-slot-empty', includeRoleColumn && !(showRoleInColumn || showColumnSwatch));
                if (roleAreaElement) {
                    const roleAreaIsEmpty = !(showRoleInColumn || showColumnSwatch);
                    roleAreaElement.classList.toggle('role-area-is-empty', roleAreaIsEmpty);
                }

                subtitleElements[index] = container;

                const startSecondsRaw = Number(line.start_time);
                const startSeconds = Number.isFinite(startSecondsRaw) ? startSecondsRaw : 0;
                const endSecondsRaw = Number(line.end_time);
                const endSeconds = Number.isFinite(endSecondsRaw) ? endSecondsRaw : startSeconds;
                const durationSeconds = Math.max(0, endSeconds - startSeconds);
                const startMs = Math.max(0, Math.round(startSeconds * 1000));
                const endMs = Math.max(startMs, Math.round(endSeconds * 1000));
                const lineId = resolveDataModelLineId(line, index);
                recordDataModelLine({
                    id: lineId,
                    index,
                    startSeconds,
                    endSeconds,
                    durationSeconds,
                    startFrame: PrompterTime.msToFrames(startMs, dataModelFrameRate),
                    endFrame: PrompterTime.msToFrames(endMs, dataModelFrameRate),
                    frameRate: dataModelFrameRate,
                    timecode: timeString,
                    rawText,
                    displayText,
                    html: line.textHtml || null,
                    roleId: role || null,
                    actorId: actor || null,
                    roleBaseColor: finalRoleColorCandidate || null,
                    actorColor,
                    lineColor,
                    resolvedColor: finalRoleColorCandidate || null
                });
                subtitleFilterStates[index] = {
                    roleId: role || null,
                    actorId: actor || null,
                    lineId,
                    filtered: false,
                    reason: null
                };

                container.appendChild(timeElement);

                if (roleAreaElement) {
                    if (swatchElement && swatchElement.classList.contains('column-swatch')) {
                        roleAreaElement.appendChild(swatchElement);
                    }

                    if (roleElement && roleElement.classList.contains('column-role')) {
                        roleAreaElement.appendChild(roleElement);
                    }

                    if (separatorElement) {
                        roleAreaElement.appendChild(separatorElement);
                    }

                    container.appendChild(roleAreaElement);
                }

                if (roleElement && roleElement.classList.contains('inline-role')) {
                    bodyElement.appendChild(roleElement);
                }

                if (swatchElement && swatchElement.classList.contains('inline-swatch')) {
                    bodyElement.appendChild(swatchElement);
                }

                bodyElement.appendChild(textElement);
                container.appendChild(contentElement);
                fragment.appendChild(container);
            }
            const tBuild1 = performance.now();
            finalizeDataModelUpdate();
            const tAppend0 = performance.now();
            displayNode.appendChild(fragment);
            const tAppend1 = performance.now();
            setupVisibilityObserver();
            invalidateAllLinePaint({ resetBounds: true, schedule: false, immediate: true });
            schedulePaintVisible();
            const t1 = performance.now();
            const renderMs = t1 - t0;
            const renderSeconds = renderMs / 1000;
            statusIndicator.text(`Текст получен, всего ${subtitleData.length} реплик (рендер ${renderSeconds.toFixed(3)} с)`);
            if (firstRenderTs === null) {
                firstRenderTs = t1;
                logReadyStage(isEmuMode() ? 'emu_first_render' : 'reaper_first_render');
            }
            console.info('[Prompter] handleTextResponse done', {
                msTotal: Math.round(renderMs),
                secondsTotal: Number(renderSeconds.toFixed(3)),
                msMap: Math.round(tMap1 - tMap0),
                msBuild: Math.round(tBuild1 - tBuild0),
                msDomAppend: Math.round(tAppend1 - tAppend0),
                total: subtitleData.length
            });
            // Снимаем обработчики виртуализации если были
            try {
                const wrapperNode = textDisplayWrapperEl || textDisplayWrapper[0] || null;
                if (wrapperNode && window.__vwinScrollHandler) { wrapperNode.removeEventListener('scroll', window.__vwinScrollHandler); window.__vwinScrollHandler = null; }
                if (window.__vwinResizeHandler) { window.removeEventListener('resize', window.__vwinResizeHandler); window.__vwinResizeHandler = null; }
                if (wrapperNode && window.__vwinWheelHandler) { wrapperNode.removeEventListener('wheel', window.__vwinWheelHandler); window.__vwinWheelHandler = null; }
                if (wrapperNode && window.__vwinTouchHandler) { wrapperNode.removeEventListener('touchmove', window.__vwinTouchHandler); window.__vwinTouchHandler = null; }
            } catch(_){}
            renderRoleFilterChips();
            updateFilterRuntimeFromSettings();
            recomputeFilteringState({ reason: 'data_load', force: true });
            updateTeleprompter(latestTimecode);
        } catch (e) { console.error("Error in handleTextResponse:", e); }
    }

    // removed unused createSubtitleElement (legacy from virtualization)

    // === Actor Coloring Utilities ===
    function normalizeTokenForLengthCheck(token) {
        const stripped = token.replace(/["'`«»“”„‚\[\]{}()<>]/g, '')
            .replace(/[.,;:!?]+$/g, '')
            .replace(/^[-—–]+|[-—–]+$/g, '');
        return stripped;
    }

    function splitActorAndPromotedRoles(actorRaw, rolesPartRaw, options = {}) {
        const {
            keepShortTokens = false,
            allowLongUppercaseActorTokens = false
        } = options;
        const tokens = (actorRaw || '').split(/\s+/).filter(Boolean);
        if (!tokens.length) return { actor: '', rolesPart: rolesPartRaw || '' };
        const actorTokens = [tokens[0]];
        const promotableShortTokens = [];
        const promotedRoleTokens = [];
        for (let i = 1; i < tokens.length; i += 1) {
            const token = tokens[i];
            const normalized = normalizeTokenForLengthCheck(token).replace(/\./g, '');
            if (!normalized) continue;
            const hasLowercase = /[a-zа-яё]/.test(token);
            const isShort = normalized.length <= 2;
            const hasDot = token.includes('.');
            const isLongUppercase = !hasLowercase && !hasDot && normalized.length > 2;
            if (hasLowercase || hasDot || (normalized.length > 2 && (!isLongUppercase || allowLongUppercaseActorTokens))) {
                actorTokens.push(token);
                continue;
            }
            if (isLongUppercase && !allowLongUppercaseActorTokens) {
                const cleanRole = token.replace(/[.,;:]+$/g, '');
                promotedRoleTokens.push(cleanRole);
                continue;
            }
            if (isShort && !keepShortTokens) {
                promotableShortTokens.push(token);
                continue;
            }
            if (isShort && keepShortTokens) {
                actorTokens.push(token);
                continue;
            }
            const cleanRole = token.replace(/[.,;:]+$/g, '');
            promotedRoleTokens.push(cleanRole);
        }

        if (promotableShortTokens.length) {
            if (keepShortTokens) {
                actorTokens.push(...promotableShortTokens);
            } else {
                if (promotableShortTokens.length >= 2) {
                    actorTokens.push(promotableShortTokens.shift());
                }
                promotableShortTokens.forEach(token => {
                    const cleanRole = token.replace(/[.,;:]+$/g, '');
                    promotedRoleTokens.push(cleanRole);
                });
            }
        }


        const finalActor = actorTokens.join(' ').trim();
        let rolesPart = rolesPartRaw ? rolesPartRaw.trim() : '';
        if (promotedRoleTokens.length) {
            const promoted = promotedRoleTokens.join(', ');
            rolesPart = rolesPart ? `${promoted}, ${rolesPart}` : promoted;
        }
        return { actor: finalActor, rolesPart };
    }

    function shouldPreferAutoDelimiter(beforeTokens, fullTokens) {
        const count = beforeTokens.length;
        if (count <= 1) return false;
        if (count >= 3) return true;
        const firstToken = beforeTokens[0] || '';
        const secondToken = beforeTokens[1] || '';
        const firstHasLowercase = /[a-zа-яё]/.test(firstToken);
        const secondHasLowercase = /[a-zа-яё]/.test(secondToken);
        const secondHasDot = secondToken.includes('.');
        if (count >= 2 && firstHasLowercase && !secondHasLowercase && !secondHasDot) {
            return true;
        }
        const lastToken = normalizeTokenForLengthCheck(beforeTokens[count - 1]);
        if (!lastToken) return false;
        if (lastToken.length <= 2) return true;
        if (/\d/.test(lastToken)) return true;
        return false;
    }

    function deriveAutoActorRoles(tokens, options = {}) {
        if (!Array.isArray(tokens) || !tokens.length) {
            return { actor: '', rolesPart: '' };
        }
        const beforeCount = Array.isArray(options.beforeTokens) ? options.beforeTokens.length : null;
        const allowShortSecond = typeof options.allowShortSecond === 'boolean' ? options.allowShortSecond : true;
        const actorTokens = [];
        let idx = 0;
        let shortUpperTokensAdded = 0;
        while (idx < tokens.length) {
            const token = tokens[idx];
            if (!token) { idx += 1; continue; }
            const stripped = token.replace(/[.,;:]+$/g, '');
            const hadTrailingDelimiter = stripped.length !== token.length;
            const hasLowercase = /[a-zа-яё]/.test(stripped);
            const hasDot = token.includes('.');
            const len = stripped.length;
            const isShortUpper = len > 0 && len <= 2 && !hasLowercase && !hasDot;
            let allow = false;
            if (actorTokens.length === 0) {
                allow = true;
            } else if (actorTokens.length === 1) {
                if (hasLowercase || hasDot) {
                    allow = true;
                } else if (allowShortSecond && isShortUpper && shortUpperTokensAdded === 0 && !hadTrailingDelimiter) {
                    allow = true;
                }
            } else if (actorTokens.length === 2) {
                if (hasLowercase || hasDot) {
                    allow = true;
                }
            }
            if (!allow) break;
            actorTokens.push(stripped);
            if (isShortUpper) {
                shortUpperTokensAdded += 1;
            }
            idx += 1;
            if (hadTrailingDelimiter) break;
        }
        const actorRaw = actorTokens.join(' ').trim();
        const rolesPartRaw = tokens.slice(idx).join(' ').trim();
        return { actor: actorRaw, rolesPart: rolesPartRaw };
    }

    function parseActorRoleMapping(rawText) {
        const lines = (rawText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const delimiterFrequency = new Map();
        const parsedLines = [];
        let validEntryCount = 0;
        let autoValidCount = 0;
        for (const line of lines) {
            const tokens = line.split(/\s+/).filter(Boolean);
            if (!tokens.length) {
                parsedLines.push({ actor: '', roles: [], delimiter: 'auto' });
                continue;
            }

            let actor = '';
            let rolesPart = '';
            let delimiter = 'auto';

            const colonMatch = line.match(/^(.+?)\:\s*(.+)$/);
            if (colonMatch) {
                const processed = splitActorAndPromotedRoles((colonMatch[1] || '').trim(), (colonMatch[2] || '').trim(), { keepShortTokens: false, allowLongUppercaseActorTokens: true });
                actor = processed.actor;
                rolesPart = processed.rolesPart;
                delimiter = ':';
            } else {
                const dashMatch = line.match(/^(.+?)\s*[-–]\s*(.+)$/);
                if (dashMatch) {
                    const processed = splitActorAndPromotedRoles((dashMatch[1] || '').trim(), (dashMatch[2] || '').trim(), { keepShortTokens: false, allowLongUppercaseActorTokens: true });
                    actor = processed.actor;
                    rolesPart = processed.rolesPart;
                    delimiter = '-';
                } else {
                    const commaMatch = line.match(/^(.+?),\s*(.+)$/);
                    if (commaMatch) {
                        const before = (commaMatch[1] || '').trim();
                        const after = (commaMatch[2] || '').trim();
                        const beforeTokens = before.split(/\s+/).filter(Boolean);
                        if (shouldPreferAutoDelimiter(beforeTokens, tokens)) {
                            const processed = deriveAutoActorRoles(tokens, { beforeTokens, allowShortSecond: true });
                            actor = processed.actor;
                            rolesPart = processed.rolesPart;
                            delimiter = 'auto';
                        } else {
                            const processed = splitActorAndPromotedRoles(before, after, { keepShortTokens: false });
                            actor = processed.actor;
                            rolesPart = processed.rolesPart;
                            delimiter = ',';
                        }
                    } else {
                        const processed = deriveAutoActorRoles(tokens);
                        actor = processed.actor;
                        rolesPart = processed.rolesPart;
                        delimiter = 'auto';
                    }
                }
            }

            if (!actor || !rolesPart) {
                parsedLines.push({ actor: '', roles: [], delimiter });
                continue;
            }

            const roles = rolesPart.split(/[,;]+/).map(r => r.trim()).filter(Boolean);
            if (!roles.length) {
                parsedLines.push({ actor: '', roles: [], delimiter });
                continue;
            }

            parsedLines.push({ actor, roles, delimiter });
            validEntryCount += 1;
            if (delimiter === 'auto') {
                autoValidCount += 1;
            } else {
                delimiterFrequency.set(delimiter, (delimiterFrequency.get(delimiter) || 0) + 1);
            }
        }

        let chosenDelimiter = null;
        if (autoValidCount > 0 && autoValidCount >= validEntryCount - autoValidCount) {
            chosenDelimiter = 'auto';
        } else if (delimiterFrequency.size === 1) {
            chosenDelimiter = Array.from(delimiterFrequency.keys())[0];
        } else if (delimiterFrequency.size > 1) {
            const sorted = Array.from(delimiterFrequency.entries()).sort((a, b) => b[1] - a[1]);
            if (sorted[0][1] > sorted[1][1]) {
                chosenDelimiter = sorted[0][0];
            }
        }

        if (!validEntryCount) {
            actorRoleDelimiterWarning = '';
        } else if (!chosenDelimiter) {
            actorRoleDelimiterWarning = ACTOR_ROLE_DELIMITER_WARNING_TEXT;
        } else if (chosenDelimiter === 'auto' && delimiterFrequency.size > 0) {
            actorRoleDelimiterWarning = ACTOR_ROLE_DELIMITER_WARNING_TEXT;
        } else {
            actorRoleDelimiterWarning = '';
        }

        const result = {};
        for (const entry of parsedLines) {
            const { actor, roles, delimiter } = entry;
            if (!actor || !roles || !roles.length) continue;
            if (chosenDelimiter) {
                if (chosenDelimiter === 'auto') {
                    if (delimiter !== 'auto') continue;
                } else {
                    if (delimiter !== chosenDelimiter) continue;
                }
            }
            if (!result[actor]) result[actor] = [];
            roles.forEach(role => {
                if (!result[actor].includes(role)) {
                    result[actor].push(role);
                }
            });
        }
        return result;
    }

    function buildActorRoleMaps() {
        const mappingText = settings.actorRoleMappingText || '';
        if (mappingText !== cachedActorRoleMappingText) {
            roleToActor = {};
            actorToRoles = {};
            const parsed = parseActorRoleMapping(mappingText);
            Object.keys(parsed).forEach(actor => {
                const roles = parsed[actor];
                const roleSet = new Set(roles);
                actorToRoles[actor] = roleSet;
                roles.forEach(role => {
                    if (!roleToActor[role]) {
                        roleToActor[role] = actor; // first mapping wins
                    }
                });
            });
            cachedActorRoleMappingText = mappingText;
            cachedMappedRolesCount = Object.keys(roleToActor).length;
        }
        assignDefaultActorColors();
        return cachedMappedRolesCount;
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

    function computeFilterDimOpacity(percent) {
        const numeric = Number(percent);
        const bounded = Number.isFinite(numeric) ? Math.max(10, Math.min(95, numeric)) : defaultSettings.filterDimPercent;
        const opacity = 1 - (bounded / 100);
        return Number(Math.max(0.05, Math.min(1, opacity)).toFixed(3));
    }

    function normalizeFilterList(value) {
        if (!value) return [];
        let candidates = [];
        if (Array.isArray(value)) {
            candidates = value;
        } else if (typeof value === 'string') {
            candidates = value.split(/[;,\r\n]+/);
        } else if (typeof value === 'object') {
            candidates = Object.keys(value).filter(key => {
                const val = value[key];
                if (typeof val === 'boolean') return val;
                if (typeof val === 'number') return Number.isFinite(val) ? val !== 0 : false;
                if (typeof val === 'string') return val.trim().length > 0;
                return false;
            });
        }
        const normalized = [];
        const seen = new Set();
        candidates.forEach(entry => {
            if (entry == null) return;
            const token = String(entry).trim();
            if (!token || seen.has(token)) return;
            seen.add(token);
            normalized.push(token);
        });
        return normalized;
    }

    function sanitizeFilterHiddenBehavior(value, fallback) {
        const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (raw === FILTER_BEHAVIOR_DIM || raw === 'shade' || raw === 'dim') {
            return FILTER_BEHAVIOR_DIM;
        }
        if (raw === FILTER_BEHAVIOR_HIDE || raw === 'hidden' || raw === 'hide') {
            return FILTER_BEHAVIOR_HIDE;
        }
        const fallbackRaw = typeof fallback === 'string' ? fallback.trim().toLowerCase() : '';
        return fallbackRaw === FILTER_BEHAVIOR_DIM ? FILTER_BEHAVIOR_DIM : FILTER_BEHAVIOR_HIDE;
    }

    function sanitizeFilterDimPercent(value, fallback) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            return Math.max(10, Math.min(90, Math.round(numeric)));
        }
        const fallbackNumeric = Number(fallback);
        if (Number.isFinite(fallbackNumeric)) {
            return Math.max(10, Math.min(90, Math.round(fallbackNumeric)));
        }
        return Math.max(10, Math.min(90, defaultSettings.filterDimPercent));
    }

    function updateFilterRuntimeFromSettings() {
        try {
            const behavior = sanitizeFilterHiddenBehavior(settings.filterHiddenBehavior, defaultSettings.filterHiddenBehavior);
            const dimPercent = sanitizeFilterDimPercent(settings.filterDimPercent, defaultSettings.filterDimPercent);
            settings.filterHiddenBehavior = behavior;
            settings.filterDimPercent = dimPercent;
            filterRuntime.behavior = behavior;
            filterRuntime.dimPercent = dimPercent;
            filterRuntime.dimOpacity = computeFilterDimOpacity(dimPercent);
            const overlayAlpha = Math.max(0, Math.min(0.95, 1 - filterRuntime.dimOpacity));
            filterRuntime.dimOverlayAlpha = Number(overlayAlpha.toFixed(3));

            const soloRoles = normalizeFilterList(settings.filterSoloRoles);
            const muteRoles = normalizeFilterList(settings.filterMuteRoles);
            const soloActors = normalizeFilterList(settings.filterSoloActors);
            const muteActors = normalizeFilterList(settings.filterMuteActors);
            const mutedRolesFromActors = collectRolesForActors(new Set(muteActors));
            const filteredSoloRoles = soloRoles.filter(role => !mutedRolesFromActors.has(role));
            settings.filterSoloRoles = filteredSoloRoles;
            settings.filterMuteRoles = muteRoles;
            settings.filterSoloActors = soloActors;
            settings.filterMuteActors = muteActors;
            filterRuntime.soloRoles = new Set(filteredSoloRoles);
            filterRuntime.muteRoles = new Set(muteRoles);
            filterRuntime.soloActors = new Set(soloActors);
            filterRuntime.muteActors = new Set(muteActors);
            filterRuntime.hasFilters = filterRuntime.soloRoles.size > 0 || filterRuntime.muteRoles.size > 0 || filterRuntime.soloActors.size > 0 || filterRuntime.muteActors.size > 0;

            if (typeof document !== 'undefined' && document.body) {
                document.body.setAttribute('data-filter-hidden-behavior', behavior);
                document.body.style.setProperty('--filter-dim-opacity', String(filterRuntime.dimOpacity));
                document.body.style.setProperty('--filter-dim-overlay-alpha', String(filterRuntime.dimOverlayAlpha));
            }
        } catch (err) {
            console.error('[Prompter][filters] runtime update failed', err);
        }
    }

    function evaluateFilterOutcome(meta) {
        if (!meta) return { filtered: false, reason: null };
        const actor = meta.actorId || '';
        const role = meta.roleId || '';
        const hasSoloActor = filterRuntime.soloActors.size > 0;
        const hasSoloRole = filterRuntime.soloRoles.size > 0;
        const actorSoloMatch = hasSoloActor && actor && filterRuntime.soloActors.has(actor);
        const roleSoloMatch = hasSoloRole && role && filterRuntime.soloRoles.has(role);
        const soloModeActive = hasSoloActor || hasSoloRole;
        if (soloModeActive) {
            if (actorSoloMatch || roleSoloMatch) {
                return { filtered: false, reason: null };
            }
            let reason = 'role_solo_exclusive';
            if (hasSoloActor && !hasSoloRole) {
                reason = 'actor_solo_exclusive';
            } else if (hasSoloActor && hasSoloRole) {
                reason = 'actor_role_solo_exclusive';
            }
            return { filtered: true, reason };
        }
        if (actor && filterRuntime.muteActors.has(actor)) {
            return { filtered: true, reason: 'actor_muted' };
        }
        if (role && filterRuntime.muteRoles.has(role)) {
            return { filtered: true, reason: 'role_muted' };
        }
        return { filtered: false, reason: null };
    }

    function applyFilterOutcomeToElement(index, outcome) {
        const container = subtitleElements[index];
        if (!container) return;
        const hide = outcome.filtered && filterRuntime.behavior === FILTER_BEHAVIOR_HIDE;
        const dim = outcome.filtered && filterRuntime.behavior === FILTER_BEHAVIOR_DIM;
        container.classList.toggle('filter-active', outcome.filtered);
        container.classList.toggle('filter-hidden', hide);
        container.classList.toggle('filter-dimmed', dim);
        if (hide) {
            if (container.style.display !== 'none') container.style.display = 'none';
            container.setAttribute('aria-hidden', 'true');
        } else {
            if (container.style.display) container.style.display = '';
            if (container.getAttribute('aria-hidden') === 'true') {
                container.removeAttribute('aria-hidden');
            }
        }
        if (!dim && container.classList.contains('filter-dimmed')) {
            container.classList.remove('filter-dimmed');
        }
        const meta = subtitleFilterStates[index];
        if (meta) {
            meta.filtered = outcome.filtered;
            meta.reason = outcome.filtered ? (outcome.reason || null) : null;
            const record = meta.lineId ? dataModel.lines.get(meta.lineId) : null;
            if (record) {
                record.isFiltered = meta.filtered;
                record.filterReason = meta.reason;
            }
        }
        if (outcome.filtered) {
            container.setAttribute('data-filter-reason', outcome.reason || '');
        } else {
            container.removeAttribute('data-filter-reason');
        }
    }

    function clearFilterClasses() {
        if (!subtitleElements || !subtitleElements.length) return;
        for (let index = 0; index < subtitleElements.length; index++) {
            const container = subtitleElements[index];
            if (!container) continue;
            container.classList.remove('filter-active', 'filter-hidden', 'filter-dimmed');
            if (container.style.display) container.style.display = '';
            container.removeAttribute('aria-hidden');
            container.removeAttribute('data-filter-reason');
            const meta = subtitleFilterStates[index];
            if (meta) {
                meta.filtered = false;
                meta.reason = null;
                const record = meta.lineId ? dataModel.lines.get(meta.lineId) : null;
                if (record) {
                    record.isFiltered = false;
                    record.filterReason = null;
                }
            }
        }
        filtersApplied = false;
    }

    function recomputeFilteringState(options = {}) {
        try {
            const force = options.force === true;
            if (!subtitleElements || !subtitleElements.length) {
                if (force) {
                    clearFilterClasses();
                }
                return;
            }
            if (!filterRuntime.hasFilters) {
                if (filtersApplied || force) {
                    clearFilterClasses();
                }
                return;
            }
            for (let index = 0; index < subtitleFilterStates.length; index++) {
                const meta = subtitleFilterStates[index];
                if (!meta) continue;
                const outcome = evaluateFilterOutcome(meta);
                if (!force && meta.filtered === outcome.filtered && meta.reason === outcome.reason) {
                    continue;
                }
                applyFilterOutcomeToElement(index, outcome);
            }
            filtersApplied = true;
        } catch (err) {
            console.error('[Prompter][filters] recompute failed', err);
        }
    }

    function getMutedActorsSet() {
        const source = Array.isArray(settings.filterMuteActors) ? settings.filterMuteActors : [];
        const normalized = source.filter(Boolean);
        return new Set(normalized);
    }

    function getSoloActorsSet() {
        const list = Array.isArray(settings.filterSoloActors) ? settings.filterSoloActors : [];
        const filtered = list.filter(Boolean);
        return new Set(filtered);
    }

    function getSoloRolesSet() {
        const list = Array.isArray(settings.filterSoloRoles) ? settings.filterSoloRoles : [];
        const filtered = list.filter(Boolean);
        return new Set(filtered);
    }

    function collectRolesForActors(actorSet) {
        const result = new Set();
        if (!actorSet || typeof actorSet.forEach !== 'function') return result;
        buildActorRoleMaps();
        actorSet.forEach(actor => {
            if (!actor) return;
            const roles = actorToRoles[actor];
            if (!roles || typeof roles.forEach !== 'function') return;
            roles.forEach(role => {
                if (role) result.add(role);
            });
        });
        return result;
    }

    function refreshActorFilterControlsUI() {
        const container = $('#actor-color-list');
        if (!container.length) return;
        const muteSet = getMutedActorsSet();
        const soloSet = getSoloActorsSet();
        const soloActive = soloSet.size > 0;
        container.toggleClass('solo-mode-active', soloActive);
        container.find('.actor-color-item').each(function(){
            const row = $(this);
            const actor = String(row.data('actor') || '');
            const isMuted = muteSet.has(actor);
            const isSolo = soloSet.has(actor);
            row.attr('data-muted', isMuted ? 'true' : 'false');
            row.attr('data-solo', isSolo ? 'true' : 'false');
            row.toggleClass('is-muted', isMuted && !isSolo);
            row.toggleClass('is-solo-active', isSolo);
            row.toggleClass('is-solo-dimmed', soloActive && !isSolo);
            const muteBtn = row.find('.actor-filter-btn[data-action="mute"]');
            const soloBtn = row.find('.actor-filter-btn[data-action="solo"]');
            muteBtn.attr('aria-pressed', isMuted ? 'true' : 'false');
            soloBtn.attr('aria-pressed', isSolo ? 'true' : 'false');
        });
    }

    function buildRoleSyncStateFromActors() {
        buildActorRoleMaps();
        const roleState = new Map();
        const soloActors = getSoloActorsSet();
        const muteActors = getMutedActorsSet();
        Object.keys(actorToRoles).forEach(actor => {
            const roles = actorToRoles[actor];
            if (!roles || typeof roles.forEach !== 'function') return;
            roles.forEach(role => {
                if (!role) return;
                let entry = roleState.get(role);
                if (!entry) {
                    entry = { actorSolo: false, actorMuted: false };
                    roleState.set(role, entry);
                }
                if (soloActors.has(actor)) entry.actorSolo = true;
                if (muteActors.has(actor)) entry.actorMuted = true;
            });
        });
        return roleState;
    }

    function collectAvailableRolesForFilter() {
        buildActorRoleMaps();
        const roleSet = new Set();
        Object.keys(actorToRoles).forEach(actor => {
            const roles = actorToRoles[actor];
            if (!roles || typeof roles.forEach !== 'function') return;
            roles.forEach(role => { if (role) roleSet.add(role); });
        });
        const unassigned = computeUnassignedRoles();
        if (Array.isArray(unassigned)) {
            unassigned.forEach(role => { if (role) roleSet.add(role); });
        }
        return Array.from(roleSet).sort((a, b) => a.localeCompare(b, 'ru'));
    }

    function refreshRoleFilterControlsUI() {
        const manualSoloSet = getSoloRolesSet();
        const derivedState = buildRoleSyncStateFromActors();
        const effectiveSoloSet = new Set();
        manualSoloSet.forEach(role => {
            const derived = derivedState.get(role);
            if (!derived || derived.actorMuted !== true) {
                effectiveSoloSet.add(role);
            }
        });
        derivedState.forEach((state, role) => {
            if (state.actorSolo && !state.actorMuted) effectiveSoloSet.add(role);
        });

        const effectiveSoloCount = effectiveSoloSet.size;
        const countEl = $('#role-filter-count');
        if (countEl.length) {
            const countVisible = effectiveSoloCount > 0;
            countEl.text(countVisible ? `(${effectiveSoloCount})` : '');
            countEl.toggleClass('is-visible', countVisible);
        }
        const labelEl = $('.role-filter-summary-label');
        if (labelEl.length) {
            labelEl.toggleClass('has-selection', effectiveSoloCount > 0);
        }
        const chips = $('#role-filter-chips');
        let manualNonDerivedExists = false;
        if (chips.length) {
            chips.toggleClass('has-selection', effectiveSoloCount > 0);
            chips.find('.role-filter-chip').each(function(){
                const chip = $(this);
                const role = String(chip.data('role') || '');
                const derived = derivedState.get(role) || { actorSolo: false, actorMuted: false };
                const manualActive = manualSoloSet.has(role);
                const isDisabled = derived.actorMuted === true;
                const actorProvidesSolo = derived.actorSolo && !derived.actorMuted;
                const isActive = !isDisabled && (manualActive || actorProvidesSolo);
                chip.prop('disabled', isDisabled);
                if (isDisabled) {
                    chip.attr('aria-disabled', 'true');
                } else {
                    chip.removeAttr('aria-disabled');
                }
                chip.toggleClass('is-active', isActive);
                chip.toggleClass('is-muted', derived.actorMuted && !actorProvidesSolo);
                chip.toggleClass('is-disabled', isDisabled);
                chip.attr('aria-pressed', isActive ? 'true' : 'false');
                chip.attr('data-actor-solo', derived.actorSolo ? 'true' : 'false');
                chip.attr('data-actor-muted', derived.actorMuted ? 'true' : 'false');
                if (!manualNonDerivedExists && manualActive && !derived.actorSolo && !isDisabled) {
                    manualNonDerivedExists = true;
                }
            });
        }
        if (!manualNonDerivedExists) {
            manualSoloSet.forEach(role => {
                if (manualNonDerivedExists) return;
                const derived = derivedState.get(role);
                if (!derived || !derived.actorSolo) {
                    manualNonDerivedExists = true;
                }
            });
        }
        const resetButton = $('#role-filter-reset-button');
        if (resetButton.length) {
            const showButton = manualNonDerivedExists;
            resetButton.prop('hidden', !showButton);
            resetButton.prop('disabled', !showButton);
            if (showButton) {
                resetButton.removeAttr('aria-hidden');
            } else {
                resetButton.attr('aria-hidden', 'true');
            }
        }
    }

    function renderRoleFilterChips() {
        const chips = $('#role-filter-chips');
        if (!chips.length) return;
        const roles = collectAvailableRolesForFilter();
        chips.empty();
        if (!roles.length) {
            chips.append('<span class="role-filter-empty">Роли не обнаружены</span>');
            refreshRoleFilterControlsUI();
            return;
        }
        const soloSet = getSoloRolesSet();
        roles.forEach(role => {
            const chip = $('<button type="button" class="role-filter-chip" aria-pressed="false"></button>');
            chip.attr('data-role', role);
            chip.attr('aria-label', `Роль ${role}`);
            chip.text(role);
            if (soloSet.has(role)) {
                chip.addClass('is-active');
                chip.attr('aria-pressed', 'true');
            }
            chips.append(chip);
        });
        refreshRoleFilterControlsUI();
    }

    function syncActorFilterSettings(options = {}) {
        try {
            updateFilterRuntimeFromSettings();
            recomputeFilteringState({ force: true });
        } catch (err) {
            console.error('[Prompter][filters] sync failed', err);
        }
        if (options.persistToLocalStorage !== false) {
            try {
                localStorage.setItem('teleprompterSettings', JSON.stringify(settings));
            } catch (storageErr) {
                console.debug('[Prompter][filters] localStorage persist skipped', storageErr);
            }
        }
        if (options.persistBackend === true && !isEmuMode()) {
            settings.dataModelVersion = DATA_MODEL_VERSION;
            settings.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
            persistSettingsToBackend(settings, { reason: options.reason || 'actor_filter_update' });
        }
        refreshRoleFilterControlsUI();
        refreshActorFilterControlsUI();
    }

    function setActorMuteState(actor, shouldMute) {
        if (!actor) return;
        const muteSet = getMutedActorsSet();
        if (shouldMute) {
            muteSet.add(actor);
        } else {
            muteSet.delete(actor);
        }
        settings.filterMuteActors = Array.from(muteSet);
        refreshActorFilterControlsUI();
        refreshRoleFilterControlsUI();
    }

    function toggleActorMuteState(actor) {
        if (!actor) return;
        const muteSet = getMutedActorsSet();
        const shouldMute = !muteSet.has(actor);
        setActorMuteState(actor, shouldMute);
        syncActorFilterSettings({ reason: 'actor_mute_toggle' });
    }

    function setSoloActorsSet(soloSet) {
        settings.filterSoloActors = Array.from(soloSet);
        refreshActorFilterControlsUI();
    }

    function removeSoloActor(actor) {
        if (!actor) return;
        const soloSet = getSoloActorsSet();
        if (soloSet.delete(actor)) {
            setSoloActorsSet(soloSet);
        }
    }

    function toggleActorSoloState(actor) {
        if (!actor) return;
        const soloSet = getSoloActorsSet();
        if (soloSet.has(actor)) {
            soloSet.delete(actor);
        } else {
            soloSet.add(actor);
        }
        setSoloActorsSet(soloSet);
        syncActorFilterSettings({ reason: 'actor_solo_toggle' });
    }

    function setSoloRolesSet(soloSet, options = {}) {
        settings.filterSoloRoles = Array.from(soloSet);
        if (options.skipRefresh !== true) {
            refreshRoleFilterControlsUI();
        }
    }

    function toggleRoleSoloState(role) {
        if (!role) return;
        const mutedRoles = collectRolesForActors(getMutedActorsSet());
        if (mutedRoles.has(role)) return;
        const soloSet = getSoloRolesSet();
        if (soloSet.has(role)) {
            soloSet.delete(role);
        } else {
            soloSet.add(role);
        }
        setSoloRolesSet(soloSet);
        syncActorFilterSettings({ reason: 'role_filter_toggle' });
    }

    function clearManualRoleSoloFilters(options = {}) {
        const hasManualRoles = Array.isArray(settings.filterSoloRoles) && settings.filterSoloRoles.length > 0;
        if (!hasManualRoles) return false;
        setSoloRolesSet(new Set());
        syncActorFilterSettings({ reason: options.reason || 'role_filters_manual_reset' });
        return true;
    }

    function resetActorFilters() {
        settings.filterMuteActors = [];
        settings.filterSoloActors = [];
        settings.filterSoloRoles = [];
        settings.filterMuteRoles = [];
        syncActorFilterSettings({ reason: 'actor_filters_reset' });
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
                    <div class="actor-color-item-label"><span class="actor-name">${actor}</span></div>
                    <div class="actor-filter-controls" role="group" aria-label="Управление Solo/Mute">
                        <button type="button" class="actor-filter-btn actor-filter-btn-mute" data-action="mute" aria-pressed="false" title="Mute актёра">M</button>
                        <button type="button" class="actor-filter-btn actor-filter-btn-solo" data-action="solo" aria-pressed="false" title="Solo актёра">S</button>
                    </div>
                    <div class="actor-color-item-roles">${roles}</div>
                    <div class="actor-color-picker">
                        <input type="text" class="actor-color-input" value="${colorVal}" />
                    </div>
                    <button type="button" class="delete-actor-color" title="Удалить актёра">✕</button>
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
        refreshActorFilterControlsUI();
        updateUnassignedRolesUI();
        renderRoleFilterChips();
        scheduleStatsButtonEvaluation();
        updateActorRoleWarningBanner();
    }

    function updateActorRoleWarningBanner() {
        const warningBanner = $('#actor-role-warning');
        if (!warningBanner.length) return;
        if (actorRoleDelimiterWarning) {
            warningBanner.text(actorRoleDelimiterWarning);
            warningBanner.show();
            return;
        }
        if (subtitlesContainRoles()) {
            warningBanner.hide();
            warningBanner.text('');
        } else {
            warningBanner.html('Дорожка субтитров не содержит ролей, загрузите корректный файл и убедитесь, что реплики записаны в формате <code>[РОЛЬ] Реплика</code>.');
            warningBanner.show();
        }
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

    function subtitlesContainRoles() {
        if (!Array.isArray(subtitleData) || subtitleData.length === 0) return false;
        for (const line of subtitleData) {
            if (!line || typeof line.text !== 'string') continue;
            const extracted = extractLeadingRole(line.text, false);
            if (extracted && extracted.role) return true;
        }
        return false;
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

        const muteActors = [];
        const soloActors = [];
        $('#actor-color-list .actor-color-item').each(function(){
            const actor = $(this).data('actor');
            if (!actor) return;
            if ($(this).attr('data-muted') === 'true') {
                muteActors.push(actor);
            }
            if ($(this).attr('data-solo') === 'true') {
                soloActors.push(actor);
            }
        });
        settings.filterMuteActors = muteActors;
        settings.filterSoloActors = soloActors;

        rolesLoaded = Object.keys(newColors).length > 0 || (settings.actorRoleMappingText || '').trim().length > 0;
        saveRoles();
        syncActorFilterSettings({ persistBackend: true, reason: 'actors_modal_save' });
        // Перепарсим и перерисуем текст если уже загружен
        if (subtitleData.length > 0) handleTextResponse(subtitleData);
        updateActorRoleWarningBanner();
    }
    
    function handleTransportResponse(transportData) {
        try {
            if (transportData.length < 3) return;
            const playState = parseInt(transportData[1], 10);
            latestTimecode = parseFloat(transportData[2]);
            transportPlayState = Number.isFinite(playState) ? playState : 0;
            transportLastUpdateAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            transportLastTimecode = Number.isFinite(latestTimecode) ? latestTimecode : 0;
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
            if (!transportStageLogged) {
                transportStageLogged = true;
                logReadyStage(isEmuMode() ? 'emu_transport_update' : 'reaper_transport_update');
            }
        } catch(e) { console.error("Error in transport response:", e); }
    }

    function locateSubtitleIndexAtTime(currentTime) {
        const total = subtitleData.length;
        if (!total || !Number.isFinite(currentTime) || currentTime < subtitleData[0].start_time) {
            return { index: -1, inPause: false };
        }

        const lastIndex = total - 1;
        if (currentTime >= subtitleData[lastIndex].start_time) {
            const lastLine = subtitleData[lastIndex];
            return { index: lastIndex, inPause: currentTime >= lastLine.end_time };
        }

        const currIdx = currentLineIndex;
        if (currIdx >= 0 && currIdx < total) {
            const currentLine = subtitleData[currIdx];
            const nextStart = currIdx + 1 < total ? subtitleData[currIdx + 1].start_time : Number.POSITIVE_INFINITY;
            if (currentTime >= currentLine.start_time && currentTime < nextStart) {
                return { index: currIdx, inPause: currentTime >= currentLine.end_time };
            }
            if (currentTime < currentLine.start_time && currIdx > 0) {
                const prevLine = subtitleData[currIdx - 1];
                if (currentTime >= prevLine.start_time && currentTime < currentLine.start_time) {
                    return { index: currIdx - 1, inPause: currentTime >= prevLine.end_time };
                }
            }
            if (currentTime >= nextStart && currIdx + 1 < total) {
                const nextLine = subtitleData[currIdx + 1];
                const afterNextStart = currIdx + 2 < total ? subtitleData[currIdx + 2].start_time : Number.POSITIVE_INFINITY;
                if (currentTime >= nextLine.start_time && currentTime < afterNextStart) {
                    return { index: currIdx + 1, inPause: currentTime >= nextLine.end_time };
                }
            }
        }

        let lo = 0;
        let hi = total - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const line = subtitleData[mid];
            const start = line.start_time;
            const nextStart = mid + 1 < total ? subtitleData[mid + 1].start_time : Number.POSITIVE_INFINITY;
            if (currentTime < start) {
                hi = mid - 1;
                continue;
            }
            if (currentTime >= nextStart) {
                lo = mid + 1;
                continue;
            }
            return { index: mid, inPause: currentTime >= line.end_time };
        }

        const fallbackIdx = Math.max(0, Math.min(total - 1, lo));
        const fallbackLine = subtitleData[fallbackIdx];
        return { index: fallbackIdx, inPause: currentTime >= fallbackLine.end_time };
    }
    
    function updateTeleprompter(currentTime) {
        try {
            if (Number.isFinite(currentTime)) {
                lastPlaybackTimeSeconds = currentTime;
            }
            const highlightCurrentEnabled = settings.highlightCurrentEnabled !== false;
            const highlightPreviousEnabled = settings.highlightPreviousEnabled !== false;
            const highlightPauseEnabled = settings.highlightPauseEnabled !== false;
            const progressEnabled = settings.progressBarEnabled !== false;
            const progressMode = progressEnabled
                ? sanitizeProgressBarMode(settings.progressBarMode, defaultSettings.progressBarMode)
                : defaultSettings.progressBarMode;
            const useSubtitleProgress = progressEnabled && progressMode === 'subtitle';
            const useTimecodeProgress = progressEnabled && progressMode === 'timecode';
            const located = locateSubtitleIndexAtTime(currentTime);
            const newCurrentLineIndex = located.index;
            const inPause = located.inPause;
            const oldCurrentIndex = currentLineIndex;
            const indexChanged = newCurrentLineIndex !== oldCurrentIndex;
            const autoScrollEnabled = !!settings.autoScroll;
            const activeAutoScrollMode = sanitizeAutoScrollMode(settings.autoScrollMode, defaultSettings.autoScrollMode);
            let autoScrollPlan;
            let autoScrollPlanComputed = false;
            let autoScrollPlanWasUndefined = false;

            if (indexChanged && newCurrentLineIndex !== -1 && autoScrollEnabled) {
                const computedPlan = computeAutoScrollPlan(newCurrentLineIndex, { currentTime });
                autoScrollPlanComputed = true;
                if (typeof computedPlan === 'undefined') {
                    autoScrollPlanWasUndefined = true;
                } else {
                    autoScrollPlan = computedPlan;
                }
            }

            if (indexChanged && oldCurrentIndex !== -1) {
                const previousElement = subtitleElements[oldCurrentIndex];
                if (previousElement) {
                    previousElement.classList.remove('current-line');
                    previousElement.classList.remove('pause-highlight');
                    previousElement.classList.remove('previous-line');
                }
            }

            if (newCurrentLineIndex !== -1) {
                const newElement = subtitleElements[newCurrentLineIndex];
                if (newElement) {
                    // Always strip current-related classes first.
                    newElement.classList.remove('current-line');
                    if (!highlightPauseEnabled || !inPause || !highlightPreviousEnabled) {
                        newElement.classList.remove('pause-highlight');
                    }
                    if (!inPause || !highlightPreviousEnabled) {
                        newElement.classList.remove('previous-line');
                    }

                    if (!inPause) {
                        if (highlightCurrentEnabled) {
                            newElement.classList.add('current-line');
                        }
                    } else if (highlightPauseEnabled) {
                        if (!highlightPreviousEnabled) {
                            newElement.classList.add('pause-highlight');
                        }
                    }
                }
            }

            updatePreviousLineHighlightState({
                newCurrentLineIndex,
                previousIndex: oldCurrentIndex,
                inPause,
                highlightPreviousEnabled,
                highlightPauseEnabled,
                indexChanged
            });

            if (indexChanged) {
                if (useSubtitleProgress && newCurrentLineIndex !== -1) {
                    attachSharedProgressToIndex(newCurrentLineIndex);
                } else {
                    detachSharedProgress();
                }
                resetTransportProgress();
                clearTimecodeProgress();
                const previousIndex = oldCurrentIndex;
                currentLineIndex = newCurrentLineIndex;
                // Limit expensive painting to lines that are currently visible.
                // Off-screen lines are left dirty and will be painted by the
                // IntersectionObserver / paintVisibleRange pipeline when they
                // enter the viewport. This prevents forced reflows in rAF.
                try {
                    if (previousIndex !== -1) {
                        if (visibleIndices.has(previousIndex)) {
                            paintLine(previousIndex, true);
                        } else if (subtitlePaintStates && previousIndex < subtitlePaintStates.length) {
                            // mark as dirty so it will be painted when visible
                            subtitlePaintStates[previousIndex] = -1;
                        }
                    }
                    if (currentLineIndex !== -1) {
                        if (visibleIndices.has(currentLineIndex)) {
                            paintLine(currentLineIndex, true);
                        } else if (subtitlePaintStates && currentLineIndex < subtitlePaintStates.length) {
                            // ensure it will be painted later by the visibility pipeline
                            subtitlePaintStates[currentLineIndex] = -1;
                        }
                    }
                } catch (err) { /* defensive: avoid breaking rAF loop */ }
                if (autoScrollEnabled && currentLineIndex !== -1) {
                    if (autoScrollPlanComputed) {
                        if (autoScrollPlan) {
                            autoScrollToIndex(currentLineIndex, autoScrollPlan);
                        } else if (autoScrollPlanWasUndefined) {
                            autoScrollToIndex(currentLineIndex);
                        }
                    } else {
                        autoScrollToIndex(currentLineIndex);
                    }
                }
                resetSubtReaderInertiaState();
            } else {
                if (!useSubtitleProgress && sharedProgressIndex !== -1) {
                    detachSharedProgress();
                }
                if (!useTimecodeProgress && transportProgressValue !== 0) {
                    resetTransportProgress();
                }
                if (!useTimecodeProgress) {
                    clearTimecodeProgress();
                }
                if (autoScrollEnabled && currentLineIndex !== -1 && Number.isFinite(currentTime)) {
                    applySubtReaderInertia(currentLineIndex, currentTime);
                } else {
                    resetSubtReaderInertiaState();
                }
            }

            if (currentLineIndex !== -1) {
                const activeElement = subtitleElements[currentLineIndex];
                if (activeElement) {
                    if (useSubtitleProgress) {
                        if (sharedProgressIndex !== currentLineIndex) {
                            attachSharedProgressToIndex(currentLineIndex);
                        }
                    }
                    if (!inPause) {
                        const currentSub = subtitleData[currentLineIndex];
                        const lineDuration = currentSub.end_time - currentSub.start_time;
                        const rawFraction = lineDuration > 0 ? ((currentTime - currentSub.start_time) / lineDuration) : 0;
                        const clampedFraction = Math.max(0, Math.min(1, rawFraction));
                        if (useSubtitleProgress && Math.abs(clampedFraction - sharedProgressValue) > 0.001) {
                            sharedProgressValue = clampedFraction;
                            sharedProgressBar.style.transform = `scaleX(${clampedFraction})`;
                        }
                        if (useTimecodeProgress) {
                            setTimecodeProgress(currentLineIndex, clampedFraction);
                        }
                    } else {
                        if (useSubtitleProgress && sharedProgressValue !== 0) {
                            sharedProgressValue = 0;
                            sharedProgressBar.style.transform = 'scaleX(0)';
                        }
                        if (useTimecodeProgress) {
                            setTimecodeProgress(currentLineIndex, 0);
                        }
                    }
                }
            } else {
                if (sharedProgressIndex !== -1) {
                    detachSharedProgress();
                }
                if (useTimecodeProgress && transportProgressValue !== 0) {
                    resetTransportProgress();
                }
                clearTimecodeProgress();
            }
        } catch (e) { console.error("Error in updateTeleprompter:", e); }
    }
    
    // --- ОБРАБОТЧИКИ СОБЫТИЙ ---
    trackSelector.on('change', function() { getText($(this).val()); });
    refreshButton.on('click', () => {
        invalidateRolesCache('refresh_button');
    clearProjectDataCache();
    currentProjectName = '';
    renderTitle();
        statusIndicator.text('Обновление данных проекта...');
        getProjectData('refresh_button', { allowCache: false, forceReload: true }).catch(err => {
            console.error('[Prompter] refresh project data failed', err);
        });
    });
    if (navigationCompactToggle && navigationCompactToggle.length) {
        navigationCompactToggle.on('click', function(event) {
            event.preventDefault();
            setNavigationPanelCollapsed(!navigationPanelCollapsed);
        });
    }
    if (navigationFloatingExpandButton && navigationFloatingExpandButton.length) {
        navigationFloatingExpandButton.on('click', function(event) {
            event.preventDefault();
            setNavigationPanelCollapsed(false);
            if (navigationCompactToggle && navigationCompactToggle.length) {
                navigationCompactToggle.trigger('focus');
            }
        });
    }
    if (fullscreenAvailable) {
        if (navigationFullscreenToggle && navigationFullscreenToggle.length) {
            navigationFullscreenToggle.on('click', handleFullscreenToggle);
        }
        if (navigationFloatingFullscreenButton && navigationFloatingFullscreenButton.length) {
            navigationFloatingFullscreenButton.on('click', handleFullscreenToggle);
        }
        fullscreenChangeEvents.forEach(evt => {
            document.addEventListener(evt, updateFullscreenToggleUI, false);
        });
        fullscreenErrorEvents.forEach(evt => {
            document.addEventListener(evt, updateFullscreenToggleUI, false);
        });
        updateFullscreenToggleUI();
    } else {
        if (navigationFullscreenToggle && navigationFullscreenToggle.length) {
            navigationFullscreenToggle.prop('disabled', true).attr('aria-hidden', 'true').hide();
        }
        if (navigationFloatingFullscreenButton && navigationFloatingFullscreenButton.length) {
            navigationFloatingFullscreenButton.prop('disabled', true).attr('aria-hidden', 'true').hide();
        }
    }
    if (navigationFloatingSettingsButton && navigationFloatingSettingsButton.length) {
        navigationFloatingSettingsButton.on('click', function(event) {
            event.preventDefault();
            updateUIFromSettings();
            $('#settings-modal').show();
        });
    }
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
        updateActorRoleWarningBanner();
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
    $(document).on('click', '.actor-filter-btn', function(event){
        event.preventDefault();
        const action = $(this).data('action');
        const actor = $(this).closest('.actor-color-item').data('actor');
        if (!actor || typeof action !== 'string') return;
        if (action === 'mute') {
            toggleActorMuteState(actor);
        } else if (action === 'solo') {
            toggleActorSoloState(actor);
        }
    });
    $(document).on('click', '.role-filter-chip', function(event){
        event.preventDefault();
        if ($(this).prop('disabled')) return;
        const role = $(this).data('role');
        if (!role) return;
        toggleRoleSoloState(String(role));
    });
    $('#role-filter-reset-button').on('click', function(event){
        event.preventDefault();
        clearManualRoleSoloFilters({ source: 'button' });
    });
    $(document).on('click', '.delete-actor-color', function(){
        const row = $(this).closest('.actor-color-item');
        const actor = row.data('actor');
        if (actor) {
            setActorMuteState(actor, false);
            removeSoloActor(actor);
        }
        row.remove();
        syncActorFilterSettings({ reason: 'actor_row_deleted' });
    });
    $('#save-actors-button').on('click', function(){ saveActorsFromUI(); $('#actors-modal').hide(); });
    $('#reset-actor-filters-button').on('click', function(event){
        event.preventDefault();
        resetActorFilters();
    });

    // Live preview отключён: изменения применяются только по кнопке Сохранить / Сбросить.
    // Если нужно вернуть мгновенное применение, раскомментировать строку ниже.
    // $('.settings-body').find('input, select').on('change input', applySettings);

    // Обработчики для обновления UI (появление/скрытие блоков)
    titleModeSelect.on('change', function() {
        customTitleWrapper.toggle($(this).val() === 'custom_text');
        scheduleSettingsTileReflow();
    });
    autoFindTrackCheckbox.on('change', function() {
        autoFindKeywordsWrapper.toggle($(this).is(':checked'));
        scheduleSettingsTileReflow();
    });
    autoScrollCheckbox.on('change', function() {
        const enabled = $(this).is(':checked');
        const mode = autoScrollModeSelect && autoScrollModeSelect.length
            ? autoScrollModeSelect.val()
            : (settings.autoScrollMode || defaultSettings.autoScrollMode);
        updateAutoScrollControlsState(enabled, mode);
        if (!enabled) {
            resetAutoScrollState();
        }
    });
    if (autoScrollModeSelect && autoScrollModeSelect.length) {
        autoScrollModeSelect.on('change', function() {
            const mode = $(this).val();
            updateAutoScrollControlsState(autoScrollCheckbox.is(':checked'), mode);
        });
    }
    processRolesCheckbox.on('change', function() {
    setRoleOptionsVisibility($(this).is(':checked'));
        updateScaleWrapperVisibility();
        scheduleSettingsTileReflow();
    });
    checkerboardEnabledCheckbox.on('change', function() {
        setCheckerboardOptionsVisibility($(this).is(':checked'));
        scheduleSettingsTileReflow();
    });
    highlightCurrentRoleEnabledCheckbox.on('change', function() {
        highlightRoleColorWrapper.toggle($(this).is(':checked'));
        scheduleSettingsTileReflow();
    });
    highlightClickEnabledCheckbox.on('change', function() {
        highlightClickOptionsWrapper.toggle($(this).is(':checked'));
        scheduleSettingsTileReflow();
    });
    if (filterHiddenBehaviorSelect.length) {
        filterHiddenBehaviorSelect.on('change', function() {
            const mode = $(this).val();
            updateFilterHiddenControlsVisibility(mode);
            const sanitized = sanitizeFilterHiddenBehavior(mode, settings.filterHiddenBehavior || defaultSettings.filterHiddenBehavior);
            if (sanitized !== settings.filterHiddenBehavior) {
                settings.filterHiddenBehavior = sanitized;
                updateFilterRuntimeFromSettings();
                recomputeFilteringState({ force: true });
                refreshActorFilterControlsUI();
            }
            if (filterDimPercentSlider.length) {
                let rangedValue = sanitizeFilterDimPercent(
                    filterDimPercentSlider.val(),
                    settings.filterDimPercent || defaultSettings.filterDimPercent
                );
                filterDimPercentSlider.val(rangedValue);
                filterDimPercentValue.text(rangedValue + '%');
                refreshFrzzSliderFill(filterDimPercentSlider);
            }
        });
    }
    const syncHighlightFeatureState = () => {
        applyHighlightUIStateFromValues(getHighlightFeatureValuesFromUI(), { syncControls: false });
    };
    [highlightCurrentEnabledCheckbox, highlightPreviousEnabledCheckbox, highlightPauseEnabledCheckbox, progressBarEnabledCheckbox].forEach($el => {
        if ($el && $el.length) {
            $el.on('change', syncHighlightFeatureState);
        }
    });
    if (progressBarModeSelect && progressBarModeSelect.length) {
        progressBarModeSelect.on('change', syncHighlightFeatureState);
    }
    if (jumpOnClickCheckbox.length) {
        jumpOnClickCheckbox.on('change', function() {
            updateJumpControlsState($(this).is(':checked'));
        });
    }
    if (jumpPreRollInput.length) {
        const sanitizeJumpInput = function() {
            const sanitized = sanitizeJumpPreRollSeconds($(this).val(), settings.jumpPreRollSeconds || defaultSettings.jumpPreRollSeconds);
            $(this).val(sanitized);
        };
        jumpPreRollInput.on('change', sanitizeJumpInput);
        jumpPreRollInput.on('blur', sanitizeJumpInput);
    }

    // Обработчики для обновления подписей у слайдеров
    scrollSpeedSlider.on('input change', function() {
        const i = parseInt($(this).val(), 10);
        scrollSpeedValue.text(speedSteps[i] + '%');
        scrollSpeedCaption.text(getScrollSpeedCaption(speedSteps[i]));
        refreshFrzzSliderFill(scrollSpeedSlider);
    });
    uiScaleSlider.on('input change', function() {
        uiScaleValue.text($(this).val() + '%');
        refreshFrzzSliderFill(uiScaleSlider);
    });
    lineSpacingSlider.on('input change', function() {
        lineSpacingValue.text($(this).val() + '%');
        refreshFrzzSliderFill(lineSpacingSlider);
    });
    roleColumnScaleSlider.on('input change', function() {
        roleColumnScaleValue.text($(this).val() + '%');
        refreshFrzzSliderFill(roleColumnScaleSlider);
    });
    if (filterDimPercentSlider.length) {
        filterDimPercentSlider.on('input change', function() {
            let dimValue = sanitizeFilterDimPercent(
                $(this).val(),
                settings.filterDimPercent || defaultSettings.filterDimPercent
            );
            filterDimPercentSlider.val(dimValue);
            filterDimPercentValue.text(dimValue + '%');
            refreshFrzzSliderFill(filterDimPercentSlider);
            if (dimValue !== settings.filterDimPercent) {
                settings.filterDimPercent = dimValue;
                updateFilterRuntimeFromSettings();
                recomputeFilteringState({ force: true });
            }
        });
    }
    if (autoScrollWindowTopInput.length && autoScrollWindowBottomInput.length) {
        const syncWindowBounds = (source) => {
            updateAutoScrollWindowUI(
                autoScrollWindowTopInput.val(),
                autoScrollWindowBottomInput.val(),
                { source }
            );
        };
        autoScrollWindowTopInput.on('input change', () => syncWindowBounds('top'));
        autoScrollWindowBottomInput.on('input change', () => syncWindowBounds('bottom'));
    }
    if (autoScrollLineAnchorInput.length) {
        autoScrollLineAnchorInput.on('input change', function() {
            updateAutoScrollLineAnchorSlider($(this).val());
        });
    }

    if (scrollSpeedSlider.length) { refreshFrzzSliderFill(scrollSpeedSlider); }
    if (uiScaleSlider.length) { refreshFrzzSliderFill(uiScaleSlider); }
    if (lineSpacingSlider.length) { refreshFrzzSliderFill(lineSpacingSlider); }
    if (roleColumnScaleSlider.length) { refreshFrzzSliderFill(roleColumnScaleSlider); }
    if (filterDimPercentSlider.length) { refreshFrzzSliderFill(filterDimPercentSlider); }
    if (autoScrollLineAnchorInput.length) { refreshFrzzSliderFill(autoScrollLineAnchorInput); }
    
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
        if (targetIndex !== -1) {
            const targetElement = subtitleElements[targetIndex];
            focusLineElement(targetIndex, { element: targetElement });
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
            logReadyStage('emu_transport_started');
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