const SETTINGS_SCHEMA_VERSION = 8;
const DATA_MODEL_VERSION = 2;
const DEFAULT_PROJECT_FPS = 24;
const MAX_JUMP_PRE_ROLL_SECONDS = 10;
const MIN_AUTO_SCROLL_WINDOW_GAP = 5;
const MAX_AUTO_SCROLL_EASING_PER_PIXEL = 10;
const MAX_AUTO_SCROLL_ANIMATION_MS = 12000;
const SPEED_BASELINE_FACTOR = 1;
const MIN_SPEED_MULTIPLIER = 0.1;
const MAX_SPEED_MULTIPLIER = 20;
const PAGE_BASELINE_DURATION_MS = 700;
const LINE_BASELINE_DURATION_MS = 2000;
const PAGE_SCROLL_TOLERANCE_PX = 12;
const LINE_SCROLL_TOLERANCE_PX = 6;
const MIN_TIMELINE_SCROLL_MS = 120;
const TIMELINE_ACTIVE_COMPLETION_RATIO = 0.85;
const TIMELINE_LOOKAHEAD_COMPLETION_RATIO = 0.65;
const LINE_AUTO_SCROLL_LOOKAHEAD_SECONDS = 0.1;
const SUBTREADER_INERTIA_WINDOW_SECONDS = 0.7; // SubtReader UI.transition_sec window
const SUBTREADER_INERTIA_MIN_DISTANCE_PX = 0.75; // ignore tiny scroll deltas to prevent jitter
const supportsInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;

function isQueryFlagEnabled(paramName) {
    if (typeof window === 'undefined' || !window.location) return false;
    try {
        const params = new URLSearchParams(window.location.search || '');
        if (!params.has(paramName)) return false;
        const value = params.get(paramName);
        if (value == null || value === '') return true;
        return !/^(0|false|no|off)$/i.test(value);
    } catch (_) {
        return false;
    }
}

const DEBUG_LOG_BOOT_ENABLED = isQueryFlagEnabled('debug') || isQueryFlagEnabled('emumode');

const ConsoleMirror = (() => {
    const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
    const MAX_ENTRIES = 600;
    const MAX_ARG_LENGTH = 20000;
    const buffer = [];
    const listeners = new Set();
    const originals = {};
    let installed = false;
    let globalListenersAttached = false;
    let windowErrorListener = null;
    let unhandledRejectionListener = null;
    const ERROR_EVENT_FLAG = '__FRZZ_PROMPTER_ERROR_CAPTURED__';
    const REJECTION_EVENT_FLAG = '__FRZZ_PROMPTER_REJECTION_CAPTURED__';
    const SKIP_PREDICATES = [
        args => args.some(arg => typeof arg === 'string' && /wwr_req/i.test(arg) && /transport/i.test(arg)),
        args => args.some(arg => typeof arg === 'string' && arg.trim().toUpperCase() === 'TRANSPORT'),
        args => args.some(arg => isTransportRequestObject(arg))
    ];

    function install() {
        if (installed) return true;
        if (typeof console !== 'object' || console === null) return false;
        if (console.__FRZZ_PROMPTER_LOG_MIRROR__) {
            installed = true;
            return true;
        }
        LEVELS.forEach(level => {
            const original = typeof console[level] === 'function' ? console[level].bind(console) : null;
            if (!original) return;
            originals[level] = original;
            console[level] = function patchedConsoleMethod(...args) {
                try { capture(level, args); } catch (_) { /* ignore */ }
                return original(...args);
            };
        });
        if (typeof console.clear === 'function') {
            const originalClear = console.clear.bind(console);
            originals.clear = originalClear;
            console.clear = function patchedConsoleClear(...args) {
                try { reset(); } catch (_) { /* ignore */ }
                return originalClear(...args);
            };
        }
        installGlobalErrorListeners();
        installed = true;
        Object.defineProperty(console, '__FRZZ_PROMPTER_LOG_MIRROR__', {
            value: true,
            configurable: false,
            enumerable: false,
            writable: false
        });
        return true;
    }

    function capture(level, args) {
        if (shouldSkip(args)) return;
        const entry = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            level,
            timestamp: Date.now(),
            args: formatArgs(args)
        };
        buffer.push(entry);
        if (buffer.length > MAX_ENTRIES) buffer.shift();
        notify({ type: 'append', entry, size: buffer.length });
    }

    function shouldSkip(args) {
        if (!Array.isArray(args) || args.length === 0) return false;
        return SKIP_PREDICATES.some(predicate => {
            try { return predicate(args); } catch (_) { return false; }
        });
    }

    function formatArgs(args) {
        return args.map(value => truncateArg(formatValue(value)));
    }

    function formatValue(value) {
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (typeof value === 'bigint') return `${value.toString()}n`;
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (value instanceof Error) {
            return value.stack || `${value.name || 'Error'}: ${value.message}`;
        }
        if (typeof value === 'function') {
            return `[Function ${value.name || 'anonymous'}]`;
        }
        if (typeof value === 'object') {
            return safeStringify(value);
        }
        try { return String(value); } catch (_) { return '[Unserializable]'; }
    }

    function truncateArg(text) {
        if (typeof text !== 'string') return '';
        return text.length > MAX_ARG_LENGTH ? `${text.slice(0, MAX_ARG_LENGTH)} …[truncated]` : text;
    }

    function safeStringify(value) {
        const seen = new WeakSet();
        const replacer = (_key, val) => {
            if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`;
            if (typeof val === 'bigint') return `${val.toString()}n`;
            if (val && typeof val === 'object') {
                if (seen.has(val)) return '[Circular]';
                seen.add(val);
            }
            return val;
        };
        try {
            return JSON.stringify(value, replacer, 2);
        } catch (_) {
            try { return String(value); } catch (err) { return `[Unserializable: ${err && err.message ? err.message : 'unknown'}]`; }
        }
    }

    function isTransportRequestObject(value, tracker) {
        if (!value || typeof value !== 'object') return false;
        const seen = tracker || new WeakSet();
        if (seen.has(value)) return false;
        seen.add(value);
        try {
            const candidate = value.wwr_req || value.request || value.command || value.type;
            if (typeof candidate === 'string' && /transport/i.test(candidate)) {
                return true;
            }
            if (Array.isArray(value)) {
                return value.some(item => isTransportRequestObject(item, seen));
            }
            const nestedKeys = ['payload', 'data', 'body', 'args'];
            for (let idx = 0; idx < nestedKeys.length; idx++) {
                const nested = value[nestedKeys[idx]];
                if (nested && typeof nested === 'object' && isTransportRequestObject(nested, seen)) {
                    return true;
                }
            }
        } catch (_) {
            return false;
        }
        return false;
    }

    function notify(event) {
        listeners.forEach(listener => {
            try { listener(event); } catch (_) { /* ignore listener errors */ }
        });
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function getEntries() {
        return buffer.slice();
    }

    function clear() {
        reset();
    }

    function reset() {
        if (!buffer.length) return;
        buffer.length = 0;
        notify({ type: 'reset', size: 0 });
    }

    function installGlobalErrorListeners() {
        if (globalListenersAttached) return;
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
        windowErrorListener = event => {
            try { handleWindowError(event); } catch (_) { /* swallow capture errors */ }
        };
        unhandledRejectionListener = event => {
            try { handleUnhandledRejection(event); } catch (_) { /* swallow capture errors */ }
        };
        window.addEventListener('error', windowErrorListener, true);
        window.addEventListener('unhandledrejection', unhandledRejectionListener, true);
        globalListenersAttached = true;
    }

    function handleWindowError(event) {
        if (!event || typeof event !== 'object') {
            capture('error', ['Script error (no event data)']);
            return;
        }
        if (event[ERROR_EVENT_FLAG]) return;
        try { event[ERROR_EVENT_FLAG] = true; } catch (_) { /* ignore flag assignment failures */ }
        const args = [];
        const primaryMessage = buildWindowErrorMessage(event);
        if (primaryMessage) {
            args.push(primaryMessage);
        }
        if (event.error) {
            const errorDetails = formatValue(event.error);
            if (errorDetails && errorDetails !== primaryMessage) {
                args.push(errorDetails);
            }
        }
        if (!args.length && event.target && event.target !== window) {
            const resourceMessage = buildResourceErrorMessage(event.target);
            if (resourceMessage) args.push(resourceMessage);
        }
        if (!args.length) {
            const fallback = buildErrorLocationSuffix(event);
            args.push(fallback ? `Script error${fallback}` : 'Script error');
        }
        capture('error', args);
    }

    function handleUnhandledRejection(event) {
        if (!event || typeof event !== 'object') {
            capture('error', ['Unhandled promise rejection']);
            return;
        }
        if (event[REJECTION_EVENT_FLAG]) return;
        try { event[REJECTION_EVENT_FLAG] = true; } catch (_) { /* ignore flag assignment failures */ }
        const args = ['Unhandled promise rejection'];
        if ('reason' in event) {
            const reasonText = formatValue(event.reason);
            if (reasonText) args.push(reasonText);
        }
        capture('error', args);
    }

    function buildWindowErrorMessage(event) {
        if (!event || typeof event !== 'object') return '';
        if (typeof event.message === 'string' && event.message.trim()) {
            const suffix = buildErrorLocationSuffix(event);
            return suffix ? `${event.message}${suffix}` : event.message;
        }
        if (event.target && event.target !== window) {
            return buildResourceErrorMessage(event.target);
        }
        const suffix = buildErrorLocationSuffix(event);
        return suffix ? `Script error${suffix}` : '';
    }

    function buildErrorLocationSuffix(event) {
        if (!event || typeof event !== 'object') return '';
        const parts = [];
        if (typeof event.filename === 'string' && event.filename.trim()) {
            parts.push(event.filename.trim());
        }
        if (Number.isFinite(event.lineno)) {
            parts.push(String(event.lineno));
        }
        if (Number.isFinite(event.colno)) {
            parts.push(String(event.colno));
        }
        if (!parts.length) return '';
        const location = parts.join(':');
        return location ? ` (${location})` : '';
    }

    function buildResourceErrorMessage(target) {
        if (!target || typeof target !== 'object') return '';
        const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : 'RESOURCE';
        const id = typeof target.id === 'string' && target.id ? `#${target.id}` : '';
        let className = '';
        if (typeof target.className === 'string') {
            className = target.className;
        } else if (target.className && typeof target.className.baseVal === 'string') {
            className = target.className.baseVal;
        }
        const classes = className ? `.${className.trim().replace(/\s+/g, '.')}` : '';
        const url = target.currentSrc || target.src || target.href || '';
        const descriptor = `<${tag}${id}${classes}>`;
        return url ? `Resource load error ${descriptor} ${url}` : `Resource load error ${descriptor}`;
    }

    return {
        install,
        subscribe,
        getEntries,
        clear
    };
})();

const DebugLogUI = (() => {
    const EVENT_NAMESPACE = '.frzzDebugLog';
    let enabled = false;
    let statusIndicator = null;
    let modal = null;
    let scrollArea = null;
    let entriesContainer = null;
    let emptyState = null;
    let clearButton = null;
    let saveButton = null;
    let copyButton = null;
    let unsubscribe = null;

    function init(options) {
        enabled = !!(options && options.enabled);
        statusIndicator = options && options.statusIndicator ? options.statusIndicator : $();
        modal = options && options.modal ? options.modal : $();
        scrollArea = options && options.scrollArea ? options.scrollArea : $();
        entriesContainer = options && options.entriesContainer ? options.entriesContainer : $();
        emptyState = options && options.emptyState ? options.emptyState : $();
        clearButton = options && options.clearButton ? options.clearButton : $();
        saveButton = options && options.saveButton ? options.saveButton : $();
        copyButton = options && options.copyButton ? options.copyButton : $();

        if (!enabled) {
            teardownInteractiveState();
            disableControls();
            return;
        }

        ConsoleMirror.install();
        renderInitial(ConsoleMirror.getEntries());
        unsubscribe = ConsoleMirror.subscribe(handleConsoleEvent);
        setupInteractiveState();
        setupModalHandlers();
        setupClearButton();
        setupSaveButton();
        setupCopyButton();
        updateEmptyState();
    }

    function handleConsoleEvent(event) {
        if (!enabled || !event || typeof event !== 'object') return;
        if (event.type === 'append' && event.entry) {
            appendEntry(event.entry);
        } else if (event.type === 'reset') {
            clearRenderedEntries();
        }
    }

    function renderInitial(entries) {
        if (!entriesContainer || !entriesContainer.length) return;
        entriesContainer.empty();
        if (Array.isArray(entries) && entries.length) {
            const fragment = document.createDocumentFragment();
            entries.forEach(entry => fragment.appendChild(createEntryElement(entry)));
            entriesContainer[0].appendChild(fragment);
            updateEmptyState();
            scrollToBottom();
        } else {
            updateEmptyState();
        }
    }

    function appendEntry(entry) {
        if (!entriesContainer || !entriesContainer.length) return;
        const stickToBottom = isNearBottom();
        entriesContainer[0].appendChild(createEntryElement(entry));
        updateEmptyState();
        if (stickToBottom) scrollToBottom();
    }

    function createEntryElement(entry) {
        const wrapper = document.createElement('div');
        wrapper.className = `debug-log-entry level-${entry.level || 'log'}`;

        const meta = document.createElement('div');
        meta.className = 'debug-log-meta';
        const timeSpan = document.createElement('span');
        timeSpan.textContent = formatTimestamp(entry.timestamp);
        const levelSpan = document.createElement('span');
        levelSpan.textContent = String((entry.level || 'log')).toUpperCase();
        meta.appendChild(timeSpan);
        meta.appendChild(levelSpan);
        wrapper.appendChild(meta);

        if (Array.isArray(entry.args) && entry.args.length) {
            const argsContainer = document.createElement('div');
            argsContainer.className = 'debug-log-args';
            entry.args.forEach(argText => {
                const argBlock = document.createElement('pre');
                argBlock.className = 'debug-log-arg';
                argBlock.textContent = argText;
                argsContainer.appendChild(argBlock);
            });
            wrapper.appendChild(argsContainer);
        }

        return wrapper;
    }

    function setupInteractiveState() {
        if (!statusIndicator || !statusIndicator.length) return;
        statusIndicator.addClass('is-interactive')
            .attr('role', 'button')
            .attr('tabindex', '0')
            .attr('aria-haspopup', 'dialog')
            .attr('aria-controls', modal && modal.length ? modal.attr('id') : '')
            .attr('aria-expanded', 'false');
        if (!statusIndicator.attr('title')) {
            statusIndicator.attr('title', 'Открыть журнал');
        }
        statusIndicator.on(`click${EVENT_NAMESPACE}`, event => {
            event.preventDefault();
            openModal();
        });
        statusIndicator.on(`keydown${EVENT_NAMESPACE}`, event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openModal();
            }
        });
    }

    function teardownInteractiveState() {
        if (!statusIndicator || !statusIndicator.length) return;
        statusIndicator.removeClass('is-interactive')
            .removeAttr('role tabindex aria-haspopup aria-controls aria-expanded');
        statusIndicator.off(EVENT_NAMESPACE);
    }

    function setupModalHandlers() {
        if (!modal || !modal.length) return;
    modal.attr('role', 'dialog').attr('aria-modal', 'true').attr('aria-hidden', 'true').hide();
        modal.on(`click${EVENT_NAMESPACE}`, event => {
            if (event.target === modal[0]) closeModal();
        });
        modal.find('.modal-close-button').on(`click${EVENT_NAMESPACE}`, event => {
            event.preventDefault();
            closeModal();
        });
        $(document).on(`keydown${EVENT_NAMESPACE}`, event => {
            if (event.key === 'Escape' && modal.is(':visible')) {
                event.preventDefault();
                closeModal();
            }
        });
    }

    function setupClearButton() {
        if (!clearButton || !clearButton.length) return;
        clearButton.prop('disabled', entriesContainer && entriesContainer.children().length === 0);
        clearButton.on(`click${EVENT_NAMESPACE}`, event => {
            event.preventDefault();
            ConsoleMirror.clear();
        });
    }

    function setupSaveButton() {
        if (!saveButton || !saveButton.length) return;
        saveButton.prop('disabled', entriesContainer && entriesContainer.children().length === 0);
        saveButton.on(`click${EVENT_NAMESPACE}`, event => {
            event.preventDefault();
            exportLogToFile();
        });
    }

    function setupCopyButton() {
        if (!copyButton || !copyButton.length) return;
        copyButton.prop('disabled', entriesContainer && entriesContainer.children().length === 0);
        copyButton.on(`click${EVENT_NAMESPACE}`, event => {
            event.preventDefault();
            copyLogToClipboard();
        });
    }

    function disableControls() {
        if (modal && modal.length) {
            modal.hide();
            modal.attr('aria-hidden', 'true');
        }
        if (clearButton && clearButton.length) {
            clearButton.prop('disabled', true).off(EVENT_NAMESPACE);
        }
        if (saveButton && saveButton.length) {
            saveButton.prop('disabled', true).off(EVENT_NAMESPACE);
        }
        if (copyButton && copyButton.length) {
            copyButton.prop('disabled', true).off(EVENT_NAMESPACE);
        }
    }

    function clearRenderedEntries() {
        if (entriesContainer && entriesContainer.length) {
            entriesContainer.empty();
        }
        updateEmptyState();
    }

    function updateEmptyState() {
        const hasEntries = entriesContainer && entriesContainer.length && entriesContainer.children().length > 0;
        if (emptyState && emptyState.length) emptyState.toggle(!hasEntries);
        if (clearButton && clearButton.length) clearButton.prop('disabled', !hasEntries);
        if (saveButton && saveButton.length) saveButton.prop('disabled', !hasEntries);
        if (copyButton && copyButton.length) copyButton.prop('disabled', !hasEntries);
    }

    function openModal() {
        if (!modal || !modal.length) return;
        modal.show();
        modal.attr('aria-hidden', 'false');
        if (statusIndicator && statusIndicator.length) statusIndicator.attr('aria-expanded', 'true');
        scrollToBottom();
        const closeButton = modal.find('.modal-close-button').first();
        if (closeButton && closeButton.length) {
            closeButton.trigger('focus');
        }
    }

    function closeModal() {
        if (!modal || !modal.length) return;
        modal.hide();
        modal.attr('aria-hidden', 'true');
        if (statusIndicator && statusIndicator.length) {
            statusIndicator.attr('aria-expanded', 'false');
            statusIndicator.trigger('focus');
        }
    }

    function isNearBottom() {
        if (!scrollArea || !scrollArea.length) return true;
        const el = scrollArea[0];
        const threshold = 48;
        return (el.scrollTop + el.clientHeight + threshold) >= el.scrollHeight;
    }

    function scrollToBottom() {
        if (!scrollArea || !scrollArea.length) return;
        const el = scrollArea[0];
        el.scrollTop = el.scrollHeight;
    }

    function formatTimestamp(timestamp) {
        if (!Number.isFinite(timestamp)) return '—';
        const date = new Date(Number(timestamp));
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        const millis = String(date.getMilliseconds()).padStart(3, '0');
        return `${hours}:${minutes}:${seconds}.${millis}`;
    }

    function exportLogToFile() {
        const entries = ConsoleMirror.getEntries();
        if (!Array.isArray(entries) || !entries.length) {
            return;
        }
        const lines = entries.map(formatLogFileLine).join('\n');
        try {
            const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const filename = `prompter-log-${buildDownloadTimestamp()}.txt`;
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            const parentNode = document.body || document.documentElement;
            if (!parentNode) {
                throw new Error('Cannot access document body to trigger download');
            }
            parentNode.appendChild(anchor);
            anchor.click();
            const cleanup = () => {
                anchor.remove();
                URL.revokeObjectURL(url);
            };
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(cleanup);
            } else {
                setTimeout(cleanup, 0);
            }
        } catch (err) {
            console.error('[Prompter][debugLog] failed to export log', err);
        }
    }

    function copyLogToClipboard() {
        const entries = ConsoleMirror.getEntries();
        if (!Array.isArray(entries) || !entries.length) {
            return;
        }
        const text = entries.map(formatLogFileLine).join('\n');
        const writeClipboard = value => {
            if (!value) return;
            if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(value).catch(err => {
                    console.warn('[Prompter][debugLog] clipboard write failed, fallback engaged', err);
                    fallbackCopy(value);
                });
            } else {
                fallbackCopy(value);
            }
        };
        const fallbackCopy = value => {
            try {
                if (typeof document === 'undefined') {
                    throw new Error('Document unavailable for clipboard fallback');
                }
                const textarea = document.createElement('textarea');
                textarea.value = value;
                textarea.setAttribute('readonly', 'readonly');
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                const parent = document.body || document.documentElement;
                if (!parent) throw new Error('No document body for clipboard fallback');
                parent.appendChild(textarea);
                textarea.select();
                if (typeof document.execCommand === 'function') {
                    document.execCommand('copy');
                }
                textarea.remove();
            } catch (err) {
                console.error('[Prompter][debugLog] failed to copy log', err);
            }
        };
        writeClipboard(text);
    }

    function formatLogFileLine(entry) {
        const stamp = formatLogFileTimestamp(entry && entry.timestamp);
        const level = String(entry && entry.level ? entry.level : 'log').toUpperCase();
        const message = formatLogFileMessage(entry && entry.args);
        return message ? `${stamp} [${level}] ${message}` : `${stamp} [${level}]`;
    }

    function formatLogFileTimestamp(timestamp) {
        const safeTimestamp = Number.isFinite(timestamp) ? Number(timestamp) : Date.now();
        const date = new Date(safeTimestamp);
        const year = String(date.getFullYear()).padStart(4, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
    const millis = String(date.getMilliseconds()).padStart(3, '0');
    const offsetMinutes = -date.getTimezoneOffset();
    const offsetSign = offsetMinutes >= 0 ? '+' : '-';
    const offsetTotal = Math.abs(offsetMinutes);
    const offsetHours = String(Math.floor(offsetTotal / 60)).padStart(2, '0');
    const offsetMins = String(offsetTotal % 60).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}.${millis} GMT${offsetSign}${offsetHours}${offsetMins}`;
    }

    function formatLogFileMessage(args) {
        if (!Array.isArray(args) || !args.length) return '';
        const pieces = args.map(value => sanitizeLogSegment(value)).filter(segment => segment.length);
        return pieces.join(' ');
    }

    function sanitizeLogSegment(value) {
        if (value == null) return '';
        const text = typeof value === 'string' ? value : String(value);
        return text.replace(/\s+/g, ' ').trim();
    }

    function buildDownloadTimestamp() {
        const now = new Date();
        const year = String(now.getFullYear()).padStart(4, '0');
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
    }

    return { init };
})();

if (DEBUG_LOG_BOOT_ENABLED) {
    ConsoleMirror.install();
}

const APP_NAME = 'Интерактивный текстовый монитор';
const APP_VERSION = '1.5.1-pre';
const APP_VERSION_CODENAME = 'PROJECT JOHN CONNOR';
const APP_CODENAME = 'МОНТАЖКА 2.0';
const ORIGINAL_DOCUMENT_TITLE = `${APP_NAME} v${APP_VERSION}`;
if (typeof document !== 'undefined') {
    document.title = ORIGINAL_DOCUMENT_TITLE;
}
if (typeof window !== 'undefined') {
    window.FRZZ_PROMPTER_VERSION = APP_VERSION;
}

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

function sanitizeSegmentationPriority(value, fallback = 'video') {
    const fallbackNormalized = (typeof fallback === 'string' && fallback.trim().toLowerCase() === 'markers') ? 'markers' : 'video';
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'video' || normalized === 'videos' || normalized === 'video_files') {
            return 'video';
        }
        if (normalized === 'markers' || normalized === 'marker' || normalized === 'regions' || normalized === 'region') {
            return 'markers';
        }
    }
    return fallbackNormalized;
}

function sanitizeSegmentationDisplayMode(value, fallback = 'current') {
    const fallbackNormalized = (typeof fallback === 'string' && fallback.trim().toLowerCase() === 'all') ? 'all' : 'current';
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'current' || normalized === 'current_segment' || normalized === 'segment') {
            return 'current';
        }
        if (normalized === 'all' || normalized === 'all_segments' || normalized === 'full') {
            return 'all';
        }
    }
    return fallbackNormalized;
}

function sanitizeSegmentationAutoSwitchMode(value, fallback = 'playback_only') {
    const fallbackNormalized = (() => {
        if (typeof fallback !== 'string') return 'playback_only';
        const normalized = fallback.trim().toLowerCase();
        if (normalized === 'always') return 'always';
        if (normalized === 'disabled' || normalized === 'off') return 'disabled';
        return 'playback_only';
    })();
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'always') {
            return 'always';
        }
        if (normalized === 'disabled' || normalized === 'off' || normalized === 'none') {
            return 'disabled';
        }
        if (normalized === 'playback' || normalized === 'playback_only' || normalized === 'play' || normalized === 'transport') {
            return 'playback_only';
        }
    }
    return fallbackNormalized;
}

function sanitizeSegmentationKeywordList(value, fallback = '', options = {}) {
    const allowEmpty = options && options.allowEmpty === true;
    const fallbackString = typeof fallback === 'string' ? fallback.trim() : '';
    if (typeof value !== 'string') {
        return allowEmpty ? '' : fallbackString;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return allowEmpty ? '' : fallbackString;
    }
    return trimmed;
}

const SEGMENTATION_MODE_NONE = 'none';
const SEGMENTATION_MODE_VIDEO = 'video';
const SEGMENTATION_MODE_MARKERS = 'markers';
const SEGMENTATION_MODE_BOTH = 'both';

const SEGMENTATION_MODE_LABELS = {
    [SEGMENTATION_MODE_NONE]: 'Выключить',
    [SEGMENTATION_MODE_VIDEO]: 'Только по видеофайлам',
    [SEGMENTATION_MODE_MARKERS]: 'Только по маркерам\регионам',
    [SEGMENTATION_MODE_BOTH]: 'Двойной режим'
};

let settings = {};

function sanitizeSegmentationMode(value, fallback = SEGMENTATION_MODE_NONE) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === SEGMENTATION_MODE_VIDEO || normalized === SEGMENTATION_MODE_MARKERS || normalized === SEGMENTATION_MODE_BOTH) {
        return normalized;
    }
    return SEGMENTATION_MODE_NONE;
}

function mapSegmentationModeToFlags(mode) {
    const resolved = sanitizeSegmentationMode(mode);
    if (resolved === SEGMENTATION_MODE_VIDEO) {
        return { enabled: true, video: true, markers: false };
    }
    if (resolved === SEGMENTATION_MODE_MARKERS) {
        return { enabled: true, video: false, markers: true };
    }
    if (resolved === SEGMENTATION_MODE_BOTH) {
        return { enabled: true, video: true, markers: true };
    }
    return { enabled: false, video: false, markers: false };
}

function deriveSegmentationModeFromFlags(enabled, videoEnabled, markersEnabled) {
    if (!enabled || (!videoEnabled && !markersEnabled)) {
        return SEGMENTATION_MODE_NONE;
    }
    if (videoEnabled && markersEnabled) {
        return SEGMENTATION_MODE_BOTH;
    }
    if (videoEnabled) {
        return SEGMENTATION_MODE_VIDEO;
    }
    if (markersEnabled) {
        return SEGMENTATION_MODE_MARKERS;
    }
    return SEGMENTATION_MODE_NONE;
}

function buildSegmentationRequestState(sourceSettings = settings) {
    const base = sourceSettings || settings || defaultSettings;
    const enabledFlag = base && base.segmentationEnabled !== false;
    const videoFlag = enabledFlag && (base.segmentationAutoVideoEnabled !== false);
    const markersFlag = enabledFlag && (base.segmentationAutoMarkersEnabled !== false);
    const mode = deriveSegmentationModeFromFlags(enabledFlag, videoFlag, markersFlag);
    const flags = mapSegmentationModeToFlags(mode);
    const priority = sanitizeSegmentationPriority(
        base ? base.segmentationAutodetectPriority : undefined,
        defaultSettings.segmentationAutodetectPriority
    );
    const videoKeywords = flags.enabled && flags.video
        ? sanitizeSegmentationKeywordList(
            base.segmentationAutoVideoKeywords,
            defaultSettings.segmentationAutoVideoKeywords
        )
        : '';
    const markerPattern = flags.enabled && flags.markers
        ? sanitizeSegmentationKeywordList(
            base.segmentationMarkerPattern,
            defaultSettings.segmentationMarkerPattern,
            { allowEmpty: true }
        )
        : '';
    return {
        enabled: flags.enabled,
        mode,
        priority,
        videoEnabled: flags.video,
        markersEnabled: flags.markers,
        videoKeywords,
        markerPattern
    };
}

function segmentationRequestStatesDiffer(prev, next) {
    if (!prev || !next) {
        return true;
    }
    return (
        prev.enabled !== next.enabled ||
        prev.mode !== next.mode ||
        prev.priority !== next.priority ||
        prev.videoEnabled !== next.videoEnabled ||
        prev.markersEnabled !== next.markersEnabled ||
        prev.videoKeywords !== next.videoKeywords ||
        prev.markerPattern !== next.markerPattern
    );
}

function transmitSegmentationRequestToBackend(reason = 'project_data', options = {}) {
    const requestReason = (typeof reason === 'string' && reason.trim().length)
        ? reason.trim()
        : 'project_data';
    const state = buildSegmentationRequestState(options && options.sourceSettings);
    if (typeof wwr_req !== 'function') {
        console.debug('[Prompter][segmentation] transmit skipped (wwr_req unavailable)', {
            reason: requestReason,
            state
        });
        return state;
    }
    try {
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/segmentation_request_mode/${encodeURIComponent(state.mode)}`);
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/segmentation_request_priority/${encodeURIComponent(state.priority)}`);
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/segmentation_video_toggle/${state.videoEnabled ? '1' : '0'}`);
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/segmentation_markers_toggle/${state.markersEnabled ? '1' : '0'}`);
        if (state.videoEnabled && state.videoKeywords) {
            wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/segmentation_video_keywords/${encodeURIComponent(state.videoKeywords)}`);
        } else {
            wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/segmentation_video_keywords/');
        }
        if (state.markersEnabled && state.markerPattern) {
            wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/segmentation_marker_pattern/${encodeURIComponent(state.markerPattern)}`);
        } else {
            wwr_req('SET/EXTSTATEPERSIST/PROMPTER_WEBUI/segmentation_marker_pattern/');
        }
        const metaPayload = `${Date.now()}|${state.mode}|${requestReason}`;
        wwr_req(`SET/EXTSTATEPERSIST/PROMPTER_WEBUI/segmentation_request_meta/${encodeURIComponent(metaPayload)}`);
        console.debug('[Prompter][segmentation] request dispatched', {
            reason: requestReason,
            mode: state.mode,
            video: state.videoEnabled,
            markers: state.markersEnabled
        });
    } catch (err) {
        console.error('[Prompter][segmentation] transmit failed', err);
    }
    return state;
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

const STATS_SEGMENT_ALL_VALUE = 'all';
const SEGMENT_RANGE_EPSILON = 1e-6;

const STATS_PERCENT_DIGITS = 1;

function createDefaultProjectSegmentationInfo() {
    return {
        mode: 'none',
        priority: 'video',
        videoSegments: [],
        markerSegments: [],
        requestedAtMs: null,
        generatedAtMs: null,
        meta: {}
    };
}

let projectSegmentationInfo = createDefaultProjectSegmentationInfo();
let statsSegmentSelection = STATS_SEGMENT_ALL_VALUE;
const statsSegmentOptionMap = new Map();

function resetStatsSegmentOptionMap() {
    statsSegmentOptionMap.clear();
    statsSegmentOptionMap.set(STATS_SEGMENT_ALL_VALUE, {
        value: STATS_SEGMENT_ALL_VALUE,
        label: 'Весь проект',
        kind: 'all',
        range: null
    });
}

resetStatsSegmentOptionMap();

const manualSegmentationState = {
    enabled: false,
    segments: [],
    updatedAtMs: null,
    version: 0
};

let manualSegmentationProjectDataSnapshot = {
    enabled: false,
    updatedAtMs: null,
    defaultDurationMinutes: 60,
    version: 0,
    segments: []
};

const manualSegmentationListeners = new Set();

function addManualSegmentationListener(listener) {
    if (typeof listener === 'function') {
        manualSegmentationListeners.add(listener);
    }
}

function removeManualSegmentationListener(listener) {
    if (typeof listener === 'function') {
        manualSegmentationListeners.delete(listener);
    }
}

function sanitizeManualSegmentSeconds(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        return 0;
    }
    return Math.round(numeric * 1000) / 1000;
}

function formatManualSegmentStartSeconds(seconds, fractionDigits = 3) {
    const ms = Math.max(0, Math.round(sanitizeManualSegmentSeconds(seconds) * 1000));
    const decimals = Math.max(0, Math.min(3, fractionDigits));
    return PrompterTime.formatHmsMillis(ms, decimals);
}

function manualSegmentTimesEqual(a, b) {
    const left = sanitizeManualSegmentSeconds(a);
    const right = sanitizeManualSegmentSeconds(b);
    return Math.abs(left - right) < 1e-3;
}

function sanitizeManualDefaultDurationMinutes(value, fallback = 60) {
    const fallbackNumeric = Number(fallback);
    const safeFallback = Number.isFinite(fallbackNumeric) && fallbackNumeric > 0 ? fallbackNumeric : 60;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return Math.round(safeFallback);
    }
    const clamped = Math.min(1440, Math.max(1, numeric));
    return Math.round(clamped);
}

function parseManualSegmentTimeInput(raw) {
    if (typeof raw !== 'string') {
        return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    const normalized = trimmed.replace(',', '.');
    if (/^[+]?[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
        const numeric = Number(normalized);
        return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
    }
    const parts = normalized.split(':');
    if (parts.length < 2 || parts.length > 3) {
        return null;
    }
    const secondsPartRaw = parts.pop();
    if (secondsPartRaw === undefined) {
        return null;
    }
    const seconds = Number(secondsPartRaw);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 60) {
        return null;
    }
    let total = seconds;
    const minutesPartRaw = parts.pop();
    if (minutesPartRaw !== undefined) {
        const minutes = Number(minutesPartRaw);
        if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 60) {
            return null;
        }
        total += minutes * 60;
    }
    const hoursPartRaw = parts.pop();
    if (hoursPartRaw !== undefined) {
        const hours = Number(hoursPartRaw);
        if (!Number.isFinite(hours) || hours < 0) {
            return null;
        }
        total += hours * 3600;
    }
    return total;
}

function computeManualSegmentsHash(segments) {
    if (!Array.isArray(segments) || !segments.length) {
        return '[]';
    }
    const normalized = segments.map(segment => ({
        label: segment && typeof segment.label === 'string' ? segment.label.trim() : '',
        start: sanitizeManualSegmentSeconds(segment && segment.startSeconds)
    }));
    normalized.sort((a, b) => {
        const diff = a.start - b.start;
        if (Math.abs(diff) > 1e-3) {
            return diff;
        }
        return a.label.localeCompare(b.label, 'ru');
    });
    return JSON.stringify(normalized);
}

const MANUAL_GENERATOR_MAX_SEGMENTS = 500;

function getManualSegmentDisplayName(segment, index) {
    const ordinal = (typeof index === 'number' ? index : (segment && typeof segment.ordinal === 'number' ? segment.ordinal : 0)) + 1;
    if (!segment || typeof segment.label !== 'string') {
        return `Сегмент ${ordinal}`;
    }
    const trimmed = segment.label.trim();
    return trimmed.length ? trimmed : `Сегмент ${ordinal}`;
}

function coerceSecondsValue(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function sanitizeManualSegmentationList(rawSegments) {
    if (!Array.isArray(rawSegments)) {
        return [];
    }
    const collected = [];
    rawSegments.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') {
            return;
        }
        let startSeconds = coerceSecondsValue(entry.startSeconds ?? entry.start ?? entry.start_second ?? entry.start_sec);
        if (startSeconds === null) {
            const startMs = coerceSecondsValue(entry.startMs ?? entry.start_ms ?? entry.startMilliseconds ?? entry.start_milliseconds);
            if (startMs !== null) {
                startSeconds = startMs / 1000;
            }
        }
        if (startSeconds === null) {
            return;
        }
        let endSeconds = coerceSecondsValue(entry.endSeconds ?? entry.end ?? entry.end_second ?? entry.end_sec);
        if (endSeconds === null) {
            const endMs = coerceSecondsValue(entry.endMs ?? entry.end_ms ?? entry.endMilliseconds ?? entry.end_milliseconds);
            if (endMs !== null) {
                endSeconds = endMs / 1000;
            }
        }
        const label = typeof entry.label === 'string' ? entry.label : (typeof entry.name === 'string' ? entry.name : '');
        const normalizedStart = sanitizeManualSegmentSeconds(startSeconds);
        let normalizedEnd = endSeconds !== null ? Math.max(endSeconds, normalizedStart) : null;
        const hasExplicitEnd = normalizedEnd !== null && normalizedEnd > normalizedStart + 1e-6;
        if (!hasExplicitEnd) {
            normalizedEnd = null;
        }
        collected.push({
            kind: 'manual',
            startSeconds: normalizedStart,
            rawEnd: normalizedEnd,
            label,
            originalIndex: index,
            source: entry.source || 'manual',
            hasExplicitEnd
        });
    });
    collected.sort((a, b) => {
        if (a.startSeconds === b.startSeconds) {
            return a.originalIndex - b.originalIndex;
        }
        return a.startSeconds - b.startSeconds;
    });
    for (let i = 0; i < collected.length; i++) {
        const segment = collected[i];
        const next = collected[i + 1];
        const nextStart = next ? sanitizeManualSegmentSeconds(next.startSeconds) : null;
        const resolvedEndSource = segment.rawEnd !== null ? segment.rawEnd : nextStart;
        const resolvedEnd = resolvedEndSource !== null ? resolvedEndSource : segment.startSeconds;
        segment.endSeconds = sanitizeManualSegmentSeconds(Math.max(segment.startSeconds, resolvedEnd));
        segment.hasExplicitEnd = segment.rawEnd !== null && segment.hasExplicitEnd === true;
        segment.uid = `manual:${i}`;
        segment.ordinal = i;
        segment.label = segment.label && segment.label.trim().length ? segment.label.trim() : `Сегмент ${i + 1}`;
        delete segment.rawEnd;
        delete segment.originalIndex;
    }
    return collected;
}

function setManualSegmentationSegments(rawSegments = [], options = {}) {
    const sanitized = sanitizeManualSegmentationList(rawSegments);
    manualSegmentationState.segments = sanitized;
    manualSegmentationState.updatedAtMs = Date.now();
    manualSegmentationState.version += 1;
    refreshManualSegmentationProjectDataSnapshot();
    if (!options || options.refresh !== false) {
        handleManualSegmentationChanged({ reason: options.reason || 'update' });
    } else {
        updateProjectSettingsButtonVisibility({ reason: options && options.reason ? options.reason : 'update_no_refresh' });
    }
    return sanitized;
}

function getManualSegmentationSegments() {
    return Array.isArray(manualSegmentationState.segments) ? manualSegmentationState.segments : [];
}

function ensureManualDefaultDurationHandles() {
    if (!manualDefaultDurationInput || !manualDefaultDurationInput.length) {
        manualDefaultDurationInput = $('#manual-segment-default-duration-minutes');
    }
    if (!manualDefaultDurationSettingRow || !manualDefaultDurationSettingRow.length) {
        manualDefaultDurationSettingRow = manualDefaultDurationInput && manualDefaultDurationInput.length
            ? manualDefaultDurationInput.closest('.setting-item')
            : $();
    }
}

function setManualDefaultDurationSettingVisibility(enabled) {
    ensureManualDefaultDurationHandles();
    if (!manualDefaultDurationSettingRow || !manualDefaultDurationSettingRow.length) {
        return;
    }
    const shouldShow = !!enabled;
    manualDefaultDurationSettingRow.toggle(shouldShow);
    manualDefaultDurationSettingRow.attr('aria-hidden', shouldShow ? 'false' : 'true');
    if (manualDefaultDurationInput && manualDefaultDurationInput.length) {
        manualDefaultDurationInput.prop('disabled', !shouldShow);
    }
}

function manualSegmentationHasSegments() {
    return getManualSegmentationSegments().length > 0;
}

function isManualSegmentationEnabled() {
    return manualSegmentationState.enabled === true;
}

function getManualDefaultDurationMinutesSetting() {
    const hasDefaults = typeof defaultSettings !== 'undefined' && defaultSettings !== null;
    const fallback = hasDefaults && Number.isFinite(defaultSettings.manualSegmentDefaultDurationMinutes)
        ? defaultSettings.manualSegmentDefaultDurationMinutes
        : 60;
    const current = settings && Number.isFinite(settings.manualSegmentDefaultDurationMinutes)
        ? settings.manualSegmentDefaultDurationMinutes
        : undefined;
    return sanitizeManualDefaultDurationMinutes(current, fallback);
}

function serializeManualSegmentsForProjectData(sourceSegments) {
    const segments = Array.isArray(sourceSegments) ? sourceSegments : [];
    if (!segments.length) {
        return [];
    }
    return segments.map(segment => {
        const start = sanitizeManualSegmentSeconds(segment && segment.startSeconds);
        const label = segment && typeof segment.label === 'string' ? segment.label : '';
        const hasExplicitEnd = segment && segment.hasExplicitEnd === true;
        const endRaw = Number.isFinite(segment && segment.endSeconds)
            ? sanitizeManualSegmentSeconds(Math.max(segment.endSeconds, start))
            : null;
        const ordinal = Number.isFinite(segment && segment.ordinal) ? Number(segment.ordinal) : null;
        const uid = segment && typeof segment.uid === 'string' ? segment.uid : null;
        return {
            label,
            startSeconds: start,
            endSeconds: hasExplicitEnd ? endRaw : null,
            hasExplicitEnd,
            ordinal,
            uid
        };
    });
}

function refreshManualSegmentationProjectDataSnapshot() {
    const runtimeSegments = getManualSegmentationSegments();
    const serialized = serializeManualSegmentsForProjectData(runtimeSegments);
    manualSegmentationProjectDataSnapshot = {
        enabled: isManualSegmentationEnabled() && serialized.length > 0,
        updatedAtMs: Number.isFinite(manualSegmentationState.updatedAtMs) ? manualSegmentationState.updatedAtMs : null,
        defaultDurationMinutes: getManualDefaultDurationMinutesSetting(),
        version: manualSegmentationState.version,
        segments: serialized
    };
    if (!manualSegmentationProjectDataSnapshot.segments.length) {
        manualSegmentationProjectDataSnapshot.enabled = false;
    }
    return manualSegmentationProjectDataSnapshot;
}

function buildManualSegmentationProjectDataEntry() {
    const snapshot = refreshManualSegmentationProjectDataSnapshot();
    if (!snapshot.segments.length) {
        return null;
    }
    return {
        enabled: snapshot.enabled,
        updatedAtMs: snapshot.updatedAtMs,
        defaultDurationMinutes: snapshot.defaultDurationMinutes,
        version: snapshot.version,
        segments: snapshot.segments.map(segment => ({
            label: segment.label,
            startSeconds: segment.startSeconds,
            endSeconds: segment.endSeconds,
            hasExplicitEnd: segment.hasExplicitEnd,
            ordinal: segment.ordinal,
            uid: segment.uid
        }))
    };
}

function applyManualSegmentsFromProjectData(serializedSegments, options = {}) {
    if (!Array.isArray(serializedSegments)) {
        if (options && options.resetOnMissing === true && manualSegmentationHasSegments()) {
            setManualSegmentationSegments([], { reason: options.reason || 'project_data_clear' });
            return { applied: true, cleared: true };
        }
        return { applied: false, reason: 'invalid_payload' };
    }
    const normalized = sanitizeManualSegmentationList(serializedSegments);
    const nextHash = computeManualSegmentsHash(normalized);
    const currentSegments = getManualSegmentationSegments();
    const currentHash = computeManualSegmentsHash(currentSegments);
    if (nextHash === currentHash) {
        refreshManualSegmentationProjectDataSnapshot();
        return { applied: false, reason: 'unchanged' };
    }
    setManualSegmentationSegments(serializedSegments, { reason: options.reason || 'project_data_import' });
    refreshManualSegmentationProjectDataSnapshot();
    return { applied: true };
}

function applyManualSegmentationProjectDataSection(section, options = {}) {
    if (!section || typeof section !== 'object') {
        if (options && options.resetOnMissing === true) {
            setManualSegmentationSegments([], { reason: options.reason || 'project_data_clear' });
            setManualSegmentationEnabled(false, { reason: options.reason || 'project_data_clear' });
            refreshManualSegmentationProjectDataSnapshot();
            return { applied: true, cleared: true };
        }
        return { applied: false, reason: 'invalid_section' };
    }
    const segments = Array.isArray(section.segments) ? section.segments : [];
    const applyResult = applyManualSegmentsFromProjectData(segments, { reason: options.reason || 'project_data_section' });
    let enabled = section.enabled === true;
    if (segments.length > 0) {
        enabled = section.enabled === undefined ? true : enabled;
    }
    const normalizedDuration = sanitizeManualDefaultDurationMinutes(
        section.defaultDurationMinutes,
        getManualDefaultDurationMinutesSetting()
    );
    if (settings) {
        settings.manualSegmentDefaultDurationMinutes = normalizedDuration;
    }
    if (typeof document !== 'undefined') {
        const eventDetail = {
            detail: {
                source: options.reason || 'project_data_section',
                value: normalizedDuration
            }
        };
        if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('frzz:manual-default-duration-updated', eventDetail));
        } else if (document.createEvent) {
            const legacyEvent = document.createEvent('CustomEvent');
            legacyEvent.initCustomEvent('frzz:manual-default-duration-updated', false, false, eventDetail.detail);
            document.dispatchEvent(legacyEvent);
        }
    }
    setManualSegmentationEnabled(enabled, { reason: options.reason || 'project_data_section' });
    refreshManualSegmentationProjectDataSnapshot();
    return {
        applied: applyResult && applyResult.applied === true,
        segments: segments.length,
        enabled
    };
}

let projectSettingsButtonEl = null;
let projectSettingsModalEl = null;
let projectSettingsSectionsEl = null;
let projectSettingsManualFieldsetEl = null;
let manualDefaultDurationInput = null;
let manualDefaultDurationSettingRow = null;

function getProjectSettingsButtonElement() {
    if (projectSettingsButtonEl && projectSettingsButtonEl.length) {
        return projectSettingsButtonEl;
    }
    if (typeof window !== 'undefined' && window.jQuery) {
        const candidate = window.jQuery('#project-settings-button');
        if (candidate && candidate.length) {
            projectSettingsButtonEl = candidate;
            return projectSettingsButtonEl;
        }
    }
    return null;
}

function getProjectSettingsModalElement() {
    if (projectSettingsModalEl && projectSettingsModalEl.length) {
        return projectSettingsModalEl;
    }
    if (typeof window !== 'undefined' && window.jQuery) {
        const candidate = window.jQuery('#project-settings-modal');
        if (candidate && candidate.length) {
            projectSettingsModalEl = candidate;
            return projectSettingsModalEl;
        }
    }
    return null;
}

function getProjectSettingsSections() {
    if (projectSettingsSectionsEl && projectSettingsSectionsEl.length) {
        return projectSettingsSectionsEl;
    }
    if (typeof window !== 'undefined' && window.jQuery) {
        projectSettingsSectionsEl = window.jQuery('#project-settings-body .project-settings-section');
        if (projectSettingsSectionsEl && projectSettingsSectionsEl.length) {
            projectSettingsSectionsEl.each(function registerSectionAvailability() {
                const section = window.jQuery(this);
                if (typeof section.data('project-settings-available') === 'undefined') {
                    const defaultVisible = section.attr('aria-hidden') !== 'true';
                    section.data('project-settings-available', defaultVisible);
                }
            });
        }
        return projectSettingsSectionsEl;
    }
    return null;
}

function getProjectSettingsManualFieldset() {
    if (projectSettingsManualFieldsetEl && projectSettingsManualFieldsetEl.length) {
        return projectSettingsManualFieldsetEl;
    }
    if (typeof window !== 'undefined' && window.jQuery) {
        projectSettingsManualFieldsetEl = window.jQuery('#project-settings-manual-fieldset');
        if (projectSettingsManualFieldsetEl && projectSettingsManualFieldsetEl.length) {
            if (typeof projectSettingsManualFieldsetEl.data('project-settings-available') === 'undefined') {
                const defaultVisible = projectSettingsManualFieldsetEl.attr('aria-hidden') !== 'true';
                projectSettingsManualFieldsetEl.data('project-settings-available', defaultVisible);
            }
        }
        return projectSettingsManualFieldsetEl;
    }
    return null;
}

function projectSettingsHasAvailableSections() {
    const sections = getProjectSettingsSections();
    if (!sections || !sections.length) {
        return false;
    }
    const $ = (typeof window !== 'undefined' && window.jQuery) ? window.jQuery : null;
    let available = false;
    sections.each(function determineAvailability() {
        const section = $ ? $(this) : null;
        if (section && section.length && section.data('project-settings-available') !== false) {
            available = true;
            return false;
        }
        return undefined;
    });
    return available;
}

function setProjectSettingsSectionVisibility(section, visible) {
    if (!section || !section.length) {
        return;
    }
    const shouldShow = !!visible;
    section.data('project-settings-available', shouldShow);
    section.attr('aria-hidden', shouldShow ? 'false' : 'true');
    section.toggleClass('is-hidden', !shouldShow);
    section.toggle(shouldShow);
}

function setProjectSettingsManualSectionVisibility(enabled) {
    const fieldset = getProjectSettingsManualFieldset();
    if (!fieldset || !fieldset.length) {
        return;
    }
    setProjectSettingsSectionVisibility(fieldset, enabled);
}

function shouldShowProjectSettingsButton() {
    return projectSettingsHasAvailableSections();
}

function updateProjectSettingsButtonVisibility(options = {}) {
    const button = getProjectSettingsButtonElement();
    if (!button || !button.length) {
        return;
    }
    const shouldShow = shouldShowProjectSettingsButton();
    if (shouldShow) {
        button.show().attr('aria-hidden', 'false');
    } else {
        button.hide().attr('aria-hidden', 'true');
    }
    if (shouldShow && options && options.focus === true) {
        button.trigger('focus');
    }
}

function showProjectSettingsModal() {
    const modal = getProjectSettingsModalElement();
    if (!modal || !modal.length) {
        return;
    }
    modal.attr('aria-hidden', 'false').show();
}

function hideProjectSettingsModal() {
    const modal = getProjectSettingsModalElement();
    if (!modal || !modal.length) {
        return;
    }
    modal.attr('aria-hidden', 'true').hide();
}

function isManualSegmentationActive() {
    return isManualSegmentationEnabled() && manualSegmentationHasSegments();
}

function handleManualSegmentationChanged(options = {}) {
    if (typeof refreshStatsSegmentationControls === 'function') {
        const preserveSelection = options && options.preserveSelection === true;
        refreshStatsSegmentationControls({ preserveSelection, recalcIfVisible: true });
    }
    const reason = options && options.reason ? options.reason : 'manual_segmentation_change';
    updateProjectSettingsButtonVisibility({ reason });
    for (const listener of manualSegmentationListeners) {
        try {
            listener({ reason });
        } catch (err) {
            console.warn('[Prompter][manualSegmentation] listener failed', err);
        }
    }
}

function setManualSegmentationEnabled(enabled, options = {}) {
    const normalized = !!enabled;
    const previous = isManualSegmentationEnabled();
    const force = options && options.force === true;
    if (!force && previous === normalized) {
        if (options && options.ensureVisibility) {
            setProjectSettingsManualSectionVisibility(normalized);
            setManualDefaultDurationSettingVisibility(normalized);
            updateProjectSettingsButtonVisibility({ reason: options.reason || 'manual_toggle_noop' });
        }
        return previous;
    }
    manualSegmentationState.enabled = normalized;
    manualSegmentationState.updatedAtMs = Date.now();
    setProjectSettingsManualSectionVisibility(normalized);
    setManualDefaultDurationSettingVisibility(normalized);
    refreshManualSegmentationProjectDataSnapshot();
    if (!options || options.refresh !== false) {
        handleManualSegmentationChanged({
            reason: options ? options.reason : 'manual_toggle',
            preserveSelection: options && options.preserveSelection === true
        });
    } else {
        updateProjectSettingsButtonVisibility({ reason: options.reason || 'manual_toggle' });
    }
    return normalized;
}

function sanitizeSegmentList(rawList, kind) {
    const result = [];
    if (!Array.isArray(rawList)) {
        return result;
    }
    rawList.forEach((entry, idx) => {
        if (!entry || typeof entry !== 'object') {
            return;
        }
        const startSecondsRaw = Number(entry.start);
        if (!Number.isFinite(startSecondsRaw)) {
            return;
        }
        const segment = {
            kind,
            startSeconds: Math.max(0, startSecondsRaw),
            _originalOrder: idx
        };
        if (kind === 'video') {
            segment.fileName = typeof entry.file_name === 'string' ? entry.file_name : '';
            segment.trackName = typeof entry.track_name === 'string' ? entry.track_name : '';
        } else {
            segment.name = typeof entry.name === 'string' ? entry.name : '';
            segment.markerSource = entry.source === 'region' ? 'region' : 'marker';
            const markerIndex = Number(entry.index);
            segment.projectIndex = Number.isFinite(markerIndex) ? markerIndex : null;
        }
        result.push(segment);
    });
    result.sort((a, b) => {
        if (a.startSeconds === b.startSeconds) {
            return a._originalOrder - b._originalOrder;
        }
        return a.startSeconds - b.startSeconds;
    });
    for (let i = 0; i < result.length; i++) {
        const next = result[i + 1];
        const nextStart = next ? next.startSeconds : Number.POSITIVE_INFINITY;
        result[i].endSeconds = nextStart < result[i].startSeconds ? result[i].startSeconds : nextStart;
        result[i].uid = `${kind}:${i}`;
        result[i].ordinal = i;
        delete result[i]._originalOrder;
    }
    return result;
}

function sanitizeProjectSegmentationSnapshot(raw) {
    const info = createDefaultProjectSegmentationInfo();
    if (!raw || typeof raw !== 'object') {
        return info;
    }
    const modeRaw = typeof raw.mode === 'string' ? raw.mode.toLowerCase() : 'none';
    info.mode = (modeRaw === 'video' || modeRaw === 'markers' || modeRaw === 'both') ? modeRaw : 'none';
    info.priority = raw.priority === 'markers' ? 'markers' : 'video';
    const requestedMs = Number(raw.requested_at_ms);
    info.requestedAtMs = Number.isFinite(requestedMs) ? requestedMs : null;
    const generatedMs = Number(raw.generated_at_ms);
    info.generatedAtMs = Number.isFinite(generatedMs) ? generatedMs : null;
    info.videoSegments = sanitizeSegmentList(raw.SegByVideo, 'video');
    info.markerSegments = sanitizeSegmentList(raw.SegByMarkers, 'markers');
    info.meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
    if (info.mode === 'none') {
        info.videoSegments = [];
        info.markerSegments = [];
    } else {
        const modeIncludesVideo = info.mode === 'video' || info.mode === 'both';
        const modeIncludesMarkers = info.mode === 'markers' || info.mode === 'both';
        const hasMeaningfulVideo = modeIncludesVideo && info.videoSegments.length > 1;
        const hasMeaningfulMarkers = modeIncludesMarkers && info.markerSegments.length > 1;
        if (!hasMeaningfulVideo && !hasMeaningfulMarkers) {
            info.mode = 'none';
            info.videoSegments = [];
            info.markerSegments = [];
        }
    }
    return info;
}

function determinePrimarySegmentKind(info) {
    if (!info) {
        return null;
    }
    if (info.priority === 'markers' && info.markerSegments.length) {
        return 'markers';
    }
    if (info.priority === 'video' && info.videoSegments.length) {
        return 'video';
    }
    if (info.videoSegments.length) {
        return 'video';
    }
    if (info.markerSegments.length) {
        return 'markers';
    }
    return null;
}

function formatStatsSegmentLabel(segment, index, kind) {
    const ordinal = index + 1;
    if (kind === 'video') {
        const baseName = segment.fileName && segment.fileName.trim().length ? segment.fileName.trim() : `Видео ${ordinal}`;
        const trackSuffix = segment.trackName && segment.trackName.trim().length ? ` · ${segment.trackName.trim()}` : '';
        return `${ordinal}. Видео: ${baseName}${trackSuffix}`;
    }
    let sourceLabel;
    if (segment.markerSource === 'region') {
        sourceLabel = 'Регион';
    } else if (segment.markerSource === 'manual') {
        sourceLabel = 'Сегмент';
    } else {
        sourceLabel = 'Маркер';
    }
    const base = segment.name && segment.name.trim().length ? segment.name.trim() : `${sourceLabel} ${ordinal}`;
    return `${ordinal}. ${sourceLabel}: ${base}`;
}

function formatManualSegmentLabel(segment, index) {
    const ordinal = index + 1;
    if (!segment) {
        return `${ordinal}. Сегмент ${ordinal}`;
    }
    const base = segment.label && segment.label.trim().length ? segment.label.trim() : `Сегмент ${ordinal}`;
    return `${ordinal}. ${base}`;
}

function getManualSegmentsForStats() {
    // Manual segments should behave like marker-based segments in statistics.
    if (!isManualSegmentationActive()) {
        return [];
    }
    const manualSegments = getManualSegmentationSegments();
    if (!Array.isArray(manualSegments) || !manualSegments.length) {
        return [];
    }
    const mapped = [];
    for (let i = 0; i < manualSegments.length; i++) {
        const segment = manualSegments[i];
        if (!segment || typeof segment.startSeconds !== 'number') {
            continue;
        }
        const start = sanitizeManualSegmentSeconds(segment.startSeconds);
        if (!Number.isFinite(start) || start < 0) {
            continue;
        }
        const next = manualSegments[i + 1];
        const explicitEnd = segment && segment.hasExplicitEnd === true;
        const rawEndValue = Number(segment.endSeconds);
        let resolvedEnd = Number.isFinite(rawEndValue) ? Math.max(rawEndValue, start) : NaN;
        if (explicitEnd) {
            if (!Number.isFinite(resolvedEnd) || resolvedEnd <= start) {
                resolvedEnd = start;
            }
        } else {
            const nextStart = next && typeof next.startSeconds === 'number' ? sanitizeManualSegmentSeconds(next.startSeconds) : Number.POSITIVE_INFINITY;
            if (Number.isFinite(resolvedEnd) && resolvedEnd > start) {
                // keep inferred value (likely came from next start already)
            } else if (Number.isFinite(nextStart) && nextStart > start) {
                resolvedEnd = nextStart;
            } else {
                resolvedEnd = Number.POSITIVE_INFINITY;
            }
        }
        if (!Number.isFinite(resolvedEnd)) {
            resolvedEnd = Number.POSITIVE_INFINITY;
        }
        const fallbackOrdinal = mapped.length;
        const ordinal = Number.isFinite(segment.ordinal) ? segment.ordinal : fallbackOrdinal;
        const uid = typeof segment.uid === 'string' ? segment.uid : `manual:${ordinal}`;
        const label = segment.label && segment.label.trim().length ? segment.label.trim() : `Сегмент ${ordinal + 1}`;
        mapped.push({
            uid,
            startSeconds: start,
            endSeconds: resolvedEnd,
            ordinal,
            kind: 'markers',
            markerSource: 'manual',
            name: label,
            source: 'manual',
            manualOverride: true,
            baseSegment: segment,
            hasExplicitEnd: explicitEnd
        });
    }
    return mapped;
}

function buildStatsSegmentOptions(info) {
    const options = [{
        value: STATS_SEGMENT_ALL_VALUE,
        label: 'Весь проект',
        range: null,
        kind: 'all'
    }];
    const manualMarkerSegments = getManualSegmentsForStats();
    if (manualMarkerSegments.length) {
        manualMarkerSegments.forEach((segment, index) => {
            if (!segment || typeof segment.startSeconds !== 'number') {
                return;
            }
            const ordinal = Number.isFinite(segment.ordinal) ? segment.ordinal : index;
            options.push({
                value: segment.uid,
                label: formatStatsSegmentLabel(segment, ordinal, 'markers'),
                range: {
                    startSeconds: segment.startSeconds,
                    endSeconds: segment.endSeconds
                },
                kind: 'markers',
                segment
            });
        });
        return {
            options,
            primaryKind: 'markers',
            segments: manualMarkerSegments,
            source: 'manual',
            manualOverride: true
        };
    }
    const primaryKind = determinePrimarySegmentKind(info);
    let segments = [];
    if (primaryKind) {
        segments = primaryKind === 'markers' ? info.markerSegments : info.videoSegments;
        segments.forEach(segment => {
            options.push({
                value: segment.uid,
                label: formatStatsSegmentLabel(segment, segment.ordinal, primaryKind),
                range: {
                    startSeconds: segment.startSeconds,
                    endSeconds: segment.endSeconds
                },
                kind: primaryKind,
                segment
            });
        });
    }
    return {
        options,
        primaryKind,
        segments,
        source: primaryKind === 'markers' ? 'markers' : (primaryKind === 'video' ? 'video' : null)
    };
}

function determineStatsSegmentSelectionForTime(info, seconds) {
    const time = Number(seconds);
    const manualSegments = getManualSegmentsForStats();
    if (manualSegments.length) {
        if (!Number.isFinite(time) || time < 0) {
            return manualSegments[0] && typeof manualSegments[0].uid === 'string'
                ? manualSegments[0].uid
                : STATS_SEGMENT_ALL_VALUE;
        }
        let manualCandidate = null;
        for (let i = 0; i < manualSegments.length; i++) {
            const segment = manualSegments[i];
            if (!segment || typeof segment.uid !== 'string') {
                continue;
            }
            const start = Number(segment.startSeconds);
            if (!Number.isFinite(start)) {
                continue;
            }
            if (time < start - SEGMENT_RANGE_EPSILON) {
                break;
            }
            manualCandidate = segment;
            const endRaw = Number(segment.endSeconds);
            const end = Number.isFinite(endRaw) ? endRaw : Number.POSITIVE_INFINITY;
            if (time < end - SEGMENT_RANGE_EPSILON) {
                return segment.uid;
            }
        }
        return manualCandidate && typeof manualCandidate.uid === 'string'
            ? manualCandidate.uid
            : STATS_SEGMENT_ALL_VALUE;
    }
    if (!info || info.mode === 'none') {
        return STATS_SEGMENT_ALL_VALUE;
    }
    if (!Number.isFinite(time) || time < 0) {
        return STATS_SEGMENT_ALL_VALUE;
    }
    const primaryKind = determinePrimarySegmentKind(info);
    if (!primaryKind) {
        return STATS_SEGMENT_ALL_VALUE;
    }
    const segments = primaryKind === 'markers' ? info.markerSegments : info.videoSegments;
    if (!Array.isArray(segments) || !segments.length) {
        return STATS_SEGMENT_ALL_VALUE;
    }
    let candidate = null;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (!segment || typeof segment.uid !== 'string') {
            continue;
        }
        const start = Number(segment.startSeconds);
        if (!Number.isFinite(start)) {
            continue;
        }
        if (time < start - SEGMENT_RANGE_EPSILON) {
            break;
        }
        candidate = segment;
        const endRaw = Number(segment.endSeconds);
        const end = Number.isFinite(endRaw) ? endRaw : Number.POSITIVE_INFINITY;
        if (time < end - SEGMENT_RANGE_EPSILON) {
            return segment.uid;
        }
    }
    return candidate && typeof candidate.uid === 'string' ? candidate.uid : STATS_SEGMENT_ALL_VALUE;
}

let statsSegmentControlsEl = null;
let statsSegmentSelectEl = null;
let statsSegmentSourceEl = null;
let statsModalEl = null;
let statsRolesSectionEl = null;
let statsActorsSectionEl = null;
let statsColorsSectionEl = null;
let statsEmptyEl = null;
let statsRolesTableBodyEl = null;
let statsActorsTableBodyEl = null;
let statsColorsTableBodyEl = null;
let statsRolesTotalEl = null;
let statsActorsTotalEl = null;
let statsColorsTotalEl = null;

let renderStatsTablesRef = null;

let roleToActor = {};

function refreshStatsSegmentationControls(options = {}) {
    const preserveSelection = options && options.preserveSelection === true;
    const recalcIfVisible = options && options.recalcIfVisible === true;
    const resolved = buildStatsSegmentOptions(projectSegmentationInfo);
    resetStatsSegmentOptionMap();
    resolved.options.forEach(option => {
        statsSegmentOptionMap.set(option.value, option);
    });
    const availableValues = resolved.options.map(option => option.value);
    if (!preserveSelection || !availableValues.includes(statsSegmentSelection)) {
        statsSegmentSelection = availableValues.includes(STATS_SEGMENT_ALL_VALUE)
            ? STATS_SEGMENT_ALL_VALUE
            : (availableValues[0] || STATS_SEGMENT_ALL_VALUE);
    }
    if (!statsSegmentControlsEl || !statsSegmentSelectEl) {
        if (recalcIfVisible && typeof renderStatsTablesRef === 'function' && statsModalEl && statsModalEl.length && statsModalEl.is(':visible')) {
            renderStatsTablesRef({ openModal: false });
        }
        return;
    }
    statsSegmentSelectEl.empty();
    resolved.options.forEach(option => {
        statsSegmentSelectEl.append($('<option>').val(option.value).text(option.label));
    });
    statsSegmentSelectEl.val(statsSegmentSelection);
    if (resolved.options.length > 1 && resolved.primaryKind) {
        statsSegmentControlsEl.show();
        if (statsSegmentSourceEl && statsSegmentSourceEl.length) {
            let sourceLabel;
            if (resolved.source === 'manual' || resolved.primaryKind === 'manual') {
                sourceLabel = 'ручной режим';
            } else if (resolved.primaryKind === 'markers') {
                sourceLabel = 'маркеры/регионы';
            } else if (resolved.primaryKind === 'video') {
                sourceLabel = 'видеофайлы';
            } else {
                sourceLabel = 'неизвестно';
            }
            const segmentCount = Array.isArray(resolved.segments) ? resolved.segments.length : 0;
            statsSegmentSourceEl.text(`Источник: ${sourceLabel}. Сегментов: ${segmentCount}`);
            statsSegmentSourceEl.show();
        }
    } else {
        statsSegmentControlsEl.hide();
        if (statsSegmentSourceEl && statsSegmentSourceEl.length) {
            statsSegmentSourceEl.text('');
            statsSegmentSourceEl.hide();
        }
    }
    if (recalcIfVisible && typeof renderStatsTablesRef === 'function' && statsModalEl && statsModalEl.length && statsModalEl.is(':visible')) {
        renderStatsTablesRef({ openModal: false });
    }
}

function getActiveStatsSegmentRange() {
    const entry = statsSegmentOptionMap.get(statsSegmentSelection);
    if (!entry || !entry.range) {
        return null;
    }
    return entry.range;
}

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
    settingsSchemaVersion: 8,
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
    segmentationEnabled: true,
    segmentationAutoVideoEnabled: true,
    segmentationAutoVideoKeywords: 'ВИДЕО, ВИДОС, ВИДОСЫ, VID, VIDEO, RAW, РАВКА',
    segmentationAutoMarkersEnabled: true,
    segmentationMarkerPattern: '$N (сери*|эпизод*|част*)',
    segmentationAutodetectPriority: 'video',
    segmentationDisplayMode: 'current',
    segmentationAutoSwitchMode: 'playback_only',
    segmentationManualEnabled: true,
    manualSegmentDefaultDurationMinutes: 60,
    enableColorSwatches: true,
    ignoreProjectItemColors: true,
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
    highlightOverlapEnabled: false,
    highlightOverlapColor: 'rgba(255, 112, 67, 0.75)',
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
const FILTER_STATE_KEYS = ['filterSoloRoles', 'filterMuteRoles', 'filterSoloActors', 'filterMuteActors'];
let currentProjectName = '';
let animationFrameId = null;
let wwr_is_enabled = false;
let navigationPanelCollapsed = false;
const NAV_PANEL_ANIMATION_MS = 280; // Keep in sync with CSS transition timings
let navigationPanelAnimationTimer = null;
// Removed initialLoad flag: applySettings now, by default, uses in-memory `settings` object (source of truth)
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
const MOBILE_UI_SCALE_MULTIPLIER = 0.75;
const OVERLAP_EPSILON_MS = 1; // минимальная длительность для обнаружения пересечений
const OVERLAP_SCRATCH_MIN_CAPACITY = 256;

const overlapScratchStore = {
    capacity: 0,
    startMs: null,
    endMs: null,
    parent: null,
    unionSize: null,
    overlapCount: null,
    order: [],
    active: []
};

let activeOverlapLineIndices = [];
let activeOverlapBlocks = [];
let activeOverlapBlockMap = new Map();

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
        normalized: 'unknown'
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
    projectSegmentationInfo = createDefaultProjectSegmentationInfo();
    statsSegmentSelection = STATS_SEGMENT_ALL_VALUE;
    resetStatsSegmentOptionMap();
    refreshStatsSegmentationControls({ preserveSelection: false, recalcIfVisible: true });
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

function updateProjectDataCacheWithRolesSnapshot(jsonText, manualSegments) {
    const text = typeof jsonText === 'string' ? jsonText.trim() : '';
    if (!text) {
        return;
    }
    if (!projectDataCache || typeof projectDataCache !== 'object') {
        projectDataCache = {};
    }
    projectDataCache.roles = {
        encoding: 'plain',
        json: text,
        updatedAt: Date.now()
    };
    if (!Array.isArray(projectDataCache.projectData)) {
        projectDataCache.projectData = [];
    }
    if (projectDataCache.projectData.length === 0) {
        projectDataCache.projectData.push({});
    }
    const target = projectDataCache.projectData[0];
    if (target && typeof target === 'object') {
        if (Array.isArray(manualSegments)) {
            target.manualSegments = manualSegments.map(segment => ({
                label: segment && typeof segment.label === 'string' ? segment.label : '',
                startSeconds: Number.isFinite(segment && segment.startSeconds) ? segment.startSeconds : 0,
                endSeconds: Number.isFinite(segment && segment.endSeconds) ? segment.endSeconds : null,
                hasExplicitEnd: segment && segment.hasExplicitEnd === true,
                ordinal: Number.isFinite(segment && segment.ordinal) ? segment.ordinal : null,
                uid: segment && typeof segment.uid === 'string' ? segment.uid : null
            }));
        } else {
            delete target.manualSegments;
        }
        delete target.manualSegmentation;
    }
    storeProjectDataCache(projectDataCache);
}

$(document).ready(function() {
    const initStartTs = performance.now();
    // --- ПЕРЕМЕННЫЕ ---
    const REASCRIPT_ACTION_ID = "_FRZZ_WEB_NOTES_READER";
    const BASE_LINE_SPACING = 0.5;
    const BASE_ROLE_WIDTH = 9.375;
    const BASE_ROLE_FONT_SIZE = 0.9;
    const mainTitle = $('h1');
    const settingsAppVersion = $('#settings-app-version');
    const trackSelector = $('#track-selector');
    const textDisplay = $('#text-display');
    const textDisplayWrapper = $('#text-display-wrapper');
    const textDisplayEl = textDisplay[0] || null;
    const textDisplayWrapperEl = textDisplayWrapper[0] || null;
    const JUMP_REQUEST_DEBOUNCE_MS = 150;
    let transportProgressValue = 0;
    const statusIndicator = $('#status-indicator');
    projectSettingsButtonEl = $('#project-settings-button');
    projectSettingsModalEl = $('#project-settings-modal');
    const projectManualCurrentSection = $('#project-manual-current-section');
    const projectManualTableBody = $('#project-manual-table tbody');
    const projectManualEmptyState = $('#project-manual-current-empty');
    const projectManualGenerator = $('#project-manual-generator');
    const projectManualGeneratorToggle = $('#project-manual-generate-toggle');
    const projectManualSaveButton = $('#project-manual-save-button');
    const projectManualClearButton = $('#project-manual-clear-button');
    const projectManualResetButton = $('#project-manual-reset-button');
    const projectManualAppendButton = $('#project-manual-generate-append-button');
    const projectManualReplaceButton = $('#project-manual-generate-replace-button');
    const projectManualDurationValue = $('#project-manual-duration-value');
    const projectManualDurationUnit = $('#project-manual-duration-unit');
    const projectManualGenerateNamesToggle = $('#project-manual-generate-names');
    const projectManualMaskRow = $('#project-settings-manual-fieldset .project-manual-mask-row');
    const projectManualNameMaskInput = $('#project-manual-name-mask');
    const projectManualStartTimeInput = $('#project-manual-start-time');
    const projectManualStartIndexInput = $('#project-manual-start-index');
    const projectManualCountInput = $('#project-manual-count');
    const projectManualGenerateButton = $('#project-manual-generate-button');
    manualDefaultDurationInput = $('#manual-segment-default-duration-minutes');
    if (manualDefaultDurationInput && manualDefaultDurationInput.length) {
        manualDefaultDurationSettingRow = manualDefaultDurationInput.closest('.setting-item');
    }
    setManualDefaultDurationSettingVisibility(isManualSegmentationEnabled());
    setProjectSettingsManualSectionVisibility(isManualSegmentationEnabled());

    const updateProjectManualMaskState = () => {
        const enabled = !projectManualGenerateNamesToggle.length || projectManualGenerateNamesToggle.is(':checked');
        if (projectManualNameMaskInput && projectManualNameMaskInput.length) {
            projectManualNameMaskInput.prop('disabled', !enabled);
        }
        if (projectManualMaskRow && projectManualMaskRow.length) {
            projectManualMaskRow.toggleClass('is-disabled', !enabled);
        }
    };
    updateProjectSettingsButtonVisibility({ reason: 'dom_ready_init' });

    if (projectManualGeneratorToggle && projectManualGeneratorToggle.length && projectManualGenerator && projectManualGenerator.length) {
        projectManualGeneratorToggle.on('click', function(event) {
            event.preventDefault();
            const expanded = $(this).attr('aria-expanded') === 'true';
            const nextState = !expanded;
            $(this).attr('aria-expanded', String(nextState));
            projectManualGenerator.toggleClass('is-hidden', !nextState).attr('aria-hidden', String(!nextState));
        });
    }

    if (projectManualDurationUnit && projectManualDurationUnit.length && projectManualDurationValue && projectManualDurationValue.length) {
        projectManualDurationUnit.data('previous-unit', projectManualDurationUnit.val() || 'minutes');
        projectManualDurationUnit.on('change', function() {
            const selectEl = $(this);
            const prevUnit = selectEl.data('previous-unit') || 'minutes';
            const nextUnit = selectEl.val();
            if (!nextUnit || nextUnit === prevUnit) {
                selectEl.data('previous-unit', nextUnit);
                return;
            }
            const rawValue = projectManualDurationValue.val();
            const numericValue = Number(rawValue);
            if (Number.isFinite(numericValue)) {
                let converted = numericValue;
                if (prevUnit === 'minutes' && nextUnit === 'hours') {
                    converted = numericValue / 60;
                } else if (prevUnit === 'hours' && nextUnit === 'minutes') {
                    converted = numericValue * 60;
                }
                const normalized = Math.round(converted * 1000) / 1000;
                const formatted = Number.isInteger(normalized)
                    ? String(normalized)
                    : normalized.toFixed(3).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
                projectManualDurationValue.val(formatted);
                projectManualDurationValue.data('manual-generator-edited', true);
            }
            selectEl.data('previous-unit', nextUnit);
            markManualGeneratorFieldValidity(projectManualDurationValue, true);
            setProjectManualGeneratorMessage(null, '');
        });
    }

    if (projectManualGenerateNamesToggle && projectManualGenerateNamesToggle.length) {
        projectManualGenerateNamesToggle.on('change', updateProjectManualMaskState);
    }
    updateProjectManualMaskState();

    if (projectManualCurrentSection && projectManualCurrentSection.length) {
        projectManualCurrentSection.removeClass('is-hidden');
    }

    const projectManualAddButton = $('#project-manual-add-button');
    const projectManualGeneratorButtons = $('#project-manual-generator-buttons');
    let projectManualGeneratorMessage = null;
    if (projectManualGeneratorButtons && projectManualGeneratorButtons.length) {
        projectManualGeneratorMessage = $('<p class="settings-helper-text project-manual-generator-message" aria-live="polite" role="status"></p>');
        projectManualGeneratorMessage.hide();
        projectManualGeneratorMessage.insertAfter(projectManualGeneratorButtons);
    } else if (projectManualGenerator && projectManualGenerator.length) {
        projectManualGeneratorMessage = $('<p class="settings-helper-text project-manual-generator-message" aria-live="polite" role="status"></p>');
        projectManualGeneratorMessage.hide();
        projectManualGenerator.append(projectManualGeneratorMessage);
    }
    if (projectManualGeneratorMessage && projectManualGeneratorMessage.length) {
        setProjectManualGeneratorMessage(null, '');
    }
    if (projectManualCountInput && projectManualCountInput.length) {
        projectManualCountInput.attr('max', MANUAL_GENERATOR_MAX_SEGMENTS);
    }

    const projectManualUiState = {
        draftSegments: [],
        dirty: false,
        currentHash: '[]',
        lastSavedHash: '[]',
        lastRuntimeVersion: manualSegmentationState.version,
        nextOrderToken: 1,
        editing: null
    };

    function getManualDefaultDurationSeconds() {
        return getManualDefaultDurationMinutesSetting() * 60;
    }

    function updateGeneratorDefaultFromSettings(options = {}) {
        if (!projectManualDurationValue || !projectManualDurationValue.length) {
            return;
        }
        const force = options && options.force === true;
        const wasEdited = projectManualDurationValue.data('manual-generator-edited') === true;
        if (!force && wasEdited) {
            return;
        }
        const defaultMinutes = getManualDefaultDurationMinutesSetting();
        projectManualDurationValue.val(defaultMinutes);
        projectManualDurationValue.data('manual-generator-edited', false);
        if (projectManualDurationUnit && projectManualDurationUnit.length) {
            projectManualDurationUnit.val('minutes');
            projectManualDurationUnit.data('previous-unit', 'minutes');
        }
    }

    updateGeneratorDefaultFromSettings({ force: true });
    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        window.setTimeout(() => updateGeneratorDefaultFromSettings({ force: true }), 0);
    }
    refreshManualSegmentationProjectDataSnapshot();

    if (projectManualDurationValue && projectManualDurationValue.length) {
        projectManualDurationValue.on('input change', function() {
            projectManualDurationValue.data('manual-generator-edited', true);
        });
    }

    if (manualDefaultDurationInput && manualDefaultDurationInput.length) {
        manualDefaultDurationInput.on('change', function() {
            const sanitized = sanitizeManualDefaultDurationMinutes(
                $(this).val(),
                defaultSettings.manualSegmentDefaultDurationMinutes
            );
            $(this).val(sanitized);
            if (projectManualDurationValue && projectManualDurationValue.length) {
                projectManualDurationValue.val(sanitized);
                projectManualDurationValue.data('manual-generator-edited', false);
                if (projectManualDurationUnit && projectManualDurationUnit.length) {
                    projectManualDurationUnit.val('minutes');
                    projectManualDurationUnit.data('previous-unit', 'minutes');
                }
            }
            refreshManualSegmentationProjectDataSnapshot();
        });
    }

    if (typeof document !== 'undefined') {
        document.addEventListener('frzz:manual-default-duration-updated', event => {
            if (event && event.detail && Number.isFinite(event.detail.value)) {
                const normalized = sanitizeManualDefaultDurationMinutes(event.detail.value, getManualDefaultDurationMinutesSetting());
                if (settings) {
                    settings.manualSegmentDefaultDurationMinutes = normalized;
                }
            }
            updateGeneratorDefaultFromSettings({ force: true });
            refreshManualSegmentationProjectDataSnapshot();
        });
    }

    function getManualSegmentDomId(segment) {
        if (!segment) return '';
        if (segment.uid && typeof segment.uid === 'string') {
            return segment.uid;
        }
        if (!segment.__draftId) {
            segment.__draftId = `draft:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        }
        return segment.__draftId;
    }

    function findManualDraftSegment(segmentId) {
        if (!segmentId) return null;
        return projectManualUiState.draftSegments.find(segment => getManualSegmentDomId(segment) === segmentId) || null;
    }

    function sortManualDraftSegments() {
        projectManualUiState.draftSegments.sort((a, b) => {
            const delta = sanitizeManualSegmentSeconds(a.startSeconds) - sanitizeManualSegmentSeconds(b.startSeconds);
            if (Math.abs(delta) > 1e-3) {
                return delta;
            }
            const orderA = typeof a.__orderToken === 'number' ? a.__orderToken : 0;
            const orderB = typeof b.__orderToken === 'number' ? b.__orderToken : 0;
            if (orderA !== orderB) {
                return orderA - orderB;
            }
            const labelA = (a.label || '').toLowerCase();
            const labelB = (b.label || '').toLowerCase();
            return labelA.localeCompare(labelB, 'ru');
        });
        projectManualUiState.draftSegments.forEach((segment, index) => {
            segment.ordinal = index;
        });
    }

    function updateManualDraftDirtyState() {
        const hash = computeManualSegmentsHash(projectManualUiState.draftSegments);
        projectManualUiState.currentHash = hash;
        projectManualUiState.dirty = hash !== projectManualUiState.lastSavedHash;
    }

    function updateProjectManualGeneratorButtons(hasSegments) {
        const effective = typeof hasSegments === 'boolean' ? hasSegments : projectManualUiState.draftSegments.length > 0;
        if (projectManualGeneratorButtons && projectManualGeneratorButtons.length) {
            projectManualGeneratorButtons.find('.project-manual-action-empty').toggle(!effective);
        }
        if (projectManualAppendButton && projectManualAppendButton.length) {
            projectManualAppendButton.toggle(effective);
            projectManualAppendButton.prop('disabled', !effective);
        }
        if (projectManualReplaceButton && projectManualReplaceButton.length) {
            projectManualReplaceButton.toggle(effective);
            projectManualReplaceButton.prop('disabled', !effective);
        }
    }

    function setProjectManualGeneratorMessage(kind, text) {
        if (!projectManualGeneratorMessage || !projectManualGeneratorMessage.length) {
            return;
        }
        const messageText = typeof text === 'string' ? text.trim() : '';
        projectManualGeneratorMessage.removeClass('is-error is-success is-info');
        if (!messageText) {
            projectManualGeneratorMessage.text('').hide();
            projectManualGeneratorMessage.removeAttr('data-kind');
            return;
        }
        const normalizedKind = kind === 'error' ? 'error' : (kind === 'success' ? 'success' : 'info');
        projectManualGeneratorMessage.text(messageText).show().attr('data-kind', normalizedKind);
        projectManualGeneratorMessage.addClass(`is-${normalizedKind}`);
    }

    function markManualGeneratorFieldValidity(inputEl, isValid, message) {
        if (!inputEl || !inputEl.length) {
            return;
        }
        if (isValid) {
            inputEl.removeClass('project-manual-generator-invalid');
            inputEl.removeAttr('aria-invalid');
            const previousTitle = inputEl.data('manualGeneratorPrevTitle');
            if (previousTitle !== undefined) {
                if (previousTitle && previousTitle !== '__cleared__') {
                    inputEl.attr('title', previousTitle);
                } else {
                    inputEl.removeAttr('title');
                }
                inputEl.removeData('manualGeneratorPrevTitle');
            }
            return;
        }
        if (!inputEl.data('manualGeneratorPrevTitle')) {
            const currentTitle = inputEl.attr('title');
            inputEl.data('manualGeneratorPrevTitle', currentTitle ? currentTitle : '__cleared__');
        }
        inputEl.addClass('project-manual-generator-invalid');
        inputEl.attr('aria-invalid', 'true');
        if (typeof message === 'string' && message.trim()) {
            inputEl.attr('title', message);
        }
    }

    function clearManualGeneratorValidation() {
        [projectManualStartTimeInput, projectManualDurationValue, projectManualStartIndexInput, projectManualCountInput].forEach(input => {
            if (input && input.length) {
                markManualGeneratorFieldValidity(input, true);
            }
        });
    }

    function getManualGeneratorTimelineEndSeconds() {
        if (!Array.isArray(subtitleData) || !subtitleData.length) {
            return null;
        }
        let maxEnd = 0;
        for (let i = 0; i < subtitleData.length; i += 1) {
            const line = subtitleData[i];
            if (!line) continue;
            const candidates = [
                Number(line.end_time),
                Number(line.end),
                Number(line.endSeconds),
                Number(line.end_seconds),
                Number(line.endTime),
                Number(line.endTimeSeconds)
            ];
            for (let j = 0; j < candidates.length; j += 1) {
                const value = candidates[j];
                if (Number.isFinite(value) && value > maxEnd) {
                    maxEnd = value;
                }
            }
        }
        return maxEnd > 0 ? maxEnd : null;
    }

    function deriveManualGeneratorCount({ mode, existingSegments, startSeconds, durationSeconds }) {
        const normalizedMode = mode === 'append' ? 'append' : 'replace';
        const result = { count: 0, timelineEndSeconds: null };
        const existing = Array.isArray(existingSegments) ? existingSegments : [];
        if (normalizedMode === 'replace' && existing.length) {
            result.count = existing.length;
        }
        if (!result.count) {
            const primaryKind = determinePrimarySegmentKind(projectSegmentationInfo);
            let autoSegments = [];
            if (primaryKind === 'markers') {
                autoSegments = Array.isArray(projectSegmentationInfo.markerSegments) ? projectSegmentationInfo.markerSegments : [];
            } else if (primaryKind === 'video') {
                autoSegments = Array.isArray(projectSegmentationInfo.videoSegments) ? projectSegmentationInfo.videoSegments : [];
            }
            if (autoSegments.length) {
                result.count = autoSegments.length;
            }
        }
        if (!result.count) {
            const timelineEnd = getManualGeneratorTimelineEndSeconds();
            if (Number.isFinite(timelineEnd) && Number.isFinite(durationSeconds) && durationSeconds > 0) {
                const effectiveStart = Number.isFinite(startSeconds) ? startSeconds : 0;
                const available = Math.max(0, timelineEnd - effectiveStart);
                if (available > 0) {
                    result.count = Math.max(1, Math.ceil(available / durationSeconds));
                    result.timelineEndSeconds = timelineEnd;
                }
            }
        }
        if (!result.count) {
            result.count = existing.length ? existing.length : 1;
        }
        result.count = Math.max(1, Math.min(MANUAL_GENERATOR_MAX_SEGMENTS, Math.round(result.count)));
        return result;
    }

    function formatManualGeneratorLabel(mask, ordinal) {
        const index = Math.max(1, Math.round(ordinal));
        const ordinalString = String(index);
        let template = typeof mask === 'string' ? mask.trim() : '';
        if (!template) {
            return `Сегмент ${ordinalString}`;
        }
        if (!template.includes('$N')) {
            return `${template} ${ordinalString}`;
        }
        return template.replace(/\$N+/g, token => {
            const width = Math.max(1, token.length - 1);
            return width > 1 ? ordinalString.padStart(width, '0') : ordinalString;
        });
    }

    function buildManualGeneratorSegments(params) {
        const segments = [];
        if (!params || !Number.isFinite(params.count) || params.count <= 0) {
            return segments;
        }
        const total = Math.max(1, Math.floor(params.count));
        const baseMs = Math.max(0, Math.round(Math.max(0, params.startSeconds || 0) * 1000));
        const intervalMs = Math.max(1, Math.round(params.durationSeconds * 1000));
        const alignToTimeline = Number.isFinite(params.timelineEndSeconds);
        const timelineEndMs = alignToTimeline ? Math.max(baseMs, Math.round(params.timelineEndSeconds * 1000)) : null;
        const startOrdinal = Number.isFinite(params.startIndex) && params.startIndex > 0
            ? Math.max(1, Math.round(params.startIndex))
            : 1;
        const nameMask = typeof params.nameMask === 'string' ? params.nameMask : '';
        for (let index = 0; index < total; index += 1) {
            const startMs = baseMs + intervalMs * index;
            let endMs = startMs + intervalMs;
            if (alignToTimeline && index === total - 1 && timelineEndMs !== null) {
                endMs = Math.max(startMs, timelineEndMs);
            }
            const startSeconds = sanitizeManualSegmentSeconds(startMs / 1000);
            const endSeconds = sanitizeManualSegmentSeconds(endMs / 1000);
            const ordinal = startOrdinal + index;
            const label = params.generateNames ? formatManualGeneratorLabel(nameMask, ordinal) : '';
            segments.push({
                label,
                startSeconds,
                endSeconds,
                hasExplicitEnd: true,
                source: 'manual'
            });
        }
        return segments;
    }

    function applyManualGeneratorSegments(segments, mode) {
        if (!Array.isArray(segments) || !segments.length) {
            return false;
        }
        const normalizedMode = mode === 'append' ? 'append' : 'replace';
        if (normalizedMode === 'replace') {
            projectManualUiState.draftSegments = [];
            projectManualUiState.nextOrderToken = 1;
        }
        const target = projectManualUiState.draftSegments;
        segments.forEach(segment => {
            const startSeconds = sanitizeManualSegmentSeconds(segment && segment.startSeconds);
            const endSecondsRaw = Number(segment && segment.endSeconds);
            const endSeconds = Number.isFinite(endSecondsRaw)
                ? sanitizeManualSegmentSeconds(Math.max(endSecondsRaw, startSeconds))
                : startSeconds;
            target.push({
                uid: null,
                label: segment && typeof segment.label === 'string' ? segment.label : '',
                startSeconds,
                endSeconds,
                hasExplicitEnd: segment && segment.hasExplicitEnd === true,
                source: 'manual',
                ordinal: target.length,
                __orderToken: projectManualUiState.nextOrderToken++
            });
        });
        sortManualDraftSegments();
        projectManualUiState.editing = null;
        updateManualDraftDirtyState();
        renderProjectManualTable();
        return true;
    }

    function collectManualGeneratorParameters(mode) {
        const normalizedMode = mode === 'append' ? 'append' : 'replace';
        const existingSegments = projectManualUiState.draftSegments.slice();
        const fail = (field, message) => {
            if (field && field.length) {
                markManualGeneratorFieldValidity(field, false, message);
            }
            return { ok: false, errorMessage: message, invalidField: field };
        };

        let durationSeconds = NaN;
        const durationInputAvailable = projectManualDurationValue && projectManualDurationValue.length;
        let durationUnit = projectManualDurationUnit && projectManualDurationUnit.length ? (projectManualDurationUnit.val() || 'minutes') : 'minutes';
        let durationRaw = durationInputAvailable ? projectManualDurationValue.val() : '';
        if (durationRaw === '' || durationRaw === null) {
            const fallbackMinutes = getManualDefaultDurationMinutesSetting();
            durationRaw = fallbackMinutes;
            if (durationInputAvailable) {
                projectManualDurationValue.val(fallbackMinutes);
                projectManualDurationValue.data('manual-generator-edited', false);
                if (projectManualDurationUnit && projectManualDurationUnit.length) {
                    projectManualDurationUnit.val('minutes');
                    projectManualDurationUnit.data('previous-unit', 'minutes');
                    durationUnit = 'minutes';
                }
            }
        }
        const durationNumeric = Number(durationRaw);
        if (!Number.isFinite(durationNumeric) || durationNumeric <= 0) {
            return fail(projectManualDurationValue, 'Укажите положительную длительность сегмента.');
        }
        const multiplier = durationUnit === 'hours' ? 3600 : 60;
        durationSeconds = sanitizeManualSegmentSeconds(durationNumeric * multiplier);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
            return fail(projectManualDurationValue, 'Некорректная длительность сегмента.');
        }
        markManualGeneratorFieldValidity(projectManualDurationValue, true);

        let startSeconds = null;
        if (projectManualStartTimeInput && projectManualStartTimeInput.length) {
            const rawStart = (projectManualStartTimeInput.val() || '').toString().trim();
            if (rawStart) {
                const parsed = parseManualSegmentTimeInput(rawStart);
                if (parsed === null) {
                    return fail(projectManualStartTimeInput, 'Введите время в формате 00:00:00.000 или секунды.');
                }
                startSeconds = sanitizeManualSegmentSeconds(parsed);
                projectManualStartTimeInput.val(formatManualSegmentStartSeconds(startSeconds, 3));
            }
            markManualGeneratorFieldValidity(projectManualStartTimeInput, true);
        }
        if (startSeconds === null) {
            if (normalizedMode === 'append' && existingSegments.length) {
                const lastSegment = existingSegments[existingSegments.length - 1];
                const lastStart = lastSegment ? sanitizeManualSegmentSeconds(lastSegment.startSeconds) : 0;
                const explicitEnd = lastSegment && lastSegment.hasExplicitEnd === true && Number.isFinite(lastSegment.endSeconds)
                    ? sanitizeManualSegmentSeconds(Math.max(lastSegment.endSeconds, lastStart))
                    : null;
                startSeconds = explicitEnd !== null ? explicitEnd : sanitizeManualSegmentSeconds(lastStart + durationSeconds);
            } else {
                startSeconds = 0;
            }
            if (projectManualStartTimeInput && projectManualStartTimeInput.length) {
                projectManualStartTimeInput.val(formatManualSegmentStartSeconds(startSeconds, 3));
            }
        }

        let startIndex = 1;
        if (projectManualStartIndexInput && projectManualStartIndexInput.length) {
            const rawIndex = projectManualStartIndexInput.val();
            const numericIndex = Number(rawIndex);
            if (Number.isFinite(numericIndex) && numericIndex > 0) {
                startIndex = Math.max(1, Math.round(numericIndex));
            } else {
                startIndex = normalizedMode === 'append'
                    ? Math.max(1, existingSegments.length + 1)
                    : 1;
            }
            projectManualStartIndexInput.val(startIndex);
            markManualGeneratorFieldValidity(projectManualStartIndexInput, true);
        } else if (normalizedMode === 'append' && existingSegments.length) {
            startIndex = existingSegments.length + 1;
        }

        let count = NaN;
        let timelineEndSeconds = null;
        if (projectManualCountInput && projectManualCountInput.length) {
            const rawCount = projectManualCountInput.val();
            const numericCount = Number(rawCount);
            if (Number.isFinite(numericCount) && numericCount > 0) {
                count = Math.floor(numericCount);
            }
        }
        if (!Number.isFinite(count) || count <= 0) {
            const derived = deriveManualGeneratorCount({
                mode: normalizedMode,
                existingSegments,
                startSeconds,
                durationSeconds
            });
            count = derived.count;
            timelineEndSeconds = derived.timelineEndSeconds;
            if (projectManualCountInput && projectManualCountInput.length && Number.isFinite(count) && count > 0) {
                projectManualCountInput.val(count);
            }
        }
        if (!Number.isFinite(count) || count <= 0) {
            return fail(projectManualCountInput, 'Укажите количество сегментов.');
        }
        if (count > MANUAL_GENERATOR_MAX_SEGMENTS) {
            return fail(projectManualCountInput, `Максимум ${MANUAL_GENERATOR_MAX_SEGMENTS} сегментов за один раз.`);
        }
        if (projectManualCountInput && projectManualCountInput.length) {
            markManualGeneratorFieldValidity(projectManualCountInput, true);
        }

        const generateNames = !projectManualGenerateNamesToggle.length || projectManualGenerateNamesToggle.is(':checked');
        let nameMask = '';
        if (generateNames) {
            nameMask = projectManualNameMaskInput && projectManualNameMaskInput.length
                ? (projectManualNameMaskInput.val() || '').toString().trim()
                : '';
            if (!nameMask) {
                nameMask = 'Сегмент $N';
                if (projectManualNameMaskInput && projectManualNameMaskInput.length) {
                    projectManualNameMaskInput.val(nameMask);
                }
            }
        }

        return {
            ok: true,
            data: {
                mode: normalizedMode,
                startSeconds,
                durationSeconds,
                count,
                startIndex,
                generateNames,
                nameMask,
                timelineEndSeconds
            }
        };
    }

    function runManualGenerator(mode) {
        const normalizedMode = mode === 'append' ? 'append' : 'replace';
        clearManualGeneratorValidation();
        setProjectManualGeneratorMessage(null, '');
        const paramsResult = collectManualGeneratorParameters(normalizedMode);
        if (!paramsResult || paramsResult.ok !== true) {
            const message = paramsResult && paramsResult.errorMessage ? paramsResult.errorMessage : 'Не удалось подготовить параметры генератора.';
            setProjectManualGeneratorMessage('error', message);
            if (paramsResult && paramsResult.invalidField && paramsResult.invalidField.length) {
                paramsResult.invalidField.trigger('focus');
            }
            return false;
        }
        const params = paramsResult.data;
        const segments = buildManualGeneratorSegments({
            startSeconds: params.startSeconds,
            durationSeconds: params.durationSeconds,
            count: params.count,
            startIndex: params.startIndex,
            generateNames: params.generateNames,
            nameMask: params.nameMask,
            timelineEndSeconds: params.timelineEndSeconds
        });
        if (!segments.length) {
            setProjectManualGeneratorMessage('error', 'Генератор не создал ни одного сегмента.');
            return false;
        }
        const hadSegments = projectManualUiState.draftSegments.length > 0;
        const applied = applyManualGeneratorSegments(segments, normalizedMode);
        if (!applied) {
            setProjectManualGeneratorMessage('error', 'Не удалось применить сгенерированные сегменты.');
            return false;
        }
        let successText;
        if (normalizedMode === 'append') {
            successText = `Добавлено ${segments.length} сегмент(ов). Не забудьте сохранить изменения.`;
        } else if (hadSegments) {
            successText = `Список заменён ${segments.length} сегментами. Не забудьте сохранить изменения.`;
        } else {
            successText = `Создано ${segments.length} сегмент(ов). Не забудьте сохранить изменения.`;
        }
        setProjectManualGeneratorMessage('success', successText);
        return true;
    }

    function updateProjectManualUiControls() {
        const hasSegments = projectManualUiState.draftSegments.length > 0;
        if (projectManualEmptyState && projectManualEmptyState.length) {
            projectManualEmptyState.toggle(!hasSegments);
        }
        if (projectManualCurrentSection && projectManualCurrentSection.length) {
            projectManualCurrentSection.toggleClass('project-manual-has-entries', hasSegments);
        }
        if (projectManualSaveButton && projectManualSaveButton.length) {
            projectManualSaveButton.prop('disabled', !projectManualUiState.dirty);
        }
        if (projectManualClearButton && projectManualClearButton.length) {
            projectManualClearButton.prop('disabled', !hasSegments);
        }
        if (projectManualResetButton && projectManualResetButton.length) {
            const shouldShowReset = projectManualUiState.dirty;
            projectManualResetButton.prop('disabled', !shouldShowReset);
            projectManualResetButton.toggle(shouldShowReset);
        }
        updateProjectManualGeneratorButtons(hasSegments);
    }

    function focusManualEditor() {
        const editing = projectManualUiState.editing;
        if (!editing || !editing.segmentId || !editing.field || !editing.focusPending) {
            return;
        }
        const selector = `.project-manual-editor[data-segment-id="${editing.segmentId}"][data-field="${editing.field}"]`;
        const inputEl = projectManualTableBody && projectManualTableBody.length ? projectManualTableBody.find(selector).first() : null;
        if (!inputEl || !inputEl.length) {
            return;
        }
        editing.focusPending = false;
        const focusFn = () => {
            inputEl.trigger('focus');
            const domNode = inputEl.get(0);
            if (domNode && typeof domNode.setSelectionRange === 'function') {
                const value = inputEl.val();
                const length = typeof value === 'string' ? value.length : 0;
                domNode.setSelectionRange(0, length);
            }
        };
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => window.requestAnimationFrame(focusFn));
        } else {
            setTimeout(focusFn, 0);
        }
    }

    function renderProjectManualTable() {
        if (!projectManualTableBody || !projectManualTableBody.length) {
            updateProjectManualUiControls();
            return;
        }
        projectManualTableBody.empty();
        const editing = projectManualUiState.editing;
        projectManualUiState.draftSegments.forEach((segment, index) => {
            const segmentId = getManualSegmentDomId(segment);
            const row = $('<tr>').attr('data-segment-id', segmentId);
            if (editing && editing.segmentId === segmentId) {
                row.addClass('project-manual-table-row-editing');
            }
            row.append(
                $('<td>').addClass('project-manual-col-ordinal').text(index + 1)
            );

            const nameCell = $('<td>');
            if (editing && editing.segmentId === segmentId && editing.field === 'label') {
                const input = $('<input type="text" class="project-manual-editor project-manual-editor-label" autocomplete="off">')
                    .attr('data-segment-id', segmentId)
                    .attr('data-field', 'label')
                    .val(segment.label || '');
                nameCell.append(input);
            } else {
                const button = $('<button type="button" class="project-manual-editable">')
                    .attr('data-segment-id', segmentId)
                    .attr('data-field', 'label')
                    .attr('title', 'Редактировать название')
                    .text(getManualSegmentDisplayName(segment, index));
                nameCell.append(button);
            }
            row.append(nameCell);

            const timeCell = $('<td>').addClass('project-manual-col-time');
            const formattedTime = formatManualSegmentStartSeconds(segment.startSeconds, 3);
            if (editing && editing.segmentId === segmentId && editing.field === 'startSeconds') {
                const input = $('<input type="text" class="project-manual-editor project-manual-editor-time" inputmode="decimal" autocomplete="off">')
                    .attr('data-segment-id', segmentId)
                    .attr('data-field', 'startSeconds')
                    .attr('placeholder', '00:00:00.000')
                    .val(formattedTime);
                timeCell.append(input);
            } else {
                const button = $('<button type="button" class="project-manual-editable">')
                    .attr('data-segment-id', segmentId)
                    .attr('data-field', 'startSeconds')
                    .attr('title', 'Редактировать время начала')
                    .text(formattedTime);
                timeCell.append(button);
            }
            row.append(timeCell);

            const deleteCell = $('<td>').addClass('project-manual-actions-col');
            const deleteButton = $('<button type="button" class="project-manual-delete-button" aria-label="Удалить сегмент" title="Удалить сегмент">')
                .attr('data-segment-id', segmentId)
                .append('<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><use href="icons.svg#icon-role-reset" xlink:href="icons.svg#icon-role-reset"></use></svg>');
            deleteCell.append(deleteButton);
            row.append(deleteCell);

            projectManualTableBody.append(row);
        });
        updateProjectManualUiControls();
        focusManualEditor();
    }

    function syncProjectManualDraftFromRuntime(event = {}) {
        const runtimeVersion = manualSegmentationState.version;
        const reason = event && event.reason ? String(event.reason) : '';
        const allowOverride = reason === 'manual_segments_save';
        if (!event.force && !allowOverride && projectManualUiState.dirty && runtimeVersion !== projectManualUiState.lastRuntimeVersion) {
            return;
        }
        const runtimeSegments = getManualSegmentationSegments();
        projectManualUiState.draftSegments = runtimeSegments.map((segment, index) => {
            const sanitizedStart = sanitizeManualSegmentSeconds(segment && segment.startSeconds);
            const explicitEnd = segment && segment.hasExplicitEnd === true;
            let sanitizedEnd = null;
            if (explicitEnd && Number.isFinite(segment && segment.endSeconds)) {
                sanitizedEnd = sanitizeManualSegmentSeconds(Math.max(segment.endSeconds, sanitizedStart));
            }
            const clone = {
                uid: segment && typeof segment.uid === 'string' ? segment.uid : null,
                label: segment && typeof segment.label === 'string' ? segment.label : '',
                startSeconds: sanitizedStart,
                endSeconds: sanitizedEnd,
                hasExplicitEnd: explicitEnd,
                source: segment && segment.source ? segment.source : 'manual',
                ordinal: index,
                __orderToken: index + 1
            };
            if (!clone.uid) {
                clone.__draftId = `draft:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
            }
            return clone;
        });
        projectManualUiState.nextOrderToken = projectManualUiState.draftSegments.length + 1;
        sortManualDraftSegments();
        projectManualUiState.lastRuntimeVersion = runtimeVersion;
        projectManualUiState.lastSavedHash = computeManualSegmentsHash(runtimeSegments);
        projectManualUiState.editing = null;
        updateManualDraftDirtyState();
        renderProjectManualTable();
        setProjectManualGeneratorMessage(null, '');
        clearManualGeneratorValidation();
    }

    function beginManualSegmentEdit(segmentId, field) {
        if (!segmentId || !field) return;
        const segment = findManualDraftSegment(segmentId);
        if (!segment) return;
        const current = projectManualUiState.editing;
        if (current && current.segmentId === segmentId && current.field === field) {
            return;
        }
        projectManualUiState.editing = { segmentId, field, focusPending: true };
        renderProjectManualTable();
    }

    function finalizeManualSegmentEdit(inputEl, options = {}) {
        if (!inputEl || !inputEl.length) return;
        const segmentId = inputEl.data('segmentId');
        const field = inputEl.data('field');
        const editing = projectManualUiState.editing;
        if (!editing || editing.segmentId !== segmentId || editing.field !== field) {
            return;
        }
        const segment = findManualDraftSegment(segmentId);
        if (!segment) {
            projectManualUiState.editing = null;
            renderProjectManualTable();
            return;
        }
        const rawValue = inputEl.val();
        if (field === 'label') {
            const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
            if (trimmed !== segment.label) {
                segment.label = trimmed;
                sortManualDraftSegments();
                updateManualDraftDirtyState();
            }
            projectManualUiState.editing = null;
            renderProjectManualTable();
            return;
        }
        if (field === 'startSeconds') {
            const parsed = typeof rawValue === 'string' ? parseManualSegmentTimeInput(rawValue) : null;
            if (parsed === null) {
                inputEl.addClass('project-manual-editor-invalid');
                if (options && options.focusOnError !== false) {
                    setTimeout(() => inputEl.trigger('focus'), 0);
                }
                return;
            }
            inputEl.removeClass('project-manual-editor-invalid');
            const sanitized = sanitizeManualSegmentSeconds(parsed);
            if (!manualSegmentTimesEqual(segment.startSeconds, sanitized)) {
                segment.startSeconds = sanitized;
                if (segment.hasExplicitEnd === true && Number.isFinite(segment.endSeconds) && segment.endSeconds < sanitized) {
                    segment.endSeconds = sanitized;
                }
                sortManualDraftSegments();
                updateManualDraftDirtyState();
            }
            projectManualUiState.editing = null;
            renderProjectManualTable();
        }
    }

    function cancelManualSegmentEdit() {
        if (!projectManualUiState.editing) {
            return;
        }
        projectManualUiState.editing = null;
        renderProjectManualTable();
    }

    function addManualSegment() {
        const segments = projectManualUiState.draftSegments;
        const lastSegment = segments.length ? segments[segments.length - 1] : null;
        const intervalSeconds = getManualDefaultDurationSeconds();
        const defaultStart = lastSegment ? sanitizeManualSegmentSeconds(lastSegment.startSeconds + intervalSeconds) : 0;
        const newSegment = {
            uid: null,
            label: '',
            startSeconds: defaultStart,
            endSeconds: null,
            hasExplicitEnd: false,
            source: 'manual',
            ordinal: segments.length,
            __orderToken: projectManualUiState.nextOrderToken++
        };
        newSegment.__draftId = `draft:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        segments.push(newSegment);
        sortManualDraftSegments();
        updateManualDraftDirtyState();
        projectManualUiState.editing = { segmentId: getManualSegmentDomId(newSegment), field: 'label', focusPending: true };
        renderProjectManualTable();
    }

    function removeManualSegment(segmentId) {
        if (!segmentId) return;
        const segments = projectManualUiState.draftSegments;
        const index = segments.findIndex(segment => getManualSegmentDomId(segment) === segmentId);
        if (index === -1) return;
        segments.splice(index, 1);
        projectManualUiState.editing = null;
        sortManualDraftSegments();
        updateManualDraftDirtyState();
        renderProjectManualTable();
    }

    function clearManualDraftSegments() {
        if (!projectManualUiState.draftSegments.length) {
            return;
        }
        projectManualUiState.draftSegments.length = 0;
        projectManualUiState.nextOrderToken = 1;
        projectManualUiState.editing = null;
        updateManualDraftDirtyState();
        renderProjectManualTable();
        setProjectManualGeneratorMessage(null, '');
    }

    function commitProjectManualSegments() {
        if (!projectManualUiState.dirty) {
            return;
        }
        const payload = projectManualUiState.draftSegments.map(segment => ({
            label: segment.label || '',
            startSeconds: sanitizeManualSegmentSeconds(segment.startSeconds),
            endSeconds: segment && segment.hasExplicitEnd === true && Number.isFinite(segment.endSeconds)
                ? sanitizeManualSegmentSeconds(Math.max(segment.endSeconds, segment.startSeconds))
                : null
        }));
        setManualSegmentationSegments(payload, { reason: 'manual_segments_save' });
        saveRoles('manual_segments_save');
    }

    if (projectManualTableBody && projectManualTableBody.length) {
        projectManualTableBody.on('click', '.project-manual-editable', function(event) {
            event.preventDefault();
            const segmentId = $(this).data('segmentId');
            const field = $(this).data('field');
            beginManualSegmentEdit(segmentId, field);
        });
        projectManualTableBody.on('keydown', '.project-manual-editor', function(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                finalizeManualSegmentEdit($(this));
            } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelManualSegmentEdit();
            }
        });
        projectManualTableBody.on('blur', '.project-manual-editor', function() {
            finalizeManualSegmentEdit($(this), { focusOnError: true });
        });
        projectManualTableBody.on('click', '.project-manual-delete-button', function(event) {
            event.preventDefault();
            const segmentId = $(this).data('segmentId');
            removeManualSegment(segmentId);
        });
    }

    if (projectManualAddButton && projectManualAddButton.length) {
        projectManualAddButton.on('click', function(event) {
            event.preventDefault();
            addManualSegment();
        });
    }
    if (projectManualSaveButton && projectManualSaveButton.length) {
        projectManualSaveButton.on('click', function(event) {
            event.preventDefault();
            commitProjectManualSegments();
        });
    }
    if (projectManualClearButton && projectManualClearButton.length) {
        projectManualClearButton.on('click', function(event) {
            event.preventDefault();
            clearManualDraftSegments();
        });
    }
    if (projectManualResetButton && projectManualResetButton.length) {
        projectManualResetButton.on('click', function(event) {
            event.preventDefault();
            syncProjectManualDraftFromRuntime({ reason: 'manual_segments_reset', force: true });
        });
    }

    if (projectManualGenerateButton && projectManualGenerateButton.length) {
        projectManualGenerateButton.on('click', function(event) {
            event.preventDefault();
            runManualGenerator('replace');
        });
    }
    if (projectManualAppendButton && projectManualAppendButton.length) {
        projectManualAppendButton.on('click', function(event) {
            event.preventDefault();
            runManualGenerator('append');
        });
    }
    if (projectManualReplaceButton && projectManualReplaceButton.length) {
        projectManualReplaceButton.on('click', function(event) {
            event.preventDefault();
            runManualGenerator('replace');
        });
    }

    [projectManualStartTimeInput, projectManualDurationValue, projectManualStartIndexInput, projectManualCountInput].forEach(input => {
        if (input && input.length) {
            input.on('input change', () => {
                markManualGeneratorFieldValidity(input, true);
                setProjectManualGeneratorMessage(null, '');
            });
        }
    });

    addManualSegmentationListener(syncProjectManualDraftFromRuntime);
    syncProjectManualDraftFromRuntime({ reason: 'initial', force: true });
    $(window).on('unload.manualSegmentation', () => {
        removeManualSegmentationListener(syncProjectManualDraftFromRuntime);
    });

    let projectDataReady = false;
    let projectDataRetryTimer = null;
    let projectDataRetryAttempt = 0;
    const PROJECT_DATA_RETRY_BASE_DELAY_MS = 900;
    const PROJECT_DATA_RETRY_MAX_ATTEMPTS = 3;

    function clearProjectDataRetryTimer() {
        if (projectDataRetryTimer !== null) {
            clearTimeout(projectDataRetryTimer);
            projectDataRetryTimer = null;
        }
    }

    function markProjectDataReady() {
        projectDataReady = true;
        projectDataRetryAttempt = 0;
        clearProjectDataRetryTimer();
    }

    function scheduleProjectDataRetry(reason = 'auto_retry') {
        if (projectDataReady) return;
        if (projectDataRetryAttempt >= PROJECT_DATA_RETRY_MAX_ATTEMPTS) {
            if (statusIndicator && statusIndicator.length) {
                statusIndicator.text('Не удалось автоматически обновить данные проекта. Нажмите "Обновить".');
            }
            return;
        }
        if (projectDataRetryTimer !== null) {
            return;
        }
        const nextAttempt = projectDataRetryAttempt + 1;
        projectDataRetryAttempt = nextAttempt;
        const delayMs = Math.max(300, Math.round(PROJECT_DATA_RETRY_BASE_DELAY_MS * nextAttempt));
        projectDataRetryTimer = setTimeout(() => {
            projectDataRetryTimer = null;
            if (projectDataReady) {
                return;
            }
            if (statusIndicator && statusIndicator.length) {
                const attemptLabel = nextAttempt > 1
                    ? `Повторная попытка синхронизации данных проекта... (${nextAttempt})`
                    : 'Повторная попытка синхронизации данных проекта...';
                statusIndicator.text(attemptLabel);
            }
            getProjectData(`${reason}:attempt${nextAttempt}`, { allowCache: false, forceReload: true })
                .then(() => {
                    markProjectDataReady();
                })
                .catch(err => {
                    console.warn('[Prompter][projectData] retry failed', { reason, attempt: nextAttempt, error: err && err.message });
                    if (projectDataRetryAttempt < PROJECT_DATA_RETRY_MAX_ATTEMPTS) {
                        scheduleProjectDataRetry(reason);
                    } else if (statusIndicator && statusIndicator.length) {
                        statusIndicator.text('Не удалось автоматически обновить данные проекта. Нажмите "Обновить".');
                    }
                });
        }, delayMs);
    }
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
    const debugLogModal = $('#debug-log-modal');
    const debugLogArea = $('#debug-log-area');
    const debugLogEntries = $('#debug-log-entries');
    const debugLogEmpty = $('#debug-log-empty');
    const debugLogClearButton = $('#debug-log-clear');
    const debugLogSaveButton = $('#debug-log-save');
    const debugLogCopyButton = $('#debug-log-copy');
    const saveSettingsButton = $('#save-settings-button');
    const resetSettingsButton = $('#reset-settings-button');
    const actorRoleMappingTextarea = $('#actor-role-mapping-text');
    const actorRoleImportButton = $('#import-actor-role-from-project');
    const actorRoleImportStatus = $('#actor-role-import-status');
    const actorColorList = $('#actor-color-list');
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

    statsModalEl = $('#stats-modal');
    statsSegmentControlsEl = $('#stats-segmentation-controls');
    statsSegmentSelectEl = $('#stats-segment-select');
    statsSegmentSourceEl = $('#stats-segment-source');
    statsRolesSectionEl = $('#stats-roles-section');
    statsActorsSectionEl = $('#stats-actors-section');
    statsColorsSectionEl = $('#stats-colors-section');
    statsEmptyEl = $('#stats-empty');
    statsRolesTableBodyEl = $('#stats-roles-table tbody');
    statsActorsTableBodyEl = $('#stats-actors-table tbody');
    statsColorsTableBodyEl = $('#stats-colors-table tbody');
    statsRolesTotalEl = $('#stats-roles-total');
    statsActorsTotalEl = $('#stats-actors-total');
    statsColorsTotalEl = $('#stats-colors-total');

    if (statsSegmentSelectEl && statsSegmentSelectEl.length) {
        statsSegmentSelectEl.on('change', function() {
            const rawValue = $(this).val();
            const selectedValue = Array.isArray(rawValue) ? rawValue[0] : rawValue;
            const normalizedValue = typeof selectedValue === 'string' ? selectedValue : STATS_SEGMENT_ALL_VALUE;
            statsSegmentSelection = statsSegmentOptionMap.has(normalizedValue) ? normalizedValue : STATS_SEGMENT_ALL_VALUE;
            $(this).val(statsSegmentSelection);
            renderStatsTables({ openModal: false });
            scheduleStatsButtonEvaluation();
        });
    }

    refreshStatsSegmentationControls({ preserveSelection: true, recalcIfVisible: false });

    DebugLogUI.init({
        enabled: DEBUG_LOG_BOOT_ENABLED,
        statusIndicator,
        modal: debugLogModal,
        scrollArea: debugLogArea,
        entriesContainer: debugLogEntries,
        emptyState: debugLogEmpty,
        clearButton: debugLogClearButton,
        saveButton: debugLogSaveButton,
        copyButton: debugLogCopyButton
    });

    if (textDisplay && typeof textDisplay.on === 'function') {
        textDisplay.on('click', '.subtitle-container', onSubtitleContainerClick);
    }

    if (settingsAppVersion.length) {
        settingsAppVersion.text(`${APP_NAME} v${APP_VERSION}`);
    }
    if (mainTitle.length) {
        mainTitle.text(APP_NAME);
    }

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
    const ignoreProjectItemColorsCheckbox = $('#ignore-project-item-colors');
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
    const highlightOverlapTile = $('#highlight-overlap-tile');
    const highlightCurrentOptions = $('#highlight-current-options');
    const highlightPreviousOptions = $('#highlight-previous-options');
    const highlightProgressOptions = $('#highlight-progress-options');
    const highlightOverlapOptions = $('#highlight-overlap-options');
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
    const highlightOverlapEnabledCheckbox = $('#highlight-overlap-enabled');
    const highlightOverlapColorInput = $('#highlight-overlap-color');
    const roleFontColorEnabledCheckbox = $('#role-font-color-enabled');
    const jumpOnClickCheckbox = $('#jump-on-click-enabled');
    const jumpSettingsWrapper = $('#jump-settings-wrapper');
    const jumpPreRollInput = $('#jump-pre-roll-seconds');
    const jumpPreventWhilePlayingCheckbox = $('#jump-prevent-while-playing');
    const jumpPreventWhileRecordingCheckbox = $('#jump-prevent-while-recording');
    const timecodeDisplayFormatSelect = $('#timecode-display-format');
    const segmentationAutodetectTile = $('#segmentation-autodetect-tile');
    const segmentationDisplayTile = $('#segmentation-display-tile');
    const segmentationManualToggle = $('#segmentation-manual-enabled');
    manualDefaultDurationInput = manualDefaultDurationInput && manualDefaultDurationInput.length
        ? manualDefaultDurationInput
        : $('#manual-segment-default-duration-minutes');
    const segmentationModeSelect = $('#segmentation-autodetect-mode');
    const segmentationVideoKeywordsWrapper = $('#segmentation-video-keywords-wrapper');
    const segmentationVideoKeywordsInput = $('#segmentation-auto-video-keywords');
    const segmentationMarkerPatternWrapper = $('#segmentation-marker-pattern-wrapper');
    const segmentationMarkerPatternInput = $('#segmentation-marker-pattern');
    const segmentationPriorityWrapper = $('#segmentation-priority-wrapper');
    const segmentationPrioritySelect = $('#segmentation-autodetect-priority');
    const segmentationDisplayModeSelect = $('#segmentation-display-mode');
    const segmentationAutoSwitchWrapper = $('#segmentation-auto-switch-wrapper');
    const segmentationAutoSwitchSelect = $('#segmentation-auto-switch-mode');

    const updateSegmentationControlsState = (options = {}) => {
        let resolvedMode;
        const hasExplicitFlags = Object.prototype.hasOwnProperty.call(options, 'enabled')
            || Object.prototype.hasOwnProperty.call(options, 'videoEnabled')
            || Object.prototype.hasOwnProperty.call(options, 'markersEnabled');
        if (typeof options.mode === 'string') {
            resolvedMode = sanitizeSegmentationMode(options.mode);
        } else if (hasExplicitFlags) {
            const baseEnabled = Object.prototype.hasOwnProperty.call(options, 'enabled')
                ? !!options.enabled
                : (settings.segmentationEnabled !== false);
            const baseVideo = Object.prototype.hasOwnProperty.call(options, 'videoEnabled')
                ? !!options.videoEnabled
                : (settings.segmentationAutoVideoEnabled !== false);
            const baseMarkers = Object.prototype.hasOwnProperty.call(options, 'markersEnabled')
                ? !!options.markersEnabled
                : (settings.segmentationAutoMarkersEnabled !== false);
            resolvedMode = deriveSegmentationModeFromFlags(baseEnabled, baseVideo, baseMarkers);
        } else if (segmentationModeSelect.length) {
            resolvedMode = sanitizeSegmentationMode(segmentationModeSelect.val());
        } else {
            resolvedMode = deriveSegmentationModeFromFlags(
                settings.segmentationEnabled !== false,
                settings.segmentationAutoVideoEnabled !== false,
                settings.segmentationAutoMarkersEnabled !== false
            );
        }

        const flags = mapSegmentationModeToFlags(resolvedMode);
        const enabled = flags.enabled;
        const videoEnabled = flags.video;
        const markersEnabled = flags.markers;

        if (segmentationModeSelect.length) {
            const currentValue = sanitizeSegmentationMode(segmentationModeSelect.val());
            if (currentValue !== resolvedMode) {
                if (!segmentationModeSelect.find(`option[value="${resolvedMode}"]`).length) {
                    const label = SEGMENTATION_MODE_LABELS[resolvedMode] || resolvedMode;
                    segmentationModeSelect.append($('<option>').val(resolvedMode).text(label));
                }
                segmentationModeSelect.val(resolvedMode);
            }
            segmentationModeSelect.prop('disabled', false);
        }

        const displayMode = typeof options.displayMode === 'string'
            ? sanitizeSegmentationDisplayMode(options.displayMode, defaultSettings.segmentationDisplayMode)
            : (segmentationDisplayModeSelect.length
                ? sanitizeSegmentationDisplayMode(segmentationDisplayModeSelect.val(), defaultSettings.segmentationDisplayMode)
                : defaultSettings.segmentationDisplayMode);

        if (segmentationAutodetectTile.length) {
            segmentationAutodetectTile.toggleClass('is-disabled', false);
        }
        if (segmentationDisplayTile.length) {
            segmentationDisplayTile.toggleClass('is-disabled', false);
        }

        const showVideoKeywords = enabled && videoEnabled;
        if (segmentationVideoKeywordsWrapper.length) {
            segmentationVideoKeywordsWrapper.toggle(showVideoKeywords);
        }
        if (segmentationVideoKeywordsInput.length) {
            segmentationVideoKeywordsInput.prop('disabled', !showVideoKeywords);
        }

        const showMarkerPattern = enabled && markersEnabled;
        if (segmentationMarkerPatternWrapper.length) {
            segmentationMarkerPatternWrapper.toggle(showMarkerPattern);
        }
        if (segmentationMarkerPatternInput.length) {
            segmentationMarkerPatternInput.prop('disabled', !showMarkerPattern);
        }

        const showPriority = enabled && videoEnabled && markersEnabled;
        if (segmentationPriorityWrapper.length) {
            segmentationPriorityWrapper.toggle(showPriority);
        }
        if (segmentationPrioritySelect.length) {
            segmentationPrioritySelect.prop('disabled', !showPriority);
        }

    const showAutoSwitch = displayMode === 'current';
        if (segmentationAutoSwitchWrapper.length) {
            segmentationAutoSwitchWrapper.toggle(showAutoSwitch);
        }
        if (segmentationAutoSwitchSelect.length) {
            segmentationAutoSwitchSelect.prop('disabled', !showAutoSwitch);
        }

        if (segmentationDisplayModeSelect.length) {
            if (Object.prototype.hasOwnProperty.call(options, 'displayMode')) {
                segmentationDisplayModeSelect.val(displayMode);
            }
        }

        scheduleSettingsTileReflow();
    };

    let subtitleData = [];
    let subtitleElements = [];
    let subtitleContentElements = [];
    let subtitleTimeElements = [];
    let subtitleTimeLabelElements = [];
    let subtitleTimeProgressElements = [];
    let subtitlePaintStates = [];
    let subtitleStyleMetadata = [];
    let subtitleFilterStates = [];
    let subtitleOverlapIndicators = [];
    let subtitleOverlapInfo = [];
    let overlapGroups = [];
    let latestOverlapSummary = null;
    let subtitleProgressContainers = [];
    let subtitleProgressBars = [];
    let subtitleProgressValues = [];
    let activeSubtitleProgressIndices = new Set();
    let activeLineIndices = [];
    let activeTimecodeProgressIndices = new Set();
    let timecodeProgressValues = [];
    roleToActor = {};
    let paintGeneration = 0;
    const ANIMATION_VIEWPORT_BUFFER = 6;
    const CONTENT_VISIBILITY_RADIUS = 80;
    let subtitleObserver = null;
    const visibleIndices = new Set();
    let visibilityObserverActive = false;
    const PROGRESS_APPLY_EPSILON = 0.001;
    let initialAutoScrollPending = false;
    const OVERLAP_PROCESS_INITIAL_RANGE = 150;
    const OVERLAP_PROCESS_BUFFER = 40;
    let pendingOverlapRefreshIndices = new Set();
    let overlapRefreshScheduled = false;
    let forcedContentVisibilityIndices = new Set();
    let contentVisibilityUpdateScheduled = false;
    let contentVisibilityUpdatePending = false;
    const supportsContentVisibility = (() => {
        if (typeof document === 'undefined') return false;
        const style = document.documentElement && document.documentElement.style;
        return !!(style && 'contentVisibility' in style);
    })();
    const supportsContainIntrinsicSize = supportsContentVisibility && (() => {
        if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
            return false;
        }
        return CSS.supports('contain-intrinsic-size: auto 1px');
    })();
    let intrinsicSizeCalibrationQueue = [];
    let intrinsicSizeCalibrationScheduled = false;
    const ACTOR_MAPPING_REBUILD_DEBOUNCE_THRESHOLD = 4000;
    const ACTOR_MAPPING_REBUILD_DEBOUNCE_MS = 1000;
    let actorMappingInputTimer = null;
    const postRenderTaskQueue = [];
    let postRenderFlushScheduled = false;
    const POST_RENDER_FALLBACK_DELAY_MS = 16;

    function performActorMappingPreviewRefresh() {
        regenerateActorColorListUI();
        if (subtitleData.length > 0) {
            handleTextResponse(subtitleData);
        } else {
            updateActorRoleImportVisibility();
        }
    }

    function schedulePostRenderTask(task, options = {}) {
        if (typeof task !== 'function') {
            return;
        }
        const label = options && typeof options.label === 'string' ? options.label : '';
        postRenderTaskQueue.push({ task, label });
        if (postRenderFlushScheduled) {
            return;
        }
        postRenderFlushScheduled = true;

        const flush = () => {
            postRenderFlushScheduled = false;
            if (!postRenderTaskQueue.length) {
                return;
            }
            const pending = postRenderTaskQueue.splice(0);
            pending.forEach(entry => {
                if (!entry || typeof entry.task !== 'function') {
                    return;
                }
                try {
                    entry.task();
                } catch (err) {
                    const context = entry.label ? ` [${entry.label}]` : '';
                    console.error(`[Prompter][postRender] task failed${context}`, err);
                }
            });
        };

        const scheduleFlush = () => {
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    if (typeof requestAnimationFrame === 'function') {
                        requestAnimationFrame(flush);
                    } else {
                        setTimeout(flush, POST_RENDER_FALLBACK_DELAY_MS);
                    }
                });
            } else {
                setTimeout(flush, POST_RENDER_FALLBACK_DELAY_MS);
            }
        };

        scheduleFlush();
    }

    function scheduleActorMappingPreview(options = {}) {
        const debounce = options.debounce === true;
        if (actorMappingInputTimer) {
            clearTimeout(actorMappingInputTimer);
            actorMappingInputTimer = null;
        }
        if (debounce) {
            actorMappingInputTimer = setTimeout(() => {
                actorMappingInputTimer = null;
                performActorMappingPreviewRefresh();
            }, ACTOR_MAPPING_REBUILD_DEBOUNCE_MS);
        } else {
            performActorMappingPreviewRefresh();
        }
    }

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
        indexChanged,
        activeIndices
    }) {
        const simultaneousSet = Array.isArray(activeIndices) && activeIndices.length
            ? new Set(activeIndices)
            : null;
        const shouldSkip = (idx) => !!(simultaneousSet && simultaneousSet.has(idx));

        if (!highlightPreviousEnabled) {
            clearPreviousLineHighlight();
            return;
        }

        if (simultaneousSet && lastPreviousLineIndex !== -1 && shouldSkip(lastPreviousLineIndex)) {
            removePreviousLineHighlightAt(lastPreviousLineIndex);
        }

        if (highlightPauseEnabled) {
            if (inPause && newCurrentLineIndex !== -1) {
                if (shouldSkip(newCurrentLineIndex)) {
                    removePreviousLineHighlightAt(newCurrentLineIndex);
                } else {
                    applyPreviousLineHighlight(newCurrentLineIndex);
                }
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
                if (shouldSkip(previousIndex)) {
                    removePreviousLineHighlightAt(previousIndex);
                } else {
                    applyPreviousLineHighlight(previousIndex);
                }
            } else {
                clearPreviousLineHighlight();
            }
            return;
        }

        if (inPause) {
            if (shouldSkip(newCurrentLineIndex)) {
                removePreviousLineHighlightAt(newCurrentLineIndex);
            } else {
                applyPreviousLineHighlight(newCurrentLineIndex);
            }
            return;
        }

        const targetIndex = newCurrentLineIndex - 1;
        if (targetIndex >= 0) {
            if (shouldSkip(targetIndex)) {
                removePreviousLineHighlightAt(targetIndex);
            } else {
                applyPreviousLineHighlight(targetIndex);
            }
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
    const ROLES_AUTOSAVE_DEBOUNCE_MS = 500;
    let rolesAutosaveTimer = null;
    let rolesAutosaveReason = '';
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
        window.PrompterOverlapSummary = () => ({
            info: subtitleOverlapInfo,
            groups: overlapGroups
        });
    }
    // Guards to avoid duplicate loads
    let subtitleLoadInFlight = false;
    let subtitleLoadTrackId = null;
    let subtitlesLoadedOnce = false;
    let currentLineIndex = -1;
    let lastLineLookaheadIndex = -1;
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
    let activeAutoScrollPlan = null;

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
    roleToActor = {}; // role -> actor
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

    const coarsePointerDetected = (() => {
        try {
            return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
        } catch (err) {
            return false;
        }
    })();
    const mobileUserAgentDetected = (() => {
        if (typeof navigator === 'undefined' || !navigator.userAgent) {
            return false;
        }
        const ua = navigator.userAgent;
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    })();
    const isLikelyMobileDevice = coarsePointerDetected || mobileUserAgentDetected;
    if (typeof document !== 'undefined' && document.body) {
        document.body.setAttribute('data-device-profile', isLikelyMobileDevice ? 'mobile' : 'desktop');
    }

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

    function parseColorToRgba(colorStr) {
        if (typeof colorStr !== 'string') return null;
        const input = colorStr.trim();
        if (!input) return null;
        try {
            if (input.startsWith('#')) {
                let hex = input.slice(1);
                if (hex.length === 3) {
                    hex = hex.split('').map(c => c + c).join('');
                }
                if (hex.length === 6) {
                    const r = parseInt(hex.slice(0, 2), 16);
                    const g = parseInt(hex.slice(2, 4), 16);
                    const b = parseInt(hex.slice(4, 6), 16);
                    if ([r, g, b].some(v => Number.isNaN(v))) return null;
                    return { r, g, b, a: 1 };
                }
                if (hex.length === 8) {
                    const r = parseInt(hex.slice(0, 2), 16);
                    const g = parseInt(hex.slice(2, 4), 16);
                    const b = parseInt(hex.slice(4, 6), 16);
                    const a = parseInt(hex.slice(6, 8), 16) / 255;
                    if ([r, g, b, a].some(v => Number.isNaN(v))) return null;
                    return { r, g, b, a };
                }
                return null;
            }
            if (/^rgba?/i.test(input)) {
                const match = input.match(/rgba?\(([^)]+)\)/i);
                if (!match) return null;
                const parts = match[1].split(',').map(part => part.trim());
                if (parts.length < 3) return null;
                const r = clampNumber(parseFloat(parts[0]), 0, 255);
                const g = clampNumber(parseFloat(parts[1]), 0, 255);
                const b = clampNumber(parseFloat(parts[2]), 0, 255);
                const a = parts.length >= 4 ? clampNumber(parseFloat(parts[3]), 0, 1) : 1;
                if ([r, g, b].some(v => Number.isNaN(v))) return null;
                return { r, g, b, a: Number.isNaN(a) ? 1 : a };
            }
        } catch (err) {
            console.warn('[Prompter][color] parseColorToRgba failed', { colorStr, err });
            return null;
        }
        return null;
    }

    function rgbaToCss(rgba) {
        if (!rgba) return '';
        const r = clampNumber(Math.round(Number.isFinite(rgba.r) ? rgba.r : 0), 0, 255);
        const g = clampNumber(Math.round(Number.isFinite(rgba.g) ? rgba.g : 0), 0, 255);
        const b = clampNumber(Math.round(Number.isFinite(rgba.b) ? rgba.b : 0), 0, 255);
        const a = Number.isFinite(rgba.a) ? clampNumber(rgba.a, 0, 1) : 1;
        return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
    }

    function deriveOverlapColorVariants(colorCandidate) {
        const fallback = defaultSettings.highlightOverlapColor || 'rgba(255, 112, 67, 0.75)';
        let parsed = parseColorToRgba(colorCandidate);
        if (!parsed) {
            parsed = parseColorToRgba(fallback);
        }
        if (!parsed) {
            parsed = { r: 255, g: 112, b: 67, a: 0.75 };
        }
        const baseAlpha = Number.isFinite(parsed.a) ? clampNumber(parsed.a, 0, 1) : 1;
        const source = rgbaToCss({ ...parsed, a: baseAlpha });
        const outline = rgbaToCss({ ...parsed, a: clampNumber(baseAlpha * 0.55, 0.2, 1) });
        const stripe = rgbaToCss({ ...parsed, a: clampNumber(baseAlpha * 0.9, 0.3, 1) });
        return { source, outline, stripe };
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
                    if (actor && color) {
                        const actorKey = actor.toUpperCase();
                        if (actorKey) normalized[actorKey] = color;
                    }
                } else if (typeof entry === 'object') {
                    const actor = String(entry.actor || entry.name || '').trim();
                    const color = String(entry.color || entry.value || '').trim();
                    if (actor && color) {
                        const actorKey = actor.toUpperCase();
                        if (actorKey) normalized[actorKey] = color;
                    }
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
                    const actorKey = actor.toUpperCase();
                    if (actorKey) normalized[actorKey] = color.trim();
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
        const ignoreProjectColors = coerceFlag(base.ignoreProjectItemColors, defaultSettings.ignoreProjectItemColors);
        if (ignoreProjectColors !== base.ignoreProjectItemColors) {
            base.ignoreProjectItemColors = ignoreProjectColors;
            changed = true;
        } else {
            base.ignoreProjectItemColors = ignoreProjectColors;
        }
        const segmentationEnabled = coerceFlag(base.segmentationEnabled, defaultSettings.segmentationEnabled);
        if (segmentationEnabled !== base.segmentationEnabled) {
            base.segmentationEnabled = segmentationEnabled;
            changed = true;
        } else {
            base.segmentationEnabled = segmentationEnabled;
        }
        const segmentationAutoVideoEnabled = coerceFlag(base.segmentationAutoVideoEnabled, defaultSettings.segmentationAutoVideoEnabled);
        if (segmentationAutoVideoEnabled !== base.segmentationAutoVideoEnabled) {
            base.segmentationAutoVideoEnabled = segmentationAutoVideoEnabled;
            changed = true;
        } else {
            base.segmentationAutoVideoEnabled = segmentationAutoVideoEnabled;
        }
        const segmentationAutoMarkersEnabled = coerceFlag(base.segmentationAutoMarkersEnabled, defaultSettings.segmentationAutoMarkersEnabled);
        if (segmentationAutoMarkersEnabled !== base.segmentationAutoMarkersEnabled) {
            base.segmentationAutoMarkersEnabled = segmentationAutoMarkersEnabled;
            changed = true;
        } else {
            base.segmentationAutoMarkersEnabled = segmentationAutoMarkersEnabled;
        }
        const segmentationManualEnabled = coerceFlag(base.segmentationManualEnabled, defaultSettings.segmentationManualEnabled);
        if (segmentationManualEnabled !== base.segmentationManualEnabled) {
            base.segmentationManualEnabled = segmentationManualEnabled;
            changed = true;
        } else {
            base.segmentationManualEnabled = segmentationManualEnabled;
        }
        const sanitizedManualDefaultDuration = sanitizeManualDefaultDurationMinutes(
            base.manualSegmentDefaultDurationMinutes,
            defaultSettings.manualSegmentDefaultDurationMinutes
        );
        if (sanitizedManualDefaultDuration !== base.manualSegmentDefaultDurationMinutes) {
            base.manualSegmentDefaultDurationMinutes = sanitizedManualDefaultDuration;
            changed = true;
        }
        const sanitizedSegmentationKeywords = sanitizeSegmentationKeywordList(
            base.segmentationAutoVideoKeywords,
            defaultSettings.segmentationAutoVideoKeywords
        );
        if (sanitizedSegmentationKeywords !== base.segmentationAutoVideoKeywords) {
            base.segmentationAutoVideoKeywords = sanitizedSegmentationKeywords;
            changed = true;
        }
        const sanitizedMarkerPattern = sanitizeSegmentationKeywordList(
            base.segmentationMarkerPattern,
            defaultSettings.segmentationMarkerPattern,
            { allowEmpty: true }
        );
        if (sanitizedMarkerPattern !== base.segmentationMarkerPattern) {
            base.segmentationMarkerPattern = sanitizedMarkerPattern;
            changed = true;
        }
        const sanitizedSegmentationPriority = sanitizeSegmentationPriority(
            base.segmentationAutodetectPriority,
            defaultSettings.segmentationAutodetectPriority
        );
        if (sanitizedSegmentationPriority !== base.segmentationAutodetectPriority) {
            base.segmentationAutodetectPriority = sanitizedSegmentationPriority;
            changed = true;
        }
        const sanitizedSegmentationDisplayMode = sanitizeSegmentationDisplayMode(
            base.segmentationDisplayMode,
            defaultSettings.segmentationDisplayMode
        );
        if (sanitizedSegmentationDisplayMode !== base.segmentationDisplayMode) {
            base.segmentationDisplayMode = sanitizedSegmentationDisplayMode;
            changed = true;
        }
        const sanitizedSegmentationAutoSwitch = sanitizeSegmentationAutoSwitchMode(
            base.segmentationAutoSwitchMode,
            defaultSettings.segmentationAutoSwitchMode
        );
        if (sanitizedSegmentationAutoSwitch !== base.segmentationAutoSwitchMode) {
            base.segmentationAutoSwitchMode = sanitizedSegmentationAutoSwitch;
            changed = true;
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

    function ensureOverlapScratchCapacity(required) {
        const size = Number(required) | 0;
        if (size <= 0) {
            return overlapScratchStore;
        }
        let capacity = overlapScratchStore.capacity;
        if (!capacity || capacity < size) {
            capacity = Math.max(OVERLAP_SCRATCH_MIN_CAPACITY, capacity || OVERLAP_SCRATCH_MIN_CAPACITY);
            while (capacity < size) {
                capacity *= 2;
            }
            overlapScratchStore.startMs = new Int32Array(capacity);
            overlapScratchStore.endMs = new Int32Array(capacity);
            overlapScratchStore.parent = new Int32Array(capacity);
            overlapScratchStore.unionSize = new Int32Array(capacity);
            overlapScratchStore.overlapCount = new Int32Array(capacity);
            overlapScratchStore.capacity = capacity;
        }
        return overlapScratchStore;
    }

    function overlapFindRoot(parent, index) {
        let node = index;
        while (parent[node] !== node) {
            parent[node] = parent[parent[node]];
            node = parent[node];
        }
        return node;
    }

    function overlapUnionRoots(parent, sizes, a, b) {
        let rootA = overlapFindRoot(parent, a);
        let rootB = overlapFindRoot(parent, b);
        if (rootA === rootB) {
            return false;
        }
        if (sizes[rootA] < sizes[rootB]) {
            const tmp = rootA;
            rootA = rootB;
            rootB = tmp;
        }
        parent[rootB] = rootA;
        sizes[rootA] += sizes[rootB];
        return true;
    }

    function buildOverlapAnalysis(lines) {
        const total = Array.isArray(lines) ? lines.length : 0;
        if (!total) {
            return {
                lineInfo: [],
                groups: [],
                summary: {
                    totalGroups: 0,
                    totalLines: 0,
                    affectedLines: 0,
                    maxGroupSize: 0,
                    maxOverlapDegree: 0,
                    peakSimultaneous: 0,
                    overlapPairs: 0,
                    computeDurationMs: 0
                }
            };
        }

        const startStamp = typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();

        const scratch = ensureOverlapScratchCapacity(total);
        const startMs = scratch.startMs;
        const endMs = scratch.endMs;
        const parent = scratch.parent;
        const sizes = scratch.unionSize;
        const overlapCount = scratch.overlapCount;
        const order = scratch.order;
        const active = scratch.active;

        order.length = total;
        active.length = 0;

        for (let i = 0; i < total; i += 1) {
            const line = lines[i] || {};
            const rawStart = Number(line.start_time);
            const rawEnd = Number(line.end_time);
            const sanitizedStart = Number.isFinite(rawStart)
                ? Math.max(0, Math.round(rawStart * 1000))
                : Math.max(0, i * OVERLAP_EPSILON_MS);
            let sanitizedEnd = Number.isFinite(rawEnd)
                ? Math.max(0, Math.round(rawEnd * 1000))
                : sanitizedStart;
            if (sanitizedEnd < sanitizedStart) {
                sanitizedEnd = sanitizedStart;
            }
            if ((sanitizedEnd - sanitizedStart) < OVERLAP_EPSILON_MS) {
                sanitizedEnd = sanitizedStart + OVERLAP_EPSILON_MS;
            }
            startMs[i] = sanitizedStart;
            endMs[i] = sanitizedEnd;
            parent[i] = i;
            sizes[i] = 1;
            overlapCount[i] = 0;
            order[i] = i;
        }

        order.sort((a, b) => {
            const delta = startMs[a] - startMs[b];
            return delta !== 0 ? delta : a - b;
        });

        let activeCount = 0;
        let peakSimultaneous = 0;
        let overlapPairs = 0;

        for (let idx = 0; idx < total; idx += 1) {
            const lineIndex = order[idx];
            const currentStart = startMs[lineIndex];
            const expireThreshold = currentStart + OVERLAP_EPSILON_MS;

            let writePtr = 0;
            for (let readPtr = 0; readPtr < activeCount; readPtr += 1) {
                const activeIndex = active[readPtr];
                if (endMs[activeIndex] <= expireThreshold) {
                    continue;
                }
                active[writePtr] = activeIndex;
                writePtr += 1;
            }
            activeCount = writePtr;

            for (let j = 0; j < activeCount; j += 1) {
                const otherIndex = active[j];
                overlapCount[lineIndex] += 1;
                overlapCount[otherIndex] += 1;
                overlapUnionRoots(parent, sizes, lineIndex, otherIndex);
                overlapPairs += 1;
            }

            active[activeCount] = lineIndex;
            activeCount += 1;
            if (activeCount > 1 && activeCount > peakSimultaneous) {
                peakSimultaneous = activeCount;
            }
        }

        const groupsMap = new Map();
        let affectedLines = 0;
        let maxGroupSize = 0;
        let maxOverlapDegree = 0;

        for (let i = 0; i < total; i += 1) {
            const degree = overlapCount[i];
            if (degree <= 0) {
                continue;
            }
            affectedLines += 1;
            if (degree > maxOverlapDegree) {
                maxOverlapDegree = degree;
            }
            const root = overlapFindRoot(parent, i);
            let group = groupsMap.get(root);
            if (!group) {
                group = {
                    indices: [],
                    minStart: startMs[i],
                    maxEnd: endMs[i],
                    maxDegree: degree
                };
                groupsMap.set(root, group);
            } else {
                if (startMs[i] < group.minStart) {
                    group.minStart = startMs[i];
                }
                if (endMs[i] > group.maxEnd) {
                    group.maxEnd = endMs[i];
                }
                if (degree > group.maxDegree) {
                    group.maxDegree = degree;
                }
            }
            group.indices.push(i);
            if (group.indices.length > maxGroupSize) {
                maxGroupSize = group.indices.length;
            }
        }

        const lineInfo = new Array(total).fill(null);
        const groups = [];
        let groupIdCounter = 0;

        groupsMap.forEach(group => {
            if (!group.indices || group.indices.length <= 1) {
                return;
            }
            const sorted = group.indices.slice().sort((a, b) => {
                const diff = startMs[a] - startMs[b];
                return diff !== 0 ? diff : a - b;
            });
            const groupId = groupIdCounter;
            groupIdCounter += 1;
            const groupSize = sorted.length;
            const minStart = group.minStart;
            const maxEnd = group.maxEnd;
            const groupMaxDegree = group.maxDegree;

            for (let orderIdx = 0; orderIdx < groupSize; orderIdx += 1) {
                const lineIdx = sorted[orderIdx];
                lineInfo[lineIdx] = {
                    groupId,
                    groupSize,
                    overlapCount: overlapCount[lineIdx],
                    startMs: startMs[lineIdx],
                    endMs: endMs[lineIdx],
                    minGroupStartMs: minStart,
                    maxGroupEndMs: maxEnd,
                    isStart: orderIdx === 0,
                    isEnd: orderIdx === (groupSize - 1),
                    order: orderIdx,
                    maxDegreeInGroup: groupMaxDegree
                };
            }

            groups.push({
                id: groupId,
                indices: sorted,
                size: groupSize,
                minStartMs: minStart,
                maxEndMs: maxEnd,
                maxDegree: groupMaxDegree
            });
        });

        const computeDurationMs = Math.round(((typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now()) - startStamp);

        return {
            lineInfo,
            groups,
            summary: {
                totalGroups: groups.length,
                totalLines: total,
                affectedLines,
                maxGroupSize,
                maxOverlapDegree,
                peakSimultaneous,
                overlapPairs,
                computeDurationMs
            }
        };
    }

    function resolveOverlapProcessingIndices(baseIndices) {
        const total = Array.isArray(subtitleElements) ? subtitleElements.length : 0;
        if (!total) return [];
        const resultSet = new Set();
        if (Array.isArray(baseIndices)) {
            baseIndices.forEach(idx => {
                if (Number.isInteger(idx) && idx >= 0 && idx < total) {
                    resultSet.add(idx);
                }
            });
        }
        const hasVisibleRange = Number.isInteger(visibleRangeStart) && Number.isInteger(visibleRangeEnd)
            && visibleRangeEnd >= visibleRangeStart && visibleRangeStart >= 0;
        if (hasVisibleRange) {
            const rangeStart = Math.max(0, visibleRangeStart - OVERLAP_PROCESS_BUFFER);
            const rangeEnd = Math.min(total - 1, visibleRangeEnd + OVERLAP_PROCESS_BUFFER);
            for (let i = rangeStart; i <= rangeEnd; i += 1) {
                resultSet.add(i);
            }
        }
        if (!resultSet.size) {
            const fallbackEnd = Math.min(total - 1, OVERLAP_PROCESS_INITIAL_RANGE);
            for (let i = 0; i <= fallbackEnd; i += 1) {
                resultSet.add(i);
            }
        }
        return Array.from(resultSet).sort((a, b) => a - b);
    }

    function clearOverlapStateForIndex(index) {
        if (!Number.isInteger(index) || index < 0 || index >= subtitleElements.length) {
            return;
        }
        const container = subtitleElements[index];
        if (container) {
            container.classList.remove('overlap-active', 'overlap-start', 'overlap-end');
            container.removeAttribute('data-overlap-size');
            container.removeAttribute('data-overlap-count');
            container.removeAttribute('data-overlap-window');
            if (container.getAttribute && container.getAttribute('data-overlap-title') === '1') {
                container.removeAttribute('title');
                container.removeAttribute('data-overlap-title');
            }
        }
        const indicator = subtitleOverlapIndicators[index];
        if (indicator) {
            indicator.classList.remove('is-visible');
            indicator.removeAttribute('data-count');
            indicator.removeAttribute('title');
            indicator.textContent = '';
        }
    }

    function unwrapOverlapBlock(block) {
        if (!block || !block.parentNode) {
            return;
        }
        const parent = block.parentNode;
        while (block.firstChild) {
            parent.insertBefore(block.firstChild, block);
        }
        parent.removeChild(block);
    }

    function getLineIndexFromElement(element) {
        if (!element || !element.dataset) {
            return NaN;
        }
        if (element.dataset.frzzIndex !== undefined) {
            const parsed = parseInt(element.dataset.frzzIndex, 10);
            if (Number.isInteger(parsed)) {
                return parsed;
            }
        }
        if (element.dataset.index !== undefined) {
            const parsed = parseInt(element.dataset.index, 10);
            if (Number.isInteger(parsed)) {
                return parsed;
            }
        }
        return NaN;
    }

    function detachOverlapBlock(block) {
        if (!block) {
            return;
        }
        const attr = block.dataset ? Number(block.dataset.groupId) : NaN;
        if (Number.isInteger(attr) && activeOverlapBlockMap.get(attr) === block) {
            activeOverlapBlockMap.delete(attr);
        } else {
            activeOverlapBlockMap.forEach((value, key) => {
                if (value === block) {
                    activeOverlapBlockMap.delete(key);
                }
            });
        }
        const idx = activeOverlapBlocks.indexOf(block);
        if (idx !== -1) {
            activeOverlapBlocks.splice(idx, 1);
        }
        unwrapOverlapBlock(block);
    }

    function blockNeedsRebuild(block, sortedIndices) {
        if (!block || !Array.isArray(sortedIndices)) {
            return true;
        }
        const children = block.children || [];
        if (children.length !== sortedIndices.length) {
            return true;
        }
        for (let i = 0; i < sortedIndices.length; i += 1) {
            const childIndex = getLineIndexFromElement(children[i]);
            if (childIndex !== sortedIndices[i]) {
                return true;
            }
        }
        return false;
    }

    function createOverlapBlock(groupId, sortedIndices) {
        if (!Array.isArray(sortedIndices) || sortedIndices.length <= 1) {
            return null;
        }
        const firstElement = subtitleElements[sortedIndices[0]];
        if (!firstElement || !firstElement.parentNode) {
            return null;
        }
        const parent = firstElement.parentNode;
        const block = document.createElement('div');
        block.className = 'overlap-block';
        if (Number.isInteger(groupId)) {
            block.dataset.groupId = String(groupId);
        }
        block.dataset.overlapSize = String(sortedIndices.length);
        parent.insertBefore(block, firstElement);
        sortedIndices.forEach(index => {
            const el = subtitleElements[index];
            if (el) {
                block.appendChild(el);
            }
        });
        activeOverlapBlocks.push(block);
        if (Number.isInteger(groupId)) {
            activeOverlapBlockMap.set(groupId, block);
        }
        return block;
    }

    function updateOverlapBlockMetadata(block, size) {
        if (!block) {
            return;
        }
        block.dataset.overlapSize = String(size);
    }

    function runOverlapRefreshBatch(batchIndices) {
        if (!Array.isArray(subtitleOverlapInfo) || !subtitleOverlapInfo.length) {
            return false;
        }
        const total = Array.isArray(subtitleElements) ? subtitleElements.length : 0;
        if (!total) {
            return false;
        }
        const baseSet = new Set();
        if (Array.isArray(batchIndices)) {
            batchIndices.forEach(idx => {
                if (Number.isInteger(idx) && idx >= 0 && idx < total) {
                    baseSet.add(idx);
                }
            });
        }
        const limitIndices = resolveOverlapProcessingIndices(Array.from(baseSet));
        if (!limitIndices.length) {
            return false;
        }
        const analysis = {
            lineInfo: subtitleOverlapInfo,
            groups: overlapGroups,
            summary: latestOverlapSummary
        };
        applyOverlapAnnotations(analysis, { limitToIndices: limitIndices });
        return true;
    }

    function scheduleOverlapRefresh(indices) {
        if (Array.isArray(indices) && indices.length) {
            const total = Array.isArray(subtitleElements) ? subtitleElements.length : 0;
            indices.forEach(idx => {
                if (Number.isInteger(idx) && idx >= 0 && idx < total) {
                    pendingOverlapRefreshIndices.add(idx);
                }
            });
        }
        if (!pendingOverlapRefreshIndices.size || overlapRefreshScheduled) {
            return;
        }
        overlapRefreshScheduled = true;
        schedulePostRenderTask(() => {
            overlapRefreshScheduled = false;
            if (!pendingOverlapRefreshIndices.size) {
                return;
            }
            const batch = Array.from(pendingOverlapRefreshIndices);
            const processed = runOverlapRefreshBatch(batch);
            if (processed) {
                pendingOverlapRefreshIndices.clear();
            } else {
                scheduleOverlapRefresh();
            }
        }, { label: 'overlap visibility refresh' });
    }

    function applyOverlapAnnotations(result, options = {}) {
        const displayNode = textDisplayEl || (textDisplay && textDisplay[0]) || null;
        const lineInfo = result && Array.isArray(result.lineInfo) ? result.lineInfo : null;
        const totalLines = lineInfo ? lineInfo.length : 0;
        const groupsArray = result && Array.isArray(result.groups) ? result.groups : null;
        const groupIndexMap = new Map();

        if (groupsArray) {
            groupsArray.forEach(group => {
                if (!group || !Number.isInteger(group.id) || !Array.isArray(group.indices)) {
                    return;
                }
                groupIndexMap.set(group.id, group.indices);
            });
        }

        if (result && result.summary) {
            latestOverlapSummary = result.summary;
        }

        let limitSet = null;
        if (totalLines && options && Array.isArray(options.limitToIndices) && options.limitToIndices.length) {
            const candidateSet = new Set();
            options.limitToIndices.forEach(idx => {
                if (Number.isInteger(idx) && idx >= 0 && idx < totalLines) {
                    candidateSet.add(idx);
                }
            });
            if (candidateSet.size) {
                const queue = Array.from(candidateSet);
                for (let ptr = 0; ptr < queue.length; ptr += 1) {
                    const idx = queue[ptr];
                    const entry = lineInfo ? lineInfo[idx] : null;
                    const groupId = entry && Number.isInteger(entry.groupId) ? entry.groupId : null;
                    if (groupId === null) continue;
                    const related = groupIndexMap.get(groupId);
                    if (!Array.isArray(related)) continue;
                    for (let i = 0; i < related.length; i += 1) {
                        const siblingIdx = related[i];
                        if (!Number.isInteger(siblingIdx) || siblingIdx < 0 || siblingIdx >= totalLines) {
                            continue;
                        }
                        if (!candidateSet.has(siblingIdx)) {
                            candidateSet.add(siblingIdx);
                            queue.push(siblingIdx);
                        }
                    }
                }
                if (candidateSet.size) {
                    limitSet = candidateSet;
                }
            }
        }

        const processAll = !limitSet;
        const limitArray = limitSet ? Array.from(limitSet).sort((a, b) => a - b) : null;
        const touchedGroupIds = new Set();

        if (!processAll && limitSet && limitSet.size) {
            activeOverlapBlockMap.forEach((block, groupId) => {
                if (!block) {
                    return;
                }
                const children = block.children || [];
                for (let i = 0; i < children.length; i += 1) {
                    const idx = getLineIndexFromElement(children[i]);
                    if (Number.isInteger(idx) && limitSet.has(idx)) {
                        touchedGroupIds.add(groupId);
                        break;
                    }
                }
            });
        }

        if (activeOverlapLineIndices.length) {
            if (processAll) {
                for (let idx = 0; idx < activeOverlapLineIndices.length; idx += 1) {
                    clearOverlapStateForIndex(activeOverlapLineIndices[idx]);
                }
                activeOverlapLineIndices = [];
            } else if (limitSet) {
                const retained = [];
                for (let idx = 0; idx < activeOverlapLineIndices.length; idx += 1) {
                    const lineIndex = activeOverlapLineIndices[idx];
                    if (limitSet.has(lineIndex)) {
                        clearOverlapStateForIndex(lineIndex);
                    } else {
                        retained.push(lineIndex);
                    }
                }
                activeOverlapLineIndices = retained;
            }
        }

        if (!lineInfo || !lineInfo.length) {
            if (processAll) {
                activeOverlapBlocks.slice().forEach(detachOverlapBlock);
                activeOverlapBlockMap.clear();
            } else if (touchedGroupIds.size) {
                touchedGroupIds.forEach(groupId => {
                    const existingBlock = activeOverlapBlockMap.get(groupId);
                    if (existingBlock) {
                        detachOverlapBlock(existingBlock);
                    }
                });
            }
            return result ? result.summary : null;
        }

        const overlapVisualsEnabled = settings.highlightOverlapEnabled !== false;
        if (!overlapVisualsEnabled) {
            if (activeOverlapBlocks.length) {
                activeOverlapBlocks.slice().forEach(detachOverlapBlock);
                activeOverlapBlockMap.clear();
            }
            return result ? result.summary : null;
        }

        if (!processAll && (!limitArray || !limitArray.length)) {
            return result ? result.summary : null;
        }

        const frameRate = getActiveFrameRate();
        const groupMembers = new Map();
        const updatedOverlapIndices = [];

        const ensureIndicatorForIndex = (lineIndex, entry, tooltipLines) => {
            let indicator = subtitleOverlapIndicators[lineIndex];
            if (!indicator) {
                const timeEl = subtitleTimeElements[lineIndex];
                if (timeEl) {
                    indicator = document.createElement('span');
                    indicator.className = 'overlap-indicator';
                    indicator.setAttribute('aria-hidden', 'true');
                    indicator.textContent = '';
                    const timeProgressEl = subtitleTimeProgressElements[lineIndex];
                    if (timeProgressEl && timeProgressEl.parentNode === timeEl) {
                        timeEl.insertBefore(indicator, timeProgressEl);
                    } else {
                        timeEl.appendChild(indicator);
                    }
                    subtitleOverlapIndicators[lineIndex] = indicator;
                }
            }
            if (indicator) {
                indicator.classList.add('is-visible');
                indicator.setAttribute('data-count', String(entry.overlapCount));
                indicator.setAttribute('title', tooltipLines[0]);
            }
        };

        const processLine = (lineIndex) => {
            if (!Number.isInteger(lineIndex) || lineIndex < 0 || !lineInfo || lineIndex >= lineInfo.length) {
                return;
            }
            const entry = lineInfo[lineIndex];
            if (!entry) {
                return;
            }
            if (!entry.groupSize || entry.groupSize <= 1) {
                if (Number.isInteger(entry.groupId)) {
                    touchedGroupIds.add(entry.groupId);
                }
                return;
            }
            const container = subtitleElements[lineIndex];
            if (!container) {
                return;
            }

            updatedOverlapIndices.push(lineIndex);

            container.classList.add('overlap-active');
            if (entry.isStart) {
                container.classList.add('overlap-start');
            }
            if (entry.isEnd) {
                container.classList.add('overlap-end');
            }
            container.dataset.overlapSize = String(entry.groupSize);
            container.dataset.overlapCount = String(entry.overlapCount);
            container.dataset.overlapWindow = `${entry.minGroupStartMs}-${entry.maxGroupEndMs}`;

            const rangeStartSec = entry.minGroupStartMs / 1000;
            const rangeEndSec = entry.maxGroupEndMs / 1000;
            const tooltipBase = entry.groupSize > 2
                ? `Пересечения: ${entry.groupSize} реплик`
                : 'Пересечения: 2 реплики';
            const startTimecode = formatTimecode(rangeStartSec, frameRate);
            const endTimecode = formatTimecode(rangeEndSec, frameRate);
            const durationMs = Math.max(0, entry.maxGroupEndMs - entry.minGroupStartMs);
            const durationText = PrompterTime.formatHmsMillis(durationMs, durationMs >= 1000 ? 2 : 3);
            const tooltipLines = [
                tooltipBase,
                `Интервал: ${startTimecode} → ${endTimecode}`,
                `Длительность: ${durationText}`
            ];
            if (entry.maxDegreeInGroup && entry.maxDegreeInGroup > 1) {
                tooltipLines.push(`Максимум одновременно: ${entry.maxDegreeInGroup}`);
            }
            if (entry.overlapCount > 0) {
                tooltipLines.push(`Связей с текущей строкой: ${entry.overlapCount}`);
            }
            container.setAttribute('title', tooltipLines.join('\n'));
            container.setAttribute('data-overlap-title', '1');

            ensureIndicatorForIndex(lineIndex, entry, tooltipLines);

            if (Number.isInteger(entry.groupId) && entry.groupId >= 0) {
                let members = groupMembers.get(entry.groupId);
                if (!members) {
                    members = [];
                    groupMembers.set(entry.groupId, members);
                }
                members.push(lineIndex);
                touchedGroupIds.add(entry.groupId);
            }
        };

        if (processAll) {
            for (let i = 0; i < lineInfo.length; i += 1) {
                processLine(i);
            }
        } else {
            for (let idx = 0; idx < limitArray.length; idx += 1) {
                processLine(limitArray[idx]);
            }
        }

        const groupsKept = new Set();
        groupMembers.forEach((indices, groupId) => {
            if (!Array.isArray(indices) || indices.length <= 1) {
                return;
            }
            const sorted = indices.slice().sort((a, b) => a - b);
            let block = activeOverlapBlockMap.get(groupId);
            if (block && blockNeedsRebuild(block, sorted)) {
                detachOverlapBlock(block);
                block = null;
            }
            if (!block) {
                block = createOverlapBlock(groupId, sorted);
            } else {
                updateOverlapBlockMetadata(block, sorted.length);
            }
            if (block) {
                groupsKept.add(groupId);
            }
        });

        const groupsToRemove = processAll
            ? Array.from(activeOverlapBlockMap.keys()).filter(groupId => !groupsKept.has(groupId))
            : Array.from(touchedGroupIds).filter(groupId => Number.isInteger(groupId) && !groupsKept.has(groupId));

        groupsToRemove.forEach(groupId => {
            const block = activeOverlapBlockMap.get(groupId);
            if (block) {
                detachOverlapBlock(block);
            }
        });

        if (processAll) {
            activeOverlapLineIndices = updatedOverlapIndices;
        } else {
            const nextActive = new Set(activeOverlapLineIndices);
            updatedOverlapIndices.forEach(index => nextActive.add(index));
            activeOverlapLineIndices = Array.from(nextActive).sort((a, b) => a - b);
        }

        return result ? result.summary : null;
    }

    function computeAndApplyOverlaps(options = {}) {
        if (!Array.isArray(subtitleData) || !subtitleData.length) {
            subtitleOverlapInfo = [];
            overlapGroups = [];
            const summaryPayload = applyOverlapAnnotations({ lineInfo: [], summary: {
                totalGroups: 0,
                totalLines: 0,
                affectedLines: 0,
                maxGroupSize: 0,
                maxOverlapDegree: 0,
                peakSimultaneous: 0,
                overlapPairs: 0,
                computeDurationMs: 0
            } });
            if (summaryPayload) {
                latestOverlapSummary = summaryPayload;
            }
            eventBus.emit('overlaps:update', {
                totalGroups: 0,
                totalLines: 0,
                affectedLines: 0,
                maxGroupSize: 0,
                maxOverlapDegree: 0,
                peakSimultaneous: 0,
                overlapPairs: 0,
                computeDurationMs: 0,
                reason: options.reason || 'empty'
            });
            return summaryPayload;
        }

        const analysis = buildOverlapAnalysis(subtitleData);
        subtitleOverlapInfo = analysis.lineInfo;
        overlapGroups = analysis.groups;
        const summary = applyOverlapAnnotations(analysis) || analysis.summary;
        if (summary) {
            latestOverlapSummary = summary;
        }
        const payload = {
            totalGroups: summary.totalGroups,
            totalLines: summary.totalLines,
            affectedLines: summary.affectedLines,
            linesWithOverlap: summary.affectedLines,
            maxGroupSize: summary.maxGroupSize,
            maxOverlapDegree: summary.maxOverlapDegree,
            peakSimultaneous: summary.peakSimultaneous,
            overlapPairs: summary.overlapPairs,
            computeDurationMs: summary.computeDurationMs,
            reason: options.reason || 'compute'
        };
        eventBus.emit('overlaps:update', payload);
        console.info('[Prompter][overlaps] analysis', payload);
        return payload;
    }

    function calibrateIntrinsicSizeForIndex(index, options = {}) {
        if (!supportsContainIntrinsicSize) return;
        if (!Number.isInteger(index) || index < 0 || index >= subtitleElements.length) {
            return;
        }
        const container = subtitleElements[index];
        if (!container) return;
        if (!options.force && container.dataset && container.dataset.intrinsicCalibrated === '1') {
            return;
        }
        const hadInlineVisibility = container.style && container.style.contentVisibility && container.style.contentVisibility.length > 0;
        let previousVisibility = '';
        if (!hadInlineVisibility) {
            previousVisibility = container.style.contentVisibility;
            container.style.contentVisibility = 'visible';
        }
        const measured = container.offsetHeight || container.scrollHeight || 0;
        if (measured > 0) {
            container.style.setProperty('--subtitle-intrinsic-block-size', `${measured}px`);
            if (container.dataset) {
                container.dataset.intrinsicCalibrated = '1';
            }
        }
        if (!hadInlineVisibility) {
            if (previousVisibility) {
                container.style.contentVisibility = previousVisibility;
            } else {
                container.style.removeProperty('content-visibility');
            }
        }
    }

    function ensureIntrinsicSizeForIndex(index) {
        if (!supportsContainIntrinsicSize) return;
        calibrateIntrinsicSizeForIndex(index);
        if (index > 0) {
            calibrateIntrinsicSizeForIndex(index - 1);
        }
        if (index + 1 < subtitleElements.length) {
            calibrateIntrinsicSizeForIndex(index + 1);
        }
    }

    function scheduleIntrinsicSizeCalibration(indices) {
        if (!supportsContainIntrinsicSize) return;
        if (Array.isArray(indices) && indices.length) {
            indices.forEach(idx => {
                if (Number.isInteger(idx) && idx >= 0 && idx < subtitleElements.length) {
                    intrinsicSizeCalibrationQueue.push(idx);
                }
            });
        }
        if (intrinsicSizeCalibrationScheduled || !intrinsicSizeCalibrationQueue.length) {
            return;
        }
        intrinsicSizeCalibrationScheduled = true;
        const processBatch = (deadline) => {
            intrinsicSizeCalibrationScheduled = false;
            if (!intrinsicSizeCalibrationQueue.length) {
                return;
            }
            const startTs = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
            const maxBatch = 60;
            let processed = 0;
            while (intrinsicSizeCalibrationQueue.length) {
                const idx = intrinsicSizeCalibrationQueue.shift();
                calibrateIntrinsicSizeForIndex(idx);
                processed += 1;
                if (deadline) {
                    if (deadline.timeRemaining() <= 1) {
                        break;
                    }
                } else {
                    const nowTs = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
                    if ((nowTs - startTs) > 8 || processed >= maxBatch) {
                        break;
                    }
                }
            }
            if (intrinsicSizeCalibrationQueue.length) {
                if (typeof requestIdleCallback === 'function') {
                    requestIdleCallback(processBatch);
                } else {
                    setTimeout(() => processBatch(), 16);
                }
            }
        };
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(processBatch);
        } else {
            setTimeout(() => processBatch(), 16);
        }
    }

    function primeIntrinsicSizesForAll() {
        if (!supportsContainIntrinsicSize) return;
        intrinsicSizeCalibrationQueue = [];
        if (!Array.isArray(subtitleElements) || !subtitleElements.length) {
            return;
        }
        for (let i = 0; i < subtitleElements.length; i += 1) {
            intrinsicSizeCalibrationQueue.push(i);
        }
        scheduleIntrinsicSizeCalibration();
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
        const onComplete = typeof options.onComplete === 'function' ? options.onComplete : null;
        if (!wrapper) {
            if (onComplete) {
                onComplete();
            }
            return;
        }
        const maxScrollTop = Math.max(0, wrapper.scrollHeight - wrapper.clientHeight);
        const clampedTarget = clampNumber(targetTop, 0, maxScrollTop);
        const currentScrollTop = wrapper.scrollTop;
        const distance = clampedTarget - currentScrollTop;
        const instant = options.instant === true || (Number.isFinite(options.durationMs) && options.durationMs <= 0);
        if (instant) {
            if (scrollAnimationFrame) {
                cancelAnimationFrame(scrollAnimationFrame);
                scrollAnimationFrame = null;
            }
            wrapper.scrollTop = clampedTarget;
            if (onComplete) {
                onComplete();
            }
            return;
        }
        if (Math.abs(distance) < 0.5) {
            wrapper.scrollTop = clampedTarget;
            if (onComplete) {
                onComplete();
            }
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
                if (onComplete) {
                    onComplete();
                }
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
        paintLine(targetIndex, true);
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
            const container = event && event.currentTarget
                ? event.currentTarget
                : (event && event.target && typeof event.target.closest === 'function'
                    ? event.target.closest('.subtitle-container')
                    : null);
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
            focusLineElement(index, { element: container, scroll: false });
            if (!emitted) {
                console.debug('[Prompter][jump] request not emitted (backend unavailable or throttled)');
            }
        } catch (err) {
            console.error('[Prompter][jump] subtitle click handler error', err);
        }
    }

    function resetSubtitleProgressAt(index) {
        if (!Number.isInteger(index) || index < 0 || index >= subtitleProgressContainers.length) {
            return;
        }
        const container = subtitleProgressContainers[index];
        const bar = subtitleProgressBars[index];
        const contentEl = subtitleContentElements[index];
        if (bar) {
            bar.style.transform = 'scaleX(0)';
        }
        subtitleProgressValues[index] = 0;
        if (contentEl && contentEl.classList) {
            contentEl.classList.remove('has-progress');
        }
        if (container) {
            const parent = container.parentNode;
            if (parent && parent === contentEl) {
                parent.removeChild(container);
            } else if (parent) {
                parent.removeChild(container);
            }
        }
        activeSubtitleProgressIndices.delete(index);
    }

    function clearSubtitleProgress(index) {
        if (typeof index === 'number') {
            resetSubtitleProgressAt(index);
            return;
        }
        const indices = Array.from(activeSubtitleProgressIndices);
        indices.forEach(resetSubtitleProgressAt);
        activeSubtitleProgressIndices.clear();
    }

    function ensureSubtitleProgressElements(index) {
        if (!Number.isInteger(index) || index < 0 || index >= subtitleProgressContainers.length) {
            return null;
        }
        let container = subtitleProgressContainers[index];
        let bar = subtitleProgressBars[index];
        if (container && bar) {
            return { container, bar };
        }
        container = document.createElement('div');
        container.className = 'subtitle-progress-container';
        container.setAttribute('aria-hidden', 'true');
        bar = document.createElement('div');
        bar.className = 'subtitle-progress-bar';
        bar.style.transform = 'scaleX(0)';
        container.appendChild(bar);
        subtitleProgressContainers[index] = container;
        subtitleProgressBars[index] = bar;
        subtitleProgressValues[index] = 0;
        return { container, bar };
    }

    function setSubtitleProgress(index, fraction) {
        if (!Number.isInteger(index) || index < 0 || index >= subtitleProgressContainers.length) {
            return;
        }
        if (!isLineWithinAnimationViewport(index)) {
            return;
        }
        const ensured = ensureSubtitleProgressElements(index);
        if (!ensured) {
            return;
        }
        const container = ensured.container;
        const bar = ensured.bar;
        const contentEl = subtitleContentElements[index];
        if (!container || !bar || !contentEl) {
            return;
        }
        if (container.parentNode !== contentEl) {
            contentEl.appendChild(container);
        }
        if (contentEl.classList) {
            contentEl.classList.add('has-progress');
        }
        const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
        const previous = typeof subtitleProgressValues[index] === 'number'
            ? subtitleProgressValues[index]
            : 0;
        if (Math.abs(clamped - previous) > 0.001) {
            bar.style.transform = `scaleX(${clamped})`;
        }
        subtitleProgressValues[index] = clamped;
        activeSubtitleProgressIndices.add(index);
    }

    function computeLineProgressFraction(line, currentTime) {
        if (!line) return 0;
        const start = Number(line.start_time);
        const end = Number(line.end_time);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            return 0;
        }
        const duration = end - start;
        if (duration <= 0) {
            return currentTime >= end ? 1 : 0;
        }
        const raw = (Number(currentTime) - start) / duration;
        return Math.max(0, Math.min(1, raw));
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

    function resetTimecodeProgressAt(index) {
        if (!Number.isInteger(index) || index < 0 || index >= subtitleTimeElements.length) {
            return;
        }
        const wrapper = subtitleTimeElements[index] || null;
        const progressEl = subtitleTimeProgressElements[index] || null;
        if (wrapper && wrapper.classList) {
            wrapper.classList.remove('has-time-progress');
        }
        if (progressEl) {
            progressEl.style.transform = 'scaleX(0)';
        }
        activeTimecodeProgressIndices.delete(index);
        timecodeProgressValues[index] = 0;
    }

    function clearTimecodeProgress(index) {
        if (typeof index === 'number') {
            resetTimecodeProgressAt(index);
            return;
        }
        const indices = Array.from(activeTimecodeProgressIndices);
        indices.forEach(resetTimecodeProgressAt);
        activeTimecodeProgressIndices.clear();
    }

    function setTimecodeProgress(index, fraction) {
        if (!Number.isInteger(index) || index < 0 || index >= subtitleTimeElements.length) {
            return;
        }
        if (!isLineWithinAnimationViewport(index)) {
            return;
        }
        const wrapper = subtitleTimeElements[index];
        if (!wrapper) {
            return;
        }
        let progressEl = subtitleTimeProgressElements[index];
        if (!progressEl) {
            progressEl = document.createElement('span');
            progressEl.className = 'subtitle-time-progress';
            progressEl.setAttribute('aria-hidden', 'true');
            progressEl.style.transformOrigin = 'left';
            progressEl.style.transform = 'scaleX(0)';
            const indicator = subtitleOverlapIndicators[index];
            if (indicator && indicator.parentNode === wrapper) {
                wrapper.insertBefore(progressEl, indicator.nextSibling);
            } else {
                wrapper.appendChild(progressEl);
            }
            subtitleTimeProgressElements[index] = progressEl;
        }
        if (!activeTimecodeProgressIndices.has(index)) {
            activeTimecodeProgressIndices.add(index);
            if (wrapper.classList) {
                wrapper.classList.add('has-time-progress');
            }
            if (typeof timecodeProgressValues[index] !== 'number') {
                timecodeProgressValues[index] = 0;
            }
        }
        const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
        const previous = typeof timecodeProgressValues[index] === 'number'
            ? timecodeProgressValues[index]
            : 0;
        if (Math.abs(clamped - previous) < 0.001) {
            timecodeProgressValues[index] = clamped;
            return;
        }
        progressEl.style.transform = `scaleX(${clamped})`;
        timecodeProgressValues[index] = clamped;
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
            scheduleContentVisibilityUpdate({ force: true });
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
        scheduleContentVisibilityUpdate({ force: true });
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
        scheduleContentVisibilityUpdate();
        if (Array.isArray(subtitleOverlapInfo) && subtitleOverlapInfo.length) {
            scheduleOverlapRefresh(Array.from(visibleIndices));
        }
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

    function applySubtReaderInertia(_index, _currentTime) {
        resetSubtReaderLineState();
    }

    // Measure target scroll position ahead of DOM mutations to avoid layout thrashing.
    function computeAutoScrollPlan(targetIndex, options = {}) {
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= subtitleElements.length) {
            return undefined;
        }
        ensureIntrinsicSizeForIndex(targetIndex);
        const wrapper = textDisplayWrapperEl || textDisplayWrapper[0] || null;
        if (!wrapper) return undefined;
        const element = subtitleElements[targetIndex];
        if (!element) return undefined;

        const wrapperHeight = wrapper.clientHeight || 0;
        const scrollHeight = wrapper.scrollHeight || 0;
        if (!wrapperHeight || !scrollHeight) return undefined;

        const mode = sanitizeAutoScrollMode(settings.autoScrollMode, defaultSettings.autoScrollMode);
        const forceScroll = options.force === true || options.instant === true;
        const lookahead = options.lookahead === true;
        const currentTimeSeconds = Number.isFinite(options.currentTime) ? options.currentTime : null;

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
        const windowTopPx = wrapperHeight * windowTopFraction;
        const windowBottomPx = wrapperHeight * windowBottomFraction;

        let targetOffsetTop = typeof element.offsetTop === 'number' ? element.offsetTop : 0;
        if (typeof element.getBoundingClientRect === 'function' && typeof wrapper.getBoundingClientRect === 'function') {
            const nodeRect = element.getBoundingClientRect();
            const wrapperRect = wrapper.getBoundingClientRect();
            if (nodeRect && wrapperRect) {
                const relativeTop = (nodeRect.top - wrapperRect.top) + wrapper.scrollTop;
                if (Number.isFinite(relativeTop)) {
                    targetOffsetTop = relativeTop;
                }
            }
        }

        const currentScrollTop = wrapper.scrollTop;
        const elementHeight = Math.max(element.offsetHeight || 1, 1);
        const elementTopRelative = targetOffsetTop - currentScrollTop;
        const elementBottomRelative = elementTopRelative + elementHeight;

    // Mirror manual timecode centering: derive scroll target from relative element geometry first.
    let desiredScrollTop = currentScrollTop;
        if (mode === 'line') {
            const lineAnchorPercent = sanitizeAutoScrollPercent(
                settings.autoScrollLineAnchorPercent,
                defaultSettings.autoScrollLineAnchorPercent,
                0,
                100
            );
            const anchorFraction = clampNumber(lineAnchorPercent / 100, 0.05, 0.95);
            const lookaheadOffsetPx = lookahead
                ? Math.min(elementHeight * 0.6, wrapperHeight * 0.25)
                : 0;
            const anchorTarget = (wrapperHeight * anchorFraction) + lookaheadOffsetPx;
            const elementCenter = elementTopRelative + (elementHeight * 0.5);
            const deltaToAnchor = elementCenter - anchorTarget;
            const tolerancePx = Math.max(LINE_SCROLL_TOLERANCE_PX, Math.min(elementHeight * 0.5, wrapperHeight * 0.1));
            if (!forceScroll && Math.abs(deltaToAnchor) <= tolerancePx) {
                return null;
            }
            desiredScrollTop = clampNumber(
                currentScrollTop + deltaToAnchor,
                0,
                Math.max(0, scrollHeight - wrapperHeight)
            );
        } else {
            const tolerancePx = Math.max(PAGE_SCROLL_TOLERANCE_PX, Math.min(elementHeight * 0.25, wrapperHeight * 0.08));
            const isAbove = elementTopRelative < (windowTopPx - tolerancePx);
            const isBelow = elementBottomRelative > (windowBottomPx + tolerancePx);
            if (!forceScroll && !isAbove && !isBelow) {
                return null;
            }
            const alignTopTarget = targetOffsetTop - windowTopPx;
            desiredScrollTop = clampNumber(alignTopTarget, 0, Math.max(0, scrollHeight - wrapperHeight));
        }

        const distance = desiredScrollTop - currentScrollTop;
        if (!forceScroll && Math.abs(distance) < 0.5) {
            return null;
        }

    const speedMultiplier = getScrollSpeedMultiplier();
    const dynamicSpeedEnabled = false; // dynamic speed temporarily disabled
        let durationMs;

        if (options.instant === true) {
            durationMs = 0;
        } else if (mode === 'line') {
            const baseMs = sanitizeAutoScrollLineEasingBaseMs(
                settings.autoScrollLineEasingBaseMs,
                defaultSettings.autoScrollLineEasingBaseMs
            );
            const perPixel = sanitizeAutoScrollLineEasingPerPixel(
                settings.autoScrollLineEasingPerPixel,
                defaultSettings.autoScrollLineEasingPerPixel
            );
            const maxMs = sanitizeAutoScrollLineEasingMaxMs(
                settings.autoScrollLineEasingMaxMs,
                defaultSettings.autoScrollLineEasingMaxMs
            );
            if (dynamicSpeedEnabled) {
                const dynamicBase = Math.max(baseMs, 120);
                const computed = (dynamicBase + Math.abs(distance) * perPixel) / speedMultiplier;
                const lowerBound = (LINE_BASELINE_DURATION_MS * 0.45) / speedMultiplier;
                durationMs = clampNumber(Math.round(Math.max(computed, lowerBound)), MIN_TIMELINE_SCROLL_MS, Math.max(maxMs, LINE_BASELINE_DURATION_MS));
            } else {
                const staticBase = Math.max(baseMs, LINE_BASELINE_DURATION_MS);
                const computed = staticBase / speedMultiplier;
                durationMs = clampNumber(Math.round(computed), MIN_TIMELINE_SCROLL_MS, Math.max(maxMs, LINE_BASELINE_DURATION_MS));
            }
        } else {
            if (dynamicSpeedEnabled) {
                const normalizedDistance = clampNumber(Math.abs(distance) / Math.max(wrapperHeight, 1), 0, 1.75);
                const dynamicScale = 0.45 + (normalizedDistance * 0.55);
                const computed = (PAGE_BASELINE_DURATION_MS * dynamicScale) / speedMultiplier;
                durationMs = clampNumber(Math.round(computed), MIN_TIMELINE_SCROLL_MS, MAX_AUTO_SCROLL_ANIMATION_MS);
            } else {
                const computed = PAGE_BASELINE_DURATION_MS / speedMultiplier;
                durationMs = clampNumber(Math.round(computed), MIN_TIMELINE_SCROLL_MS, MAX_AUTO_SCROLL_ANIMATION_MS);
            }
        }

        const timelineConstraintMs = dynamicSpeedEnabled
            ? computeTimelineDurationConstraint(targetIndex, currentTimeSeconds, lookahead)
            : null;
        if (timelineConstraintMs !== null && Number.isFinite(durationMs)) {
            durationMs = Math.max(MIN_TIMELINE_SCROLL_MS, Math.min(durationMs, timelineConstraintMs));
        }

        const easingFn = mode === 'line' ? easeInOutCubic : easeOutCubic;

        return {
            targetScrollTop: desiredScrollTop,
            durationMs,
            easing: easingFn,
            mode,
            distance: Math.abs(distance),
            lookahead,
            instant: options.instant === true
        };
    }

    function autoScrollToIndex(targetIndex, precomputedPlan) {
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= subtitleElements.length) {
            return;
        }
        const plan = (typeof precomputedPlan === 'undefined') ? computeAutoScrollPlan(targetIndex) : precomputedPlan;
        if (!plan) {
            return;
        }
        const planToken = { targetIndex, plan, timestamp: Date.now() };
        activeAutoScrollPlan = planToken;
        smoothScrollWrapperTo(plan.targetScrollTop, {
            durationMs: plan.instant ? 0 : plan.durationMs,
            easing: plan.easing,
            instant: plan.instant === true,
            onComplete: () => {
                if (activeAutoScrollPlan === planToken) {
                    activeAutoScrollPlan = null;
                    if (contentVisibilityUpdatePending) {
                        scheduleContentVisibilityUpdate({ force: true });
                    }
                }
            }
        });
    }

    function invalidateAllLinePaint() {
        paintGeneration = (paintGeneration + 1) >>> 0;
        if (Array.isArray(subtitleStyleMetadata) && subtitleStyleMetadata.length) {
            for (let i = 0; i < subtitleStyleMetadata.length; i += 1) {
                const meta = subtitleStyleMetadata[i];
                if (meta) {
                    meta.colorApplied = false;
                }
            }
        }
        if (!Array.isArray(subtitleElements) || !subtitleElements.length) {
            return;
        }
        if (visibleIndices.size) {
            visibleIndices.forEach(idx => {
                if (idx >= 0 && idx < subtitleElements.length) {
                    paintLine(idx, true);
                }
            });
            return;
        }
        const hasRange = Number.isInteger(visibleRangeStart)
            && Number.isInteger(visibleRangeEnd)
            && visibleRangeEnd >= visibleRangeStart;
        if (hasRange) {
            for (let idx = visibleRangeStart; idx <= visibleRangeEnd; idx += 1) {
                paintLine(idx, true);
            }
            return;
        }
        for (let idx = 0; idx < subtitleElements.length; idx += 1) {
            paintLine(idx, true);
        }
    }

    function scheduleContentVisibilityUpdate(options = {}) {
        if (options && options.force === true) {
            contentVisibilityUpdateScheduled = false;
            applyContentVisibilityWindow({ force: true });
            return;
        }
        if (contentVisibilityUpdateScheduled) {
            return;
        }
        contentVisibilityUpdateScheduled = true;
        requestAnimationFrame(() => {
            contentVisibilityUpdateScheduled = false;
            applyContentVisibilityWindow();
        });
    }

    function applyContentVisibilityWindow(options = {}) {
        const force = options && options.force === true;
        if (!force && activeAutoScrollPlan) {
            contentVisibilityUpdatePending = true;
            return;
        }
        contentVisibilityUpdatePending = false;
        if (!Array.isArray(subtitleElements) || !subtitleElements.length) {
            clearContentVisibilityOverrides();
            return;
        }

        const total = subtitleElements.length;
        let start = 0;
        let end = Math.min(total - 1, CONTENT_VISIBILITY_RADIUS * 2);
        const hasRange = Number.isInteger(visibleRangeStart)
            && Number.isInteger(visibleRangeEnd)
            && visibleRangeEnd >= visibleRangeStart
            && visibleRangeStart >= 0;
        if (hasRange) {
            start = Math.max(0, visibleRangeStart - CONTENT_VISIBILITY_RADIUS);
            end = Math.min(total - 1, visibleRangeEnd + CONTENT_VISIBILITY_RADIUS);
        } else if (visibleIndices.size) {
            let min = Infinity;
            let max = -1;
            visibleIndices.forEach(idx => {
                if (idx < min) min = idx;
                if (idx > max) max = idx;
            });
            if (Number.isFinite(min) && Number.isFinite(max)) {
                start = Math.max(0, min - CONTENT_VISIBILITY_RADIUS);
                end = Math.min(total - 1, max + CONTENT_VISIBILITY_RADIUS);
            }
        } else {
            end = Math.min(total - 1, CONTENT_VISIBILITY_RADIUS);
        }

        const nextSet = new Set();
        for (let idx = start; idx <= end; idx += 1) {
            nextSet.add(idx);
        }

        forcedContentVisibilityIndices.forEach(idx => {
            if (!nextSet.has(idx)) {
                if (idx >= 0 && idx < total) {
                    const el = subtitleElements[idx];
                    if (el && el.style && el.style.contentVisibility === 'visible') {
                        el.style.removeProperty('content-visibility');
                    }
                }
            }
        });

        nextSet.forEach(idx => {
            if (!forcedContentVisibilityIndices.has(idx)) {
                const el = subtitleElements[idx];
                if (el && el.style) {
                    el.style.contentVisibility = 'visible';
                }
            }
        });

        forcedContentVisibilityIndices = nextSet;
    }

    function clearContentVisibilityOverrides() {
        if (!forcedContentVisibilityIndices || forcedContentVisibilityIndices.size === 0) {
            contentVisibilityUpdatePending = false;
            return;
        }
        forcedContentVisibilityIndices.forEach(idx => {
            const el = subtitleElements && idx >= 0 && idx < subtitleElements.length ? subtitleElements[idx] : null;
            if (el && el.style) {
                el.style.removeProperty('content-visibility');
            }
        });
        forcedContentVisibilityIndices = new Set();
        contentVisibilityUpdatePending = false;
    }

    function isLineWithinAnimationViewport(index) {
        if (!Number.isInteger(index) || index < 0 || index >= subtitleElements.length) {
            return false;
        }
        const hasValidRange = Number.isInteger(visibleRangeStart)
            && Number.isInteger(visibleRangeEnd)
            && visibleRangeEnd >= visibleRangeStart;
        if (!hasValidRange) {
            if (!visibleIndices.size) {
                return true;
            }
            return visibleIndices.has(index);
        }
        const bufferedStart = Math.max(0, visibleRangeStart - ANIMATION_VIEWPORT_BUFFER);
        const bufferedEnd = Math.min(subtitleElements.length - 1, visibleRangeEnd + ANIMATION_VIEWPORT_BUFFER);
        return index >= bufferedStart && index <= bufferedEnd;
    }

    function getSeparatorPaintColor() {
        if (typeof document === 'undefined' || !document.body) {
            return '#555';
        }
        return document.body.classList.contains('light-theme') ? '#ccc' : '#555';
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
        const hasBaseColor = !!baseColor;
        const useLightened = hasBaseColor && !!settings.roleFontColorEnabled;
        const lightened = useLightened ? (getLightenedColorCached(baseColor, true) || null) : null;

        const roleEl = colorInfo.roleElement;
        if (roleEl && hasBaseColor) {
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
        if (columnSwatch && hasBaseColor) {
            const desiredBg = lightened ? lightened.bg : baseColor;
            if (columnSwatch.style.backgroundColor !== desiredBg) {
                columnSwatch.style.backgroundColor = desiredBg;
            }
        }

        const inlineSwatch = colorInfo.inlineSwatch;
        if (inlineSwatch && hasBaseColor) {
            const desiredBg = lightened ? lightened.bg : baseColor;
            if (inlineSwatch.style.backgroundColor !== desiredBg) {
                inlineSwatch.style.backgroundColor = desiredBg;
            }
        }

        const separatorEl = colorInfo.separator;
        if (separatorEl) {
            const separatorColor = getSeparatorPaintColor();
            if (separatorEl.style.backgroundColor !== separatorColor) {
                separatorEl.style.backgroundColor = separatorColor;
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
            const separatorEl = colorInfo.separator;
            if (separatorEl && separatorEl.style.backgroundColor) {
                separatorEl.style.backgroundColor = '';
            }
            meta.colorApplied = false;
        }
    }

    function handleWrapperScroll() {
        scheduleContentVisibilityUpdate();
    }

    if (textDisplayWrapperEl) {
        textDisplayWrapperEl.addEventListener('scroll', handleWrapperScroll, { passive: true });
    }
    window.addEventListener('resize', () => {
        scheduleContentVisibilityUpdate();
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
        return isQueryFlagEnabled('emumode');
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
                mainTitle.text(APP_NAME);
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
            progressBarMode: sanitizeProgressBarMode(raw.progressBarMode, defaultSettings.progressBarMode),
            highlightOverlapEnabled: raw.highlightOverlapEnabled !== false
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
            if (highlightOverlapEnabledCheckbox.length) {
                highlightOverlapEnabledCheckbox.prop('checked', normalized.highlightOverlapEnabled);
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
        if (highlightOverlapOptions && highlightOverlapOptions.length) {
            highlightOverlapOptions.toggle(normalized.highlightOverlapEnabled);
        }
        if (highlightOverlapColorInput && highlightOverlapColorInput.length) {
            highlightOverlapColorInput.prop('disabled', !normalized.highlightOverlapEnabled);
            if (typeof highlightOverlapColorInput.data === 'function' && highlightOverlapColorInput.data('spectrum')) {
                highlightOverlapColorInput.spectrum(normalized.highlightOverlapEnabled ? 'enable' : 'disable');
            }
            const copyButton = highlightOverlapColorInput.closest('.input-with-button').find('.copy-color-btn');
            if (copyButton && copyButton.length) {
                copyButton.prop('disabled', !normalized.highlightOverlapEnabled);
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
            progressBarMode: progressBarModeSelect.length ? progressBarModeSelect.val() : defaultSettings.progressBarMode,
            highlightOverlapEnabled: !highlightOverlapEnabledCheckbox.length || highlightOverlapEnabledCheckbox.is(':checked')
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
        lastLineLookaheadIndex = -1;
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

            const ignoreProjectItemColors = tempSettings.ignoreProjectItemColors !== false;
            tempSettings.ignoreProjectItemColors = ignoreProjectItemColors;
            settings.ignoreProjectItemColors = ignoreProjectItemColors;

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

            const highlightOverlapEnabled = tempSettings.highlightOverlapEnabled !== false;
            tempSettings.highlightOverlapEnabled = highlightOverlapEnabled;
            settings.highlightOverlapEnabled = highlightOverlapEnabled;

            let segmentationModeValue;
            if (fromDom && segmentationModeSelect.length) {
                segmentationModeValue = sanitizeSegmentationMode(segmentationModeSelect.val());
            } else {
                segmentationModeValue = deriveSegmentationModeFromFlags(
                    tempSettings.segmentationEnabled !== false,
                    tempSettings.segmentationAutoVideoEnabled !== false,
                    tempSettings.segmentationAutoMarkersEnabled !== false
                );
            }
            const segmentationModeFlags = mapSegmentationModeToFlags(segmentationModeValue);
            tempSettings.segmentationEnabled = segmentationModeFlags.enabled;
            settings.segmentationEnabled = segmentationModeFlags.enabled;
            tempSettings.segmentationAutoVideoEnabled = segmentationModeFlags.video;
            settings.segmentationAutoVideoEnabled = segmentationModeFlags.video;
            tempSettings.segmentationAutoMarkersEnabled = segmentationModeFlags.markers;
            settings.segmentationAutoMarkersEnabled = segmentationModeFlags.markers;

            const sanitizedVideoKeywords = sanitizeSegmentationKeywordList(
                tempSettings.segmentationAutoVideoKeywords,
                settings.segmentationAutoVideoKeywords || defaultSettings.segmentationAutoVideoKeywords
            );
            tempSettings.segmentationAutoVideoKeywords = sanitizedVideoKeywords;
            settings.segmentationAutoVideoKeywords = sanitizedVideoKeywords;

            const sanitizedMarkerPattern = sanitizeSegmentationKeywordList(
                tempSettings.segmentationMarkerPattern,
                settings.segmentationMarkerPattern || defaultSettings.segmentationMarkerPattern,
                { allowEmpty: true }
            );
            tempSettings.segmentationMarkerPattern = sanitizedMarkerPattern;
            settings.segmentationMarkerPattern = sanitizedMarkerPattern;

            const sanitizedSegmentationPriority = sanitizeSegmentationPriority(
                tempSettings.segmentationAutodetectPriority,
                settings.segmentationAutodetectPriority || defaultSettings.segmentationAutodetectPriority
            );
            tempSettings.segmentationAutodetectPriority = sanitizedSegmentationPriority;
            settings.segmentationAutodetectPriority = sanitizedSegmentationPriority;

            const sanitizedSegmentationDisplayMode = sanitizeSegmentationDisplayMode(
                tempSettings.segmentationDisplayMode,
                settings.segmentationDisplayMode || defaultSettings.segmentationDisplayMode
            );
            tempSettings.segmentationDisplayMode = sanitizedSegmentationDisplayMode;
            settings.segmentationDisplayMode = sanitizedSegmentationDisplayMode;

            const sanitizedSegmentationAutoSwitch = sanitizeSegmentationAutoSwitchMode(
                tempSettings.segmentationAutoSwitchMode,
                settings.segmentationAutoSwitchMode || defaultSettings.segmentationAutoSwitchMode
            );
            tempSettings.segmentationAutoSwitchMode = sanitizedSegmentationAutoSwitch;
            settings.segmentationAutoSwitchMode = sanitizedSegmentationAutoSwitch;

            const manualSegmentationEnabled = tempSettings.segmentationManualEnabled === true;
            tempSettings.segmentationManualEnabled = manualSegmentationEnabled;
            settings.segmentationManualEnabled = manualSegmentationEnabled;
            setManualSegmentationEnabled(manualSegmentationEnabled, { reason: 'settings_apply' });

            const manualDefaultDuration = sanitizeManualDefaultDurationMinutes(
                tempSettings.manualSegmentDefaultDurationMinutes,
                defaultSettings.manualSegmentDefaultDurationMinutes
            );
            tempSettings.manualSegmentDefaultDurationMinutes = manualDefaultDuration;
            settings.manualSegmentDefaultDurationMinutes = manualDefaultDuration;
            if (manualDefaultDurationInput && manualDefaultDurationInput.length) {
                manualDefaultDurationInput.val(manualDefaultDuration);
            }
            if (typeof document !== 'undefined') {
                try {
                    document.dispatchEvent(new CustomEvent('frzz:manual-default-duration-updated', {
                        detail: { value: manualDefaultDuration }
                    }));
                } catch (err) {
                    console.warn('[Prompter][manualDuration] event dispatch failed', err);
                }
            }

            const sanitizedProgressBarMode = sanitizeProgressBarMode(
                tempSettings.progressBarMode,
                settings.progressBarMode || defaultSettings.progressBarMode
            );
            tempSettings.progressBarMode = sanitizedProgressBarMode;
            settings.progressBarMode = sanitizedProgressBarMode;

            const overlapColorVariants = deriveOverlapColorVariants(tempSettings.highlightOverlapColor);
            tempSettings.highlightOverlapColor = overlapColorVariants.source;
            settings.highlightOverlapColor = overlapColorVariants.source;

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
            $('body').toggleClass('overlap-highlight-disabled', !highlightOverlapEnabled);
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
                clearSubtitleProgress();
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

            updateSegmentationControlsState({
                mode: segmentationModeValue,
                displayMode: sanitizedSegmentationDisplayMode
            });

            // Apply UI scale: baseline 100 => 100% root. Mobile devices receive a multiplier for visual parity.
            let rawScale = tempSettings.uiScale || 100;
            rawScale = Math.min(300, Math.max(50, rawScale));
            rawScale = Math.round((rawScale - 50)/25)*25 + 50; if(rawScale>300) rawScale=300;
            const percent = rawScale; // direct mapping
            let effectivePercent = percent;
            if (isLikelyMobileDevice) {
                effectivePercent = Math.max(50, Math.round(percent * MOBILE_UI_SCALE_MULTIPLIER));
            }
            $('html').css('font-size', effectivePercent + '%').removeClass('ui-scale-clamped');
            
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
            const overlapOutlineColor = highlightOverlapEnabled ? overlapColorVariants.outline : 'transparent';
            const overlapStripeColor = highlightOverlapEnabled ? overlapColorVariants.stripe : 'transparent';
            const overlapStripeOpacity = highlightOverlapEnabled ? '1' : '0';
            let overlapFillColor = highlightOverlapEnabled ? 'rgba(255, 112, 67, 0.08)' : 'transparent';
            if (highlightOverlapEnabled) {
                const parsedSource = parseColorToRgba(overlapColorVariants.source);
                if (parsedSource) {
                    const fillAlpha = clampNumber((Number.isFinite(parsedSource.a) ? parsedSource.a : 1) * 0.18, 0.04, 0.35);
                    overlapFillColor = rgbaToCss({ ...parsedSource, a: fillAlpha });
                }
            }
            styleText += `:root { --frzz-overlap-outline: ${overlapOutlineColor}; --frzz-overlap-fill: ${overlapFillColor}; --frzz-overlap-stripe: ${overlapStripeColor}; --frzz-overlap-stripe-opacity: ${overlapStripeOpacity}; }`;
            
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
            invalidateAllLinePaint();
            if (Array.isArray(subtitleData) && subtitleData.length) {
                computeAndApplyOverlaps({ reason: 'settings_update' });
            }
            console.debug('[Prompter][applySettings] done');
            updateJumpControlsState(tempSettings.jumpOnClickEnabled);
            updateProjectSettingsButtonVisibility({ reason: 'settings_apply_final' });
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

        const segmentationEnabledValue = s.segmentationEnabled !== false;
        const segmentationVideoEnabledValue = s.segmentationAutoVideoEnabled !== false;
        const segmentationMarkersEnabledValue = s.segmentationAutoMarkersEnabled !== false;
        const segmentationModeValue = deriveSegmentationModeFromFlags(
            segmentationEnabledValue,
            segmentationVideoEnabledValue,
            segmentationMarkersEnabledValue
        );
        const segmentationDisplayModeValue = sanitizeSegmentationDisplayMode(
            s.segmentationDisplayMode,
            defaultSettings.segmentationDisplayMode
        );
        const segmentationPriorityValue = sanitizeSegmentationPriority(
            s.segmentationAutodetectPriority,
            defaultSettings.segmentationAutodetectPriority
        );
        const segmentationAutoSwitchValue = sanitizeSegmentationAutoSwitchMode(
            s.segmentationAutoSwitchMode,
            defaultSettings.segmentationAutoSwitchMode
        );
        if (segmentationModeSelect.length) {
            ensureSelectValue(segmentationModeSelect, segmentationModeValue);
        }
        if (segmentationDisplayModeSelect.length) {
            ensureSelectValue(segmentationDisplayModeSelect, segmentationDisplayModeValue);
        }
        if (segmentationPrioritySelect.length) {
            ensureSelectValue(segmentationPrioritySelect, segmentationPriorityValue);
        }
        if (segmentationAutoSwitchSelect.length) {
            ensureSelectValue(segmentationAutoSwitchSelect, segmentationAutoSwitchValue);
        }
        if (segmentationVideoKeywordsInput.length) {
            segmentationVideoKeywordsInput.val(
                sanitizeSegmentationKeywordList(
                    s.segmentationAutoVideoKeywords,
                    defaultSettings.segmentationAutoVideoKeywords
                )
            );
        }
        if (segmentationMarkerPatternInput.length) {
            segmentationMarkerPatternInput.val(
                sanitizeSegmentationKeywordList(
                    s.segmentationMarkerPattern,
                    defaultSettings.segmentationMarkerPattern,
                    { allowEmpty: true }
                )
            );
        }
        if (segmentationManualToggle && segmentationManualToggle.length) {
            segmentationManualToggle.prop('checked', s.segmentationManualEnabled === true);
        }
        if (manualDefaultDurationInput && manualDefaultDurationInput.length) {
            manualDefaultDurationInput.val(
                sanitizeManualDefaultDurationMinutes(
                    s.manualSegmentDefaultDurationMinutes,
                    defaultSettings.manualSegmentDefaultDurationMinutes
                )
            );
        }
        setManualSegmentationEnabled(s.segmentationManualEnabled === true, { reason: 'settings_ui_sync', refresh: false, force: true });
        updateProjectSettingsButtonVisibility({ reason: 'settings_ui_sync' });
        updateSegmentationControlsState({
            mode: segmentationModeValue,
            displayMode: segmentationDisplayModeValue
        });

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
        FILTER_STATE_KEYS.forEach(key => { delete settingsForFile[key]; });
        const settingsSnapshot = JSON.parse(JSON.stringify(settingsForFile));
        const settingsPayload = {};
        if (Object.keys(settingsSnapshot).length > 0) {
            settingsPayload.settingsData = [settingsSnapshot];
        }
        const settingsString = JSON.stringify(settingsPayload, null, 2);
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
        let fileSettingsPayload = null;
        try {
            const resp = await fetch('settings.json?_ts=' + Date.now(), { cache: 'no-store' });
            if (resp.ok) {
                fileSettingsPayload = await resp.json();
                console.debug('[Prompter][loadSettings] Loaded settings.json');
            } else {
                console.debug('[Prompter][loadSettings] settings.json not found (status', resp.status, ') using defaults');
            }
        } catch(fetchErr) {
            console.debug('[Prompter][loadSettings] settings.json fetch error, using defaults:', fetchErr);
        }
        try {
            const extractedSettings = (() => {
                if (!fileSettingsPayload || typeof fileSettingsPayload !== 'object') {
                    return null;
                }
                if (Array.isArray(fileSettingsPayload.settingsData) || Array.isArray(fileSettingsPayload.projectData) || Array.isArray(fileSettingsPayload.templatesData)) {
                    return mergeDataArray(fileSettingsPayload.settingsData);
                }
                return { ...fileSettingsPayload };
            })();
            const fileContainsFilterState = FILTER_STATE_KEYS.some(key => extractedSettings && Object.prototype.hasOwnProperty.call(extractedSettings, key));
            if (extractedSettings) {
                settings = { ...defaultSettings, ...extractedSettings };
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

            if (fileSettingsPayload && (migrationMeta.changed || fileContainsFilterState)) {
                const persistReason = migrationMeta.changed ? 'migration' : 'filter_state_relocation';
                persistSettingsToBackend(settings, { reason: persistReason, deferMs: 200 });
                console.info('[Prompter][loadSettings] persisted settings cleanup', {
                    reason: persistReason,
                    fromSchema: migrationMeta.migratedFrom,
                    legacySchema: migrationMeta.legacySchema,
                    filterStateRemoved: fileContainsFilterState
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
            const previousSegmentationState = buildSegmentationRequestState(settings);
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

            settingsToSave.segmentationEnabled = settingsToSave.segmentationEnabled !== false;
            settingsToSave.segmentationAutoVideoEnabled = settingsToSave.segmentationAutoVideoEnabled !== false;
            settingsToSave.segmentationAutoMarkersEnabled = settingsToSave.segmentationAutoMarkersEnabled !== false;
            settingsToSave.segmentationManualEnabled = settingsToSave.segmentationManualEnabled === true;

            if (!settingsToSave.segmentationAutoVideoKeywords || !settingsToSave.segmentationAutoVideoKeywords.trim()) {
                settingsToSave.segmentationAutoVideoKeywords = settings.segmentationAutoVideoKeywords || defaultSettings.segmentationAutoVideoKeywords;
            } else {
                settingsToSave.segmentationAutoVideoKeywords = sanitizeSegmentationKeywordList(
                    settingsToSave.segmentationAutoVideoKeywords,
                    defaultSettings.segmentationAutoVideoKeywords
                );
            }

            settingsToSave.segmentationMarkerPattern = sanitizeSegmentationKeywordList(
                settingsToSave.segmentationMarkerPattern,
                settings.segmentationMarkerPattern || defaultSettings.segmentationMarkerPattern,
                { allowEmpty: true }
            );

            settingsToSave.segmentationAutodetectPriority = sanitizeSegmentationPriority(
                settingsToSave.segmentationAutodetectPriority,
                settings.segmentationAutodetectPriority || defaultSettings.segmentationAutodetectPriority
            );

            settingsToSave.segmentationDisplayMode = sanitizeSegmentationDisplayMode(
                settingsToSave.segmentationDisplayMode,
                settings.segmentationDisplayMode || defaultSettings.segmentationDisplayMode
            );

            settingsToSave.segmentationAutoSwitchMode = sanitizeSegmentationAutoSwitchMode(
                settingsToSave.segmentationAutoSwitchMode,
                settings.segmentationAutoSwitchMode || defaultSettings.segmentationAutoSwitchMode
            );

            let segmentationModeValue;
            if (segmentationModeSelect.length) {
                segmentationModeValue = sanitizeSegmentationMode(segmentationModeSelect.val());
            } else {
                segmentationModeValue = deriveSegmentationModeFromFlags(
                    settingsToSave.segmentationEnabled !== false,
                    settingsToSave.segmentationAutoVideoEnabled !== false,
                    settingsToSave.segmentationAutoMarkersEnabled !== false
                );
            }
            const segmentationModeFlags = mapSegmentationModeToFlags(segmentationModeValue);
            settingsToSave.segmentationEnabled = segmentationModeFlags.enabled;
            settingsToSave.segmentationAutoVideoEnabled = segmentationModeFlags.video;
            settingsToSave.segmentationAutoMarkersEnabled = segmentationModeFlags.markers;

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

            const nextSegmentationState = buildSegmentationRequestState(settings);
            const segmentationChanged = segmentationRequestStatesDiffer(previousSegmentationState, nextSegmentationState);

            // Determine whether we really need full subtitle re-render
            const impactingKeys = [
                'processRoles','roleDisplayStyle','enableColorSwatches','ignoreProjectItemColors','checkerboardEnabled','checkerboardMode',
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

            if (segmentationChanged) {
                console.info('[Prompter][saveSettings] segmentation settings changed, refreshing project data');
                projectDataReady = false;
                projectDataRetryAttempt = 0;
                clearProjectDataRetryTimer();
                if (statusIndicator && statusIndicator.length) {
                    statusIndicator.text('Обновление сегментации...');
                }
                getProjectData('settings_segmentation_refresh', { allowCache: false, forceReload: true })
                    .catch(err => {
                        console.warn('[Prompter][saveSettings] segmentation refresh failed', err);
                        scheduleProjectDataRetry('settings_segmentation_retry');
                    });
            }
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

    function mergeDataArray(entries) {
        const merged = {};
        if (!entries) {
            return merged;
        }
        if (Array.isArray(entries)) {
            entries.forEach(entry => {
                if (!entry || typeof entry !== 'object') {
                    return;
                }
                Object.keys(entry).forEach(key => {
                    merged[key] = entry[key];
                });
            });
            return merged;
        }
        if (typeof entries === 'object') {
            Object.keys(entries).forEach(key => {
                merged[key] = entries[key];
            });
        }
        return merged;
    }

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
        cancelScheduledRolesAutosave();
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

    function cancelScheduledRolesAutosave() {
        if (rolesAutosaveTimer !== null) {
            clearTimeout(rolesAutosaveTimer);
            rolesAutosaveTimer = null;
            rolesAutosaveReason = '';
        }
    }

    function scheduleRolesAutosave(reason = 'filters_updated', delayMs = ROLES_AUTOSAVE_DEBOUNCE_MS) {
        if (isEmuMode()) {
            return;
        }
        const timeout = Number.isFinite(delayMs) ? Math.max(120, delayMs) : ROLES_AUTOSAVE_DEBOUNCE_MS;
        cancelScheduledRolesAutosave();
        rolesAutosaveReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'filters_updated';
        rolesAutosaveTimer = setTimeout(() => {
            const triggerReason = rolesAutosaveReason;
            rolesAutosaveTimer = null;
            rolesAutosaveReason = '';
            saveRoles(triggerReason);
        }, timeout);
    }

    function saveRoles(reason){
        cancelScheduledRolesAutosave();
        try {
            const filterSoloRoles = normalizeFilterList(settings.filterSoloRoles);
            const filterMuteRoles = normalizeFilterList(settings.filterMuteRoles);
            const filterSoloActors = normalizeFilterList(settings.filterSoloActors);
            const filterMuteActors = normalizeFilterList(settings.filterMuteActors);
            const filtersSnapshot = {};
            if (filterSoloRoles.length) filtersSnapshot.soloRoles = filterSoloRoles;
            if (filterMuteRoles.length) filtersSnapshot.muteRoles = filterMuteRoles;
            if (filterSoloActors.length) filtersSnapshot.soloActors = filterSoloActors;
            if (filterMuteActors.length) filtersSnapshot.muteActors = filterMuteActors;

            const projectSnapshot = {
                actorRoleMappingText: settings.actorRoleMappingText || '',
                actorColors: settings.actorColors || {}
            };
            if (Object.keys(filtersSnapshot).length > 0) {
                projectSnapshot.filters = filtersSnapshot;
            }
            const manualSegmentationSnapshot = buildManualSegmentationProjectDataEntry();
            const manualSegmentsForSave = manualSegmentationSnapshot
                ? manualSegmentationSnapshot.segments.map(segment => ({
                    label: segment.label,
                    startSeconds: segment.startSeconds,
                    endSeconds: segment.endSeconds,
                    hasExplicitEnd: segment.hasExplicitEnd,
                    ordinal: segment.ordinal,
                    uid: segment.uid
                }))
                : [];
            projectSnapshot.manualSegments = manualSegmentsForSave;

            const rolesPayload = {
                projectData: [projectSnapshot]
            };
            console.debug('[Prompter][roles][saveRoles] payload snapshot', {
                manualSegmentation: manualSegmentationSnapshot,
                manualSegmentsCount: manualSegmentsForSave.length
            });
            const jsonPretty = JSON.stringify(rolesPayload, null, 2);
            try {
                updateProjectDataCacheWithRolesSnapshot(jsonPretty, manualSegmentsForSave);
            } catch (cacheErr) {
                console.warn('[Prompter][roles][saveRoles] cache sync failed', cacheErr);
            }
            const b64url = '__B64__' + rolesToBase64Url(jsonPretty);
            const parts = chunkString(b64url, ROLES_CHUNK_SIZE);
            console.debug('[Prompter][roles][saveRoles] encoded', {
                encoded_len: b64url.length,
                decoded_len: jsonPretty.length,
                chunks: parts.length,
                manualSegments: manualSegmentsForSave.length,
                manualSegmentationEnabled: manualSegmentationSnapshot ? manualSegmentationSnapshot.enabled : false,
                reason: reason || 'unspecified'
            });
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
            roles: false,
            segmentation: false
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
        let preserveSegmentSelection = false;
        if (Object.prototype.hasOwnProperty.call(snapshot, 'segmentation')) {
            projectSegmentationInfo = sanitizeProjectSegmentationSnapshot(snapshot.segmentation);
            const manualActive = isManualSegmentationActive();
            const hasAutoSegments = projectSegmentationInfo.mode !== 'none';
            applied.segmentation = manualActive || hasAutoSegments;
            preserveSegmentSelection = applied.segmentation;
        } else {
            projectSegmentationInfo = createDefaultProjectSegmentationInfo();
            const manualActive = isManualSegmentationActive();
            applied.segmentation = manualActive;
            preserveSegmentSelection = manualActive;
        }
        refreshStatsSegmentationControls({ preserveSelection: preserveSegmentSelection, recalcIfVisible: true });
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
                    markProjectDataReady();
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
            markProjectDataReady();
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
            const segmentationRequestState = transmitSegmentationRequestToBackend(`project_data:${reason}:attempt${attempt}`);
            if (segmentationRequestState && segmentationRequestState.mode !== 'none') {
                console.debug('[Prompter][projectData] segmentation request ready', segmentationRequestState);
            }
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
            markProjectDataReady();
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

            const projectDataMap = mergeDataArray(parsed.projectData);
            let manualSegmentationSection = projectDataMap.manualSegmentation;
            if (!manualSegmentationSection && parsed.manualSegmentation && typeof parsed.manualSegmentation === 'object') {
                manualSegmentationSection = parsed.manualSegmentation;
            }
            let manualSegmentsLegacy = Array.isArray(projectDataMap.manualSegments) ? projectDataMap.manualSegments : null;
            if (!manualSegmentsLegacy && Array.isArray(parsed.manualSegments)) {
                manualSegmentsLegacy = parsed.manualSegments;
            }
            let manualSegmentationApplied = false;
            if (manualSegmentationSection && typeof manualSegmentationSection === 'object') {
                const applyInfo = applyManualSegmentationProjectDataSection(manualSegmentationSection, { reason: 'roles_project_data' });
                manualSegmentationApplied = applyInfo && applyInfo.applied === true;
            } else if (Array.isArray(manualSegmentsLegacy)) {
                const legacyInfo = applyManualSegmentsFromProjectData(manualSegmentsLegacy, { reason: 'roles_project_data_legacy' });
                manualSegmentationApplied = legacyInfo && legacyInfo.applied === true;
                if (manualSegmentationApplied) {
                    refreshManualSegmentationProjectDataSnapshot();
                    setManualSegmentationEnabled(true, { reason: 'roles_project_data_legacy' });
                }
            }
            const settingsDataMap = mergeDataArray(parsed.settingsData);
            const templatesData = Array.isArray(parsed.templatesData) ? parsed.templatesData : [];

            const mappingText = typeof projectDataMap.actorRoleMappingText === 'string'
                ? projectDataMap.actorRoleMappingText
                : (typeof settingsDataMap.actorRoleMappingText === 'string'
                    ? settingsDataMap.actorRoleMappingText
                    : (typeof parsed.actorRoleMappingText === 'string' ? parsed.actorRoleMappingText : ''));
            const actorColorsSource = (projectDataMap.actorColors && typeof projectDataMap.actorColors === 'object')
                ? projectDataMap.actorColors
                : ((settingsDataMap.actorColors && typeof settingsDataMap.actorColors === 'object')
                    ? settingsDataMap.actorColors
                    : ((parsed.actorColors && typeof parsed.actorColors === 'object') ? parsed.actorColors : {}));

            settings.actorRoleMappingText = mappingText;
            settings.actorColors = { ...actorColorsSource };

            const filtersProjectSection = (projectDataMap.filters && typeof projectDataMap.filters === 'object') ? projectDataMap.filters : null;
            const filtersSettingsSection = (settingsDataMap.filters && typeof settingsDataMap.filters === 'object') ? settingsDataMap.filters : null;
            const filtersLegacySection = (parsed.filters && typeof parsed.filters === 'object') ? parsed.filters : null;

            const restoredSoloRoles = normalizeFilterList(
                projectDataMap.filterSoloRoles ??
                (filtersProjectSection ? (filtersProjectSection.soloRoles ?? filtersProjectSection.filterSoloRoles) : undefined) ??
                (filtersSettingsSection ? (filtersSettingsSection.soloRoles ?? filtersSettingsSection.filterSoloRoles) : undefined) ??
                (filtersLegacySection ? (filtersLegacySection.soloRoles ?? filtersLegacySection.filterSoloRoles) : undefined) ??
                parsed.filterSoloRoles
            );
            const restoredMuteRoles = normalizeFilterList(
                projectDataMap.filterMuteRoles ??
                (filtersProjectSection ? (filtersProjectSection.muteRoles ?? filtersProjectSection.filterMuteRoles) : undefined) ??
                (filtersSettingsSection ? (filtersSettingsSection.muteRoles ?? filtersSettingsSection.filterMuteRoles) : undefined) ??
                (filtersLegacySection ? (filtersLegacySection.muteRoles ?? filtersLegacySection.filterMuteRoles) : undefined) ??
                parsed.filterMuteRoles
            );
            const restoredSoloActors = normalizeFilterList(
                projectDataMap.filterSoloActors ??
                (filtersProjectSection ? (filtersProjectSection.soloActors ?? filtersProjectSection.filterSoloActors) : undefined) ??
                (filtersSettingsSection ? (filtersSettingsSection.soloActors ?? filtersSettingsSection.filterSoloActors) : undefined) ??
                (filtersLegacySection ? (filtersLegacySection.soloActors ?? filtersLegacySection.filterSoloActors) : undefined) ??
                parsed.filterSoloActors
            );
            const restoredMuteActors = normalizeFilterList(
                projectDataMap.filterMuteActors ??
                (filtersProjectSection ? (filtersProjectSection.muteActors ?? filtersProjectSection.filterMuteActors) : undefined) ??
                (filtersSettingsSection ? (filtersSettingsSection.muteActors ?? filtersSettingsSection.filterMuteActors) : undefined) ??
                (filtersLegacySection ? (filtersLegacySection.muteActors ?? filtersLegacySection.filterMuteActors) : undefined) ??
                parsed.filterMuteActors
            );
            settings.filterSoloRoles = restoredSoloRoles;
            settings.filterMuteRoles = restoredMuteRoles;
            settings.filterSoloActors = restoredSoloActors;
            settings.filterMuteActors = restoredMuteActors;
            updateFilterRuntimeFromSettings();

            const mappedRolesCount = buildActorRoleMaps();
            const actorColorsCount = Object.keys(settings.actorColors || {}).length;
            const hasMappingText = mappingText.trim().length > 0;
            rolesLoaded = mappedRolesCount > 0 || actorColorsCount > 0 || hasMappingText;

            const manualSegmentsCount = getManualSegmentationSegments().length;
            console.info('[Prompter][roles][integrateLoadedRoles] parsed', {
                hasMappingText,
                mappedRoles: mappedRolesCount,
                actorColors: actorColorsCount,
                filters: {
                    soloRoles: settings.filterSoloRoles.length,
                    muteRoles: settings.filterMuteRoles.length,
                    soloActors: settings.filterSoloActors.length,
                    muteActors: settings.filterMuteActors.length
                },
                manualSegmentationApplied,
                manualSegments: manualSegmentsCount,
                structured: {
                    projectEntries: Array.isArray(parsed.projectData) ? parsed.projectData.length : (Object.keys(projectDataMap).length > 0 ? 1 : 0),
                    settingsEntries: Array.isArray(parsed.settingsData) ? parsed.settingsData.length : (Object.keys(settingsDataMap).length > 0 ? 1 : 0),
                    templatesEntries: templatesData.length
                },
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
            projectDataReady = false;
            projectDataRetryAttempt = 0;
            clearProjectDataRetryTimer();
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
            getProjectData('initialize', { allowCache: false, forceReload: true })
                .then(() => {
                    markProjectDataReady();
                })
                .catch(err => {
                    console.error('[Prompter] failed to refresh project data on init', err);
                    scheduleProjectDataRetry('initialize_retry');
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
            lastLineLookaheadIndex = -1;
            if (textDisplayEl) { textDisplayEl.textContent = ''; }
            else { textDisplay.empty(); }
            clearSubtitleProgress();
            clearTimecodeProgress();
            disconnectVisibilityObserver();
            resetVisibilityTracking();
            clearContentVisibilityOverrides();
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
            subtitleOverlapIndicators = new Array(total);
            subtitleOverlapInfo = new Array(total);
            overlapGroups = [];
            subtitleProgressContainers = new Array(total);
            subtitleProgressBars = new Array(total);
            subtitleProgressValues = new Array(total).fill(0);
            activeSubtitleProgressIndices = new Set();
            activeLineIndices = [];
            activeTimecodeProgressIndices = new Set();
            timecodeProgressValues = new Array(total).fill(0);
            activeOverlapBlocks = [];
            activeOverlapBlockMap.clear();
            activeOverlapLineIndices = [];
            pendingOverlapRefreshIndices = new Set();
            overlapRefreshScheduled = false;
            latestOverlapSummary = null;
            if (total === 0) {
                subtitleTimeElements = [];
                subtitleTimeLabelElements = [];
                subtitleTimeProgressElements = [];
                subtitleFilterStates = [];
                subtitleOverlapIndicators = [];
                subtitleOverlapInfo = [];
                overlapGroups = [];
                subtitleProgressContainers = [];
                subtitleProgressBars = [];
                subtitleProgressValues = [];
                timecodeProgressValues = [];
                activeOverlapBlocks = [];
                activeOverlapBlockMap.clear();
                activeOverlapLineIndices = [];
                pendingOverlapRefreshIndices = new Set();
                overlapRefreshScheduled = false;
                latestOverlapSummary = null;
                lastLineLookaheadIndex = -1;
                invalidateAllLinePaint();
                finalizeDataModelUpdate();
                computeAndApplyOverlaps({ reason: 'data_empty' });
                scheduleContentVisibilityUpdate({ force: true });
                updateActorRoleImportVisibility();
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
            const hasActorMapping = roleMappingSize > 0;
            const ignoreProjectItemColors = settings.ignoreProjectItemColors !== false;
            const shouldIgnoreLineColors = hasActorMapping && ignoreProjectItemColors;
            const actorColorsMap = settings.actorColors || {};
            const configuredFrameRate = Number(settings.frameRate);
            const frameRate = Number.isFinite(configuredFrameRate) && configuredFrameRate > 0 ? configuredFrameRate : 24;
            const effectiveFormat = getEffectiveTimecodeFormat();
            const useActorMapping = hasActorMapping;
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
                timeElement.appendChild(timeLabelElement);
                subtitleTimeElements[index] = timeElement;
                subtitleTimeLabelElements[index] = timeLabelElement;
                subtitleTimeProgressElements[index] = null;
                subtitleOverlapIndicators[index] = null;

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

                const roleLookupKey = role ? role.toUpperCase() : '';
                const actor = roleLookupKey && useActorMapping ? roleToActor[roleLookupKey] || null : null;
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

                if (separatorElement) {
                    separatorElement.style.backgroundColor = '';
                }

                const colorInfo = (shouldColorRole || shouldColorColumnSwatch || shouldColorInlineSwatch || separatorElement) ? {
                    color: finalRoleColorCandidate || null,
                    roleElement: shouldColorRole ? roleElement : null,
                    columnSwatch: shouldColorColumnSwatch ? swatchElement : null,
                    inlineSwatch: shouldColorInlineSwatch ? swatchElement : null,
                    separator: separatorElement || null
                } : null;

                let meta = null;
                if (checkerboardClass || colorInfo) {
                    meta = {
                        checkerboardClass: checkerboardClass || '',
                        checkerboardApplied: false,
                        colorInfo,
                        colorApplied: false
                    };
                }
                if (meta) {
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
                    roleId: roleLookupKey || null,
                    actorId: actor || null,
                    roleBaseColor: finalRoleColorCandidate || null,
                    actorColor,
                    lineColor,
                    resolvedColor: finalRoleColorCandidate || null
                });
                subtitleFilterStates[index] = {
                    roleId: roleLookupKey || null,
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
                subtitleProgressContainers[index] = null;
                subtitleProgressBars[index] = null;
                subtitleProgressValues[index] = 0;
                container.appendChild(contentElement);
                fragment.appendChild(container);
            }
            const tBuild1 = performance.now();
            finalizeDataModelUpdate();
            const tAppend0 = performance.now();
            displayNode.appendChild(fragment);
            const tAppend1 = performance.now();
            setupVisibilityObserver();
            invalidateAllLinePaint();
            computeAndApplyOverlaps({ reason: 'data_load' });
            const t1 = performance.now();
            const renderMs = t1 - t0;
            const renderSeconds = renderMs / 1000;
            statusIndicator.text(`Субтитры загружены, всего ${subtitleData.length} реплик`);
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
            scheduleContentVisibilityUpdate({ force: true });
            initialAutoScrollPending = true;
            updateActorRoleImportVisibility();
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
        // Support pasted table rows (tabs or multi-space separated columns) and
        // normalize all actor/role strings to UPPER CASE (caps) as requested.
        const sourceText = String(rawText || '');
        const lines = sourceText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const delimiterFrequency = new Map();
        const parsedLines = [];
        let validEntryCount = 0;
        let autoValidCount = 0;
        let pendingActorContinuation = null;
        for (const line of lines) {
            // Table-like pasted rows often have tabs between columns
            let actor = '';
            let rolesPart = '';
            let delimiter = 'auto';
            let usedContinuation = false;

            if (pendingActorContinuation) {
                const trimmed = line.trim();
                const looksLikeActorLine = trimmed.includes(':');
                if (!looksLikeActorLine) {
                    actor = pendingActorContinuation.actor;
                    rolesPart = line;
                    delimiter = pendingActorContinuation.delimiter || 'auto';
                    usedContinuation = true;
                }
                pendingActorContinuation = null;
            }

            if (!usedContinuation && line.indexOf('\t') !== -1) {
                const parts = line.split(/\t+/).map(p => p.trim()).filter(Boolean);
                if (parts.length >= 2) {
                    actor = parts[0];
                    rolesPart = parts.slice(1).join(', ');
                    delimiter = '\t';
                }
            }
            // Also treat two-or-more spaces as a possible column separator
            if (!actor && !usedContinuation) {
                const colsMatch = line.match(/^(.+?)\s{2,}(.+)$/);
                if (colsMatch) {
                    actor = colsMatch[1].trim();
                    rolesPart = colsMatch[2].trim();
                    delimiter = '  ';
                }
            }

            const tokens = (!actor) ? line.split(/\s+/).filter(Boolean) : rolesPart.split(/\s+/).filter(Boolean);
            if (!tokens.length) {
                parsedLines.push({ actor: '', roles: [], delimiter });
                continue;
            }

            if (!actor) {
                const colonMatch = line.match(/^(.+?)\:\s*(.*)$/);
                if (colonMatch) {
                    const processed = splitActorAndPromotedRoles((colonMatch[1] || '').trim(), (colonMatch[2] || '').trim(), { keepShortTokens: false, allowLongUppercaseActorTokens: true });
                    actor = processed.actor;
                    rolesPart = processed.rolesPart;
                    delimiter = ':';
                    if (!rolesPart) {
                        pendingActorContinuation = { actor, delimiter: delimiter || 'auto' };
                        continue;
                    }
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
                            if (actor && (!rolesPart || !rolesPart.trim()) && tokens.length === 2) {
                                actor = tokens[0];
                                rolesPart = tokens.slice(1).join(' ').trim();
                            }
                        }
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

            // Convert to UPPER CASE for both actor and roles
            const actorCaps = String(actor || '').trim().toUpperCase();
            const rolesCaps = roles.map(r => String(r).trim().toUpperCase()).filter(Boolean);

            parsedLines.push({ actor: actorCaps, roles: rolesCaps, delimiter });
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
        const mappingText = typeof settings.actorRoleMappingText === 'string' ? settings.actorRoleMappingText : '';
        if (mappingText !== cachedActorRoleMappingText) {
            roleToActor = {};
            actorToRoles = {};
            const parsed = parseActorRoleMapping(mappingText);
            Object.keys(parsed).forEach(actor => {
                const actorKey = String(actor || '').toUpperCase();
                if (!actorKey) return;
                const roles = Array.isArray(parsed[actor]) ? parsed[actor] : [];
                const roleSet = new Set();
                roles.forEach(role => {
                    const roleKey = String(role || '').toUpperCase();
                    if (!roleKey) return;
                    roleSet.add(roleKey);
                    if (!roleToActor[roleKey]) {
                        roleToActor[roleKey] = actorKey; // first mapping wins
                    }
                });
                if (roleSet.size > 0) {
                    actorToRoles[actorKey] = roleSet;
                }
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

            const soloRolesSeen = new Set();
            const soloRoles = [];
            normalizeFilterList(settings.filterSoloRoles).forEach(entry => {
                const token = String(entry || '').toUpperCase();
                if (!token || soloRolesSeen.has(token)) return;
                soloRolesSeen.add(token);
                soloRoles.push(token);
            });
            const muteRolesSeen = new Set();
            const muteRoles = [];
            normalizeFilterList(settings.filterMuteRoles).forEach(entry => {
                const token = String(entry || '').toUpperCase();
                if (!token || muteRolesSeen.has(token)) return;
                muteRolesSeen.add(token);
                muteRoles.push(token);
            });
            const soloActorsSeen = new Set();
            const soloActors = [];
            normalizeFilterList(settings.filterSoloActors).forEach(entry => {
                const token = String(entry || '').toUpperCase();
                if (!token || soloActorsSeen.has(token)) return;
                soloActorsSeen.add(token);
                soloActors.push(token);
            });
            const muteActorsSeen = new Set();
            const muteActors = [];
            normalizeFilterList(settings.filterMuteActors).forEach(entry => {
                const token = String(entry || '').toUpperCase();
                if (!token || muteActorsSeen.has(token)) return;
                muteActorsSeen.add(token);
                muteActors.push(token);
            });
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
        const normalized = [];
        const seen = new Set();
        source.forEach(entry => {
            const token = String(entry || '').toUpperCase();
            if (!token || seen.has(token)) return;
            seen.add(token);
            normalized.push(token);
        });
        return new Set(normalized);
    }

    function getSoloActorsSet() {
        const list = Array.isArray(settings.filterSoloActors) ? settings.filterSoloActors : [];
        const filtered = [];
        const seen = new Set();
        list.forEach(entry => {
            const token = String(entry || '').toUpperCase();
            if (!token || seen.has(token)) return;
            seen.add(token);
            filtered.push(token);
        });
        return new Set(filtered);
    }

    function getSoloRolesSet() {
        const list = Array.isArray(settings.filterSoloRoles) ? settings.filterSoloRoles : [];
        const filtered = [];
        list.forEach(entry => {
            const token = String(entry || '').toUpperCase();
            if (!token) return;
            filtered.push(token);
        });
        return new Set(filtered);
    }

    function collectRolesForActors(actorSet) {
        const result = new Set();
        if (!actorSet || typeof actorSet.forEach !== 'function') return result;
        buildActorRoleMaps();
        actorSet.forEach(actor => {
            const actorKey = String(actor || '').toUpperCase();
            if (!actorKey) return;
            const roles = actorToRoles[actorKey];
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
            const actor = readActorKeyFromRow(row);
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
        if (!isEmuMode()) {
            if (options.persistBackend === true) {
                saveRoles(options.reason || 'filters_immediate');
            } else if (options.persistRoles !== false) {
                scheduleRolesAutosave(options.reason || 'filters_update');
            }
        }
        refreshRoleFilterControlsUI();
        refreshActorFilterControlsUI();
    }

    function setActorMuteState(actor, shouldMute) {
        const actorKey = String(actor || '').toUpperCase();
        if (!actorKey) return;
        const muteSet = getMutedActorsSet();
        if (shouldMute) {
            muteSet.add(actorKey);
        } else {
            muteSet.delete(actorKey);
        }
        settings.filterMuteActors = Array.from(muteSet);
        refreshActorFilterControlsUI();
        refreshRoleFilterControlsUI();
    }

    function toggleActorMuteState(actor) {
        const actorKey = String(actor || '').toUpperCase();
        if (!actorKey) return;
        const muteSet = getMutedActorsSet();
        const shouldMute = !muteSet.has(actorKey);
        setActorMuteState(actorKey, shouldMute);
        syncActorFilterSettings({ reason: 'actor_mute_toggle' });
    }

    function setSoloActorsSet(soloSet) {
        const next = [];
        const seen = new Set();
        if (soloSet && typeof soloSet.forEach === 'function') {
            soloSet.forEach(actor => {
                const token = String(actor || '').toUpperCase();
                if (!token || seen.has(token)) return;
                seen.add(token);
                next.push(token);
            });
        }
        settings.filterSoloActors = next;
        refreshActorFilterControlsUI();
    }

    function removeSoloActor(actor) {
        const actorKey = String(actor || '').toUpperCase();
        if (!actorKey) return;
        const soloSet = getSoloActorsSet();
        if (soloSet.delete(actorKey)) {
            setSoloActorsSet(soloSet);
        }
    }

    function toggleActorSoloState(actor) {
        const actorKey = String(actor || '').toUpperCase();
        if (!actorKey) return;
        const soloSet = getSoloActorsSet();
        if (soloSet.has(actorKey)) {
            soloSet.delete(actorKey);
        } else {
            soloSet.add(actorKey);
        }
        setSoloActorsSet(soloSet);
        syncActorFilterSettings({ reason: 'actor_solo_toggle' });
    }

    function setSoloRolesSet(soloSet, options = {}) {
        const next = [];
        const seen = new Set();
        if (soloSet && typeof soloSet.forEach === 'function') {
            soloSet.forEach(role => {
                const token = String(role || '').toUpperCase();
                if (!token || seen.has(token)) return;
                seen.add(token);
                next.push(token);
            });
        }
        settings.filterSoloRoles = next;
        if (options.skipRefresh !== true) {
            refreshRoleFilterControlsUI();
        }
    }

    function toggleRoleSoloState(role) {
        const token = String(role || '').toUpperCase();
        if (!token) return;
        const mutedRoles = collectRolesForActors(getMutedActorsSet());
        if (mutedRoles.has(token)) return;
        const soloSet = getSoloRolesSet();
        if (soloSet.has(token)) {
            soloSet.delete(token);
        } else {
            soloSet.add(token);
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
        if (!actorColorList || !actorColorList.length) return;
        actorColorList.empty();
        buildActorRoleMaps();
        const actors = Object.keys(actorToRoles).sort((a,b)=> a.localeCompare(b,'ru'));
        actors.forEach(actor => {
            const roles = Array.from(actorToRoles[actor]).join(', ');
            const colorVal = (settings.actorColors && settings.actorColors[actor]) || 'rgba(60,60,60,0.6)';
            const row = $(`
                <div class="actor-color-item" data-actor="${actor}">
                    <div class="actor-color-item-label"></div>
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
            row.find('.actor-color-item-label').append(createActorNameElement(actor));
            actorColorList.append(row);
        });
        // Initialize Spectrum on newly added inputs
        actorColorList.find('.actor-color-input').each(function(){
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

    function createActorNameElement(actorKey) {
        const normalized = String(actorKey || '').toUpperCase();
        return $('<span class="actor-name" tabindex="0" role="button"></span>')
            .attr('aria-label', `Переименовать актёра ${normalized}`)
            .attr('title', 'Переименовать актёра')
            .text(normalized);
    }

    function autosizeActorNameEditor(editor) {
        if (!editor || !editor.length) return;
        const el = editor.get(0);
        if (!el) return;
        el.style.height = 'auto';
        const scrollHeight = el.scrollHeight || 0;
        let minHeight = 0;
        try {
            const computed = window.getComputedStyle(el);
            const lineHeight = parseFloat(computed.lineHeight);
            if (Number.isFinite(lineHeight) && lineHeight > 0) {
                minHeight = lineHeight;
            } else {
                const fontSize = parseFloat(computed.fontSize);
                if (Number.isFinite(fontSize) && fontSize > 0) {
                    minHeight = fontSize * 1.2;
                }
            }
        } catch (_) {
            /* ignore compute errors */
        }
        if (!minHeight || !Number.isFinite(minHeight)) {
            minHeight = 24;
        }
        el.style.height = `${Math.max(scrollHeight, minHeight)}px`;
    }

    function replaceActorTokenInArray(source, oldToken, newToken) {
        if (!Array.isArray(source) || !source.length) return source;
        const oldKey = String(oldToken || '').toUpperCase();
        const newKey = String(newToken || '').toUpperCase();
        if (!oldKey || !newKey) return source;
        let changed = false;
        const seen = new Set();
        const result = [];
        source.forEach(entry => {
            if (!entry && entry !== 0) return;
            let token = String(entry).toUpperCase();
            if (token === oldKey) {
                token = newKey;
                changed = true;
            }
            if (seen.has(token)) {
                if (token !== oldKey) {
                    changed = true;
                }
                return;
            }
            seen.add(token);
            result.push(token);
        });
        return changed ? result : source;
    }

    function serializeActorRoleMapping(mapping, actorOrder) {
        if (!mapping || typeof mapping !== 'object') {
            return '';
        }
        const entries = [];
        const seen = new Set();
        const consumeActor = actor => {
            const key = String(actor || '').toUpperCase();
            if (!key || seen.has(key)) {
                return;
            }
            const rolesArray = Array.isArray(mapping[key]) ? mapping[key] : [];
            const roles = rolesArray
                .map(role => String(role || '').toUpperCase().trim())
                .filter(Boolean);
            if (!roles.length) {
                return;
            }
            seen.add(key);
            entries.push(`${key}, ${roles.join(', ')}`);
        };
        if (Array.isArray(actorOrder) && actorOrder.length) {
            actorOrder.forEach(consumeActor);
        }
        Object.keys(mapping).forEach(consumeActor);
        return entries.join('\n\n');
    }

    function applyActorRenameInternal(oldActorKey, newActorName) {
        const oldKey = String(oldActorKey || '').toUpperCase();
        const trimmedNew = String(newActorName || '').trim();
        if (!oldKey || !trimmedNew) {
            return { changed: false, reason: 'invalid' };
        }
        const newKey = trimmedNew.toUpperCase();
        if (newKey === oldKey) {
            return { changed: false, reason: 'same' };
        }
        const rawMapping = settings.actorRoleMappingText || '';
        if (!rawMapping.trim()) {
            return { changed: false, reason: 'empty' };
        }
        const parsedMapping = parseActorRoleMapping(rawMapping);
        if (!parsedMapping[oldKey]) {
            return { changed: false, reason: 'missing' };
        }
        const actorOrder = Object.keys(parsedMapping);
        const oldRoles = Array.isArray(parsedMapping[oldKey]) ? parsedMapping[oldKey].slice() : [];
        delete parsedMapping[oldKey];
        const mergedSet = new Set(Array.isArray(parsedMapping[newKey]) ? parsedMapping[newKey] : []);
        oldRoles.forEach(role => mergedSet.add(role));
        parsedMapping[newKey] = Array.from(mergedSet);
        const oldIndex = actorOrder.indexOf(oldKey);
        if (oldIndex !== -1) {
            actorOrder.splice(oldIndex, 1);
        }
        if (!actorOrder.includes(newKey)) {
            const insertIndex = oldIndex >= 0 ? oldIndex : actorOrder.length;
            actorOrder.splice(insertIndex, 0, newKey);
        }
        const rebuiltText = serializeActorRoleMapping(parsedMapping, actorOrder);
        settings.actorRoleMappingText = rebuiltText;

        const colors = settings.actorColors && typeof settings.actorColors === 'object'
            ? { ...settings.actorColors }
            : {};
        const oldColor = colors[oldKey];
        if (oldKey !== newKey) {
            delete colors[oldKey];
            if (oldColor && !colors[newKey]) {
                colors[newKey] = oldColor;
            }
        }
        settings.actorColors = colors;

        settings.filterMuteActors = replaceActorTokenInArray(settings.filterMuteActors, oldKey, newKey);
        settings.filterSoloActors = replaceActorTokenInArray(settings.filterSoloActors, oldKey, newKey);

        cachedActorRoleMappingText = null;

        return { changed: true, newActor: newKey, rebuiltText };
    }

    function readActorKeyFromRow(row) {
        if (!row || !row.length) return '';
        const attrVal = row.attr('data-actor');
        if (attrVal && typeof attrVal === 'string') {
            return attrVal.trim().toUpperCase();
        }
        const dataVal = row.data('actor');
        if (typeof dataVal === 'string' && dataVal.trim()) {
            return dataVal.trim().toUpperCase();
        }
        return '';
    }

    function beginActorInlineRename(row, nameSpan) {
        if (!row || !row.length) return;
        if (row.attr('data-editing') === 'true') return;
        const actorKey = readActorKeyFromRow(row);
        const displayText = nameSpan && nameSpan.length ? nameSpan.text().trim() : actorKey;
        const editor = $('<textarea class="actor-name-editor" rows="1" spellcheck="false" maxlength="120"></textarea>');
        editor.val(displayText || actorKey);
        if (nameSpan && nameSpan.length) {
            nameSpan.replaceWith(editor);
        } else {
            row.find('.actor-color-item-label').empty().append(editor);
        }
        row.attr('data-editing', 'true');
        requestAnimationFrame(() => {
            editor.trigger('focus');
            const el = editor.get(0);
            if (el && typeof el.setSelectionRange === 'function') {
                const len = editor.val().length;
                el.setSelectionRange(0, len);
            }
            autosizeActorNameEditor(editor);
        });
    }

    function cancelActorInlineRename(row, editor) {
        if (!row || !row.length) return;
        const actorKey = readActorKeyFromRow(row);
        const replacement = createActorNameElement(actorKey);
        if (editor && editor.length) {
            editor.replaceWith(replacement);
        } else {
            row.find('.actor-color-item-label').empty().append(replacement);
        }
        row.removeAttr('data-editing');
    }

    function finalizeActorInlineRename(row, editor, options = {}) {
        if (!row || !row.length) return;
        const oldActorKey = readActorKeyFromRow(row);
        const rawValue = typeof options.newName === 'string' ? options.newName : (editor && editor.length ? editor.val() : '');
        const trimmed = String(rawValue || '').trim();
        if (!trimmed) {
            cancelActorInlineRename(row, editor);
            return;
        }
        const result = applyActorRenameInternal(oldActorKey, trimmed);
        if (!result.changed) {
            cancelActorInlineRename(row, editor);
            row.removeData('renameCanceled');
            return;
        }
        const replacement = createActorNameElement(result.newActor);
        let replaced = false;
        if (editor && editor.length) {
            const editorEl = editor[0];
            const parentNode = editorEl && editorEl.parentNode;
            if (parentNode && parentNode.contains(editorEl)) {
                try {
                    editor.replaceWith(replacement);
                    replaced = true;
                } catch (err) {
                    console.warn('[Prompter][actors] editor replace failed during rename', err);
                }
            }
        }
        if (!replaced) {
            const labelContainer = row && row.length ? row.find('.actor-color-item-label') : $();
            if (labelContainer.length) {
                labelContainer.empty().append(replacement);
                replaced = true;
            }
        }
        row.attr('data-actor', result.newActor);
        row.data('actor', result.newActor);
        row.removeAttr('data-editing');

        if (actorRoleMappingTextarea && actorRoleMappingTextarea.length) {
            actorRoleMappingTextarea.val(result.rebuiltText);
            scheduleActorMappingPreview({ debounce: false });
        } else {
            performActorMappingPreviewRefresh();
        }
        syncActorFilterSettings({ persistBackend: true, reason: 'actor_rename' });
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

    function shouldShowActorRoleImportButton() {
        if (!Array.isArray(subtitleData) || subtitleData.length === 0) {
            return false;
        }
        const seenColors = new Set();
        for (let i = 0; i < subtitleData.length; i += 1) {
            const line = subtitleData[i];
            if (!line || typeof line.color !== 'string') continue;
            const raw = line.color.trim();
            if (!raw) continue;
            seenColors.add(raw.toUpperCase());
            if (seenColors.size > 1) {
                return true;
            }
        }
        return false;
    }

    function updateActorRoleImportVisibility() {
        if (!actorRoleImportButton || !actorRoleImportButton.length) return;
        const wrapper = actorRoleImportButton.closest('.actor-role-import-row');
        const shouldShow = shouldShowActorRoleImportButton();
        const target = wrapper && wrapper.length ? wrapper : actorRoleImportButton;
        target.toggle(shouldShow);
        if (!shouldShow) {
            setActorRoleImportStatus('');
        }
    }

    function setActorRoleImportStatus(message, status) {
        if (!actorRoleImportStatus || !actorRoleImportStatus.length) return;
        if (!message) {
            actorRoleImportStatus.text('');
            actorRoleImportStatus.removeAttr('data-status');
            return;
        }
        actorRoleImportStatus.text(message);
        if (status) {
            actorRoleImportStatus.attr('data-status', status);
        } else {
            actorRoleImportStatus.removeAttr('data-status');
        }
    }

    async function fetchSubtitlesForImportFromFile() {
        if (typeof fetch !== 'function') {
            const err = new Error('Fetch API unavailable');
            err.code = 'FETCH_UNSUPPORTED';
            throw err;
        }
        const stamp = Date.now();
        let url;
        if (isEmuMode()) {
            const sp = new URLSearchParams(window.location.search);
            const subtitleName = normalizeReferencePath(sp.get('subtitle'), 'subtitles');
            url = `reference/${subtitleName}.json?_ts=${stamp}`;
        } else {
            url = `/subtitles.json?_ts=${stamp}`;
        }
        const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) {
            const err = new Error(`HTTP ${response.status}`);
            err.code = 'HTTP_ERROR';
            err.status = response.status;
            throw err;
        }
        const data = await response.json();
        if (!Array.isArray(data)) {
            const err = new Error('Invalid subtitles format');
            err.code = 'INVALID_FORMAT';
            throw err;
        }
        return data;
    }

    async function resolveSubtitlesForImport() {
        try {
            const data = await fetchSubtitlesForImportFromFile();
            return { data, source: 'file', fetchError: null };
        } catch (err) {
            console.warn('[Prompter][roles] subtitles import fallback to in-memory data', err);
            if (Array.isArray(subtitleData) && subtitleData.length > 0) {
                return { data: subtitleData, source: 'memory', fetchError: err };
            }
            const fallbackError = new Error('Subtitles not loaded');
            fallbackError.code = 'NO_SUBTITLES';
            fallbackError.cause = err;
            throw fallbackError;
        }
    }

    function groupRolesByLineColor(subtitles) {
        const colorOrder = [];
        const colorMap = new Map();
        let processedLines = 0;
        let coloredLineCount = 0;
        for (const line of Array.isArray(subtitles) ? subtitles : []) {
            if (!line || typeof line.color !== 'string') continue;
            const rawColor = line.color.trim();
            if (!rawColor) continue;
            coloredLineCount++;
            if (!line.text || typeof line.text !== 'string') continue;
            const extracted = extractLeadingRole(line.text, true);
            if (!extracted || !extracted.role) continue;
            const normalizedRole = extracted.role.trim().toUpperCase();
            if (!normalizedRole) continue;
            processedLines++;
            const colorKey = rawColor.toUpperCase();
            let entry = colorMap.get(colorKey);
            if (!entry) {
                entry = { color: rawColor, rolesSet: new Set(), rolesOrder: [] };
                colorMap.set(colorKey, entry);
                colorOrder.push(colorKey);
            }
            if (!entry.rolesSet.has(normalizedRole)) {
                entry.rolesSet.add(normalizedRole);
                entry.rolesOrder.push(normalizedRole);
            }
        }
        const groups = [];
        const uniqueRoles = new Set();
        colorOrder.forEach((colorKey, index) => {
            const entry = colorMap.get(colorKey);
            if (!entry || entry.rolesOrder.length === 0) return;
            entry.rolesOrder.forEach(role => uniqueRoles.add(role));
            groups.push({
                label: `ГРУППА${index + 1}`,
                roles: entry.rolesOrder.slice(),
                color: entry.color
            });
        });
        return {
            groups,
            uniqueRoleCount: uniqueRoles.size,
            processedLines,
            coloredLineCount
        };
    }

    async function importActorRoleGroupsFromProject() {
        if (!actorRoleImportButton || !actorRoleImportButton.length) return;
        setActorRoleImportStatus('Считываем субтитры...', 'info');
        actorRoleImportButton.prop('disabled', true);
        try {
            const { data, source, fetchError } = await resolveSubtitlesForImport();
            if (!Array.isArray(data) || data.length === 0) {
                setActorRoleImportStatus('Файл субтитров пуст или не создан. Обновите проект и попробуйте снова.', 'error');
                return;
            }
            const grouping = groupRolesByLineColor(data);
            if (!grouping.groups.length) {
                setActorRoleImportStatus('Не удалось найти роли с назначенными цветами.', 'error');
                return;
            }
            const mappingPayload = {};
            const actorOrder = [];
            if (!settings.actorColors) {
                settings.actorColors = {};
            }
            const actorColorAssignments = { ...settings.actorColors };
            grouping.groups.forEach(group => {
                if (!group || !group.label) return;
                const labelKey = typeof group.label === 'string' ? group.label.trim().toUpperCase() : '';
                if (!labelKey) return;
                const rolesList = Array.isArray(group.roles)
                    ? group.roles.map(role => String(role || '').toUpperCase().trim()).filter(Boolean)
                    : [];
                if (rolesList.length) {
                    mappingPayload[labelKey] = rolesList;
                    actorOrder.push(labelKey);
                }
                if (group.color && typeof group.color === 'string') {
                    actorColorAssignments[labelKey] = group.color;
                }
            });
            settings.actorColors = actorColorAssignments;
            const mappingText = serializeActorRoleMapping(mappingPayload, actorOrder);
            settings.actorRoleMappingText = mappingText;
            cachedActorRoleMappingText = null;
            if (actorRoleMappingTextarea && actorRoleMappingTextarea.length) {
                actorRoleMappingTextarea.val(mappingText);
            }
            scheduleActorMappingPreview({ debounce: false });
            updateActorRoleImportVisibility();
            let message = `Импортировано групп: ${grouping.groups.length}. Ролей: ${grouping.uniqueRoleCount}.`;
            if (source === 'memory' && fetchError) {
                message += ' Использованы загруженные субтитры (файл недоступен).';
            }
            setActorRoleImportStatus(message, 'success');
        } catch (err) {
            const code = err && err.code ? err.code : 'UNKNOWN';
            let message = 'Не удалось импортировать карту ролей.';
            if (code === 'NO_SUBTITLES') {
                message = 'Субтитры ещё не загружены. Откройте дорожку и попробуйте снова.';
            } else if (code === 'HTTP_ERROR') {
                message = 'Файл subtitles.json недоступен. Обновите текст в REAPER и повторите попытку.';
            } else if (code === 'INVALID_FORMAT') {
                message = 'Файл subtitles.json имеет некорректный формат.';
            } else if (code === 'FETCH_UNSUPPORTED') {
                message = 'Браузер не поддерживает загрузку файла субтитров.';
            }
            setActorRoleImportStatus(message, 'error');
            console.error('[Prompter][roles] importActorRoleGroupsFromProject failed', err);
        } finally {
            actorRoleImportButton.prop('disabled', false);
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
                if (m && m[1]) {
                    const roleKey = String(m[1]).toUpperCase();
                    if (roleKey) allRoles.add(roleKey);
                }
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
        const rawMapping = actorRoleMappingTextarea && actorRoleMappingTextarea.length ? actorRoleMappingTextarea.val() : '';
        settings.actorRoleMappingText = rawMapping;
        // Collect colors that пользователь явно видел/менял в списке
        const newColors = {};
        $('#actor-color-list .actor-color-item').each(function(){
            const actor = readActorKeyFromRow($(this));
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
            const actor = readActorKeyFromRow($(this));
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

    function resolveActiveLineIndices(currentTime, primaryIndex) {
        if (!Array.isArray(subtitleData) || subtitleData.length === 0) {
            return [];
        }
        if (!Number.isFinite(currentTime)) {
            return [];
        }
        const total = subtitleData.length;
        const resultSet = new Set();

        const addIfActive = (index) => {
            if (!Number.isInteger(index) || index < 0 || index >= total || resultSet.has(index)) {
                return;
            }
            const line = subtitleData[index];
            if (!line) {
                return;
            }
            const start = Number(line.start_time);
            const end = Number(line.end_time);
            if (!Number.isFinite(start) || !Number.isFinite(end)) {
                return;
            }
            if (currentTime >= start && currentTime < end) {
                resultSet.add(index);
            }
        };

        if (Number.isInteger(primaryIndex) && primaryIndex >= 0) {
            addIfActive(primaryIndex);
            const overlapEntry = subtitleOverlapInfo && subtitleOverlapInfo[primaryIndex];
            if (overlapEntry && typeof overlapEntry.groupId === 'number' && overlapGroups && overlapGroups[overlapEntry.groupId]) {
                const group = overlapGroups[overlapEntry.groupId];
                if (group && Array.isArray(group.indices)) {
                    for (let i = 0; i < group.indices.length; i += 1) {
                        addIfActive(group.indices[i]);
                    }
                }
            } else {
                let left = primaryIndex - 1;
                while (left >= 0) {
                    const line = subtitleData[left];
                    if (!line) {
                        left -= 1;
                        continue;
                    }
                    const start = Number(line.start_time);
                    const end = Number(line.end_time);
                    if (!Number.isFinite(start) || !Number.isFinite(end)) {
                        left -= 1;
                        continue;
                    }
                    if (currentTime >= start && currentTime < end) {
                        addIfActive(left);
                        left -= 1;
                        continue;
                    }
                    if (currentTime >= end) {
                        break;
                    }
                    left -= 1;
                }
                let right = primaryIndex + 1;
                while (right < total) {
                    const line = subtitleData[right];
                    if (!line) {
                        right += 1;
                        continue;
                    }
                    const start = Number(line.start_time);
                    const end = Number(line.end_time);
                    if (!Number.isFinite(start) || !Number.isFinite(end)) {
                        right += 1;
                        continue;
                    }
                    if (currentTime >= start && currentTime < end) {
                        addIfActive(right);
                        right += 1;
                        continue;
                    }
                    if (currentTime < start) {
                        break;
                    }
                    right += 1;
                }
            }
        } else {
            let lo = 0;
            let hi = total - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                const line = subtitleData[mid];
                if (!line) {
                    break;
                }
                const start = Number(line.start_time);
                const end = Number(line.end_time);
                if (!Number.isFinite(start) || !Number.isFinite(end)) {
                    break;
                }
                if (currentTime < start) {
                    hi = mid - 1;
                    continue;
                }
                if (currentTime >= end) {
                    lo = mid + 1;
                    continue;
                }
                addIfActive(mid);
                let left = mid - 1;
                while (left >= 0) {
                    const prevLine = subtitleData[left];
                    if (!prevLine) {
                        left -= 1;
                        continue;
                    }
                    const prevStart = Number(prevLine.start_time);
                    const prevEnd = Number(prevLine.end_time);
                    if (!Number.isFinite(prevStart) || !Number.isFinite(prevEnd)) {
                        left -= 1;
                        continue;
                    }
                    if (currentTime >= prevStart && currentTime < prevEnd) {
                        addIfActive(left);
                        left -= 1;
                        continue;
                    }
                    if (currentTime >= prevEnd) {
                        break;
                    }
                    left -= 1;
                }
                let right = mid + 1;
                while (right < total) {
                    const nextLine = subtitleData[right];
                    if (!nextLine) {
                        right += 1;
                        continue;
                    }
                    const nextStart = Number(nextLine.start_time);
                    const nextEnd = Number(nextLine.end_time);
                    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd)) {
                        right += 1;
                        continue;
                    }
                    if (currentTime >= nextStart && currentTime < nextEnd) {
                        addIfActive(right);
                        right += 1;
                        continue;
                    }
                    if (currentTime < nextStart) {
                        break;
                    }
                    right += 1;
                }
                break;
            }
        }

        if (!resultSet.size) {
            return [];
        }
        return Array.from(resultSet).sort((a, b) => a - b);
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
            const autoScrollMode = sanitizeAutoScrollMode(settings.autoScrollMode, defaultSettings.autoScrollMode);
            const isLineAutoScroll = autoScrollEnabled && autoScrollMode === 'line';
            if (!isLineAutoScroll) {
                lastLineLookaheadIndex = -1;
            }
            let autoScrollPlan;
            let autoScrollPlanComputed = false;
            let autoScrollPlanWasUndefined = false;

            const skipLineAutoScrollDueToLookahead = isLineAutoScroll && lastLineLookaheadIndex === newCurrentLineIndex;

            if (indexChanged && newCurrentLineIndex !== -1 && autoScrollEnabled && !skipLineAutoScrollDueToLookahead) {
                const computedPlan = computeAutoScrollPlan(newCurrentLineIndex, {
                    currentTime,
                    instant: initialAutoScrollPending === true
                });
                autoScrollPlanComputed = true;
                if (typeof computedPlan === 'undefined') {
                    autoScrollPlanWasUndefined = true;
                } else {
                    autoScrollPlan = computedPlan;
                }
            }

            const activeIndices = resolveActiveLineIndices(currentTime, newCurrentLineIndex);
            const activeSet = new Set(activeIndices);
            const previousActiveIndices = Array.isArray(activeLineIndices) ? activeLineIndices : [];

            previousActiveIndices.forEach(idx => {
                if (!activeSet.has(idx)) {
                    const element = subtitleElements[idx];
                    if (element) {
                        element.classList.remove('current-line');
                        element.classList.remove('pause-highlight');
                    }
                }
            });

            activeIndices.forEach(idx => {
                const element = subtitleElements[idx];
                if (!element) return;
                const line = subtitleData[idx];
                const start = Number(line && line.start_time);
                const end = Number(line && line.end_time);
                const isActive = Number.isFinite(start) && Number.isFinite(end) && currentTime >= start && currentTime < end;
                if (element.classList) {
                    element.classList.toggle('current-line', highlightCurrentEnabled && isActive);
                    element.classList.remove('pause-highlight');
                    element.classList.remove('previous-line');
                }
            });

            activeLineIndices = activeIndices;

            if (newCurrentLineIndex !== -1) {
                const primaryElement = subtitleElements[newCurrentLineIndex];
                if (primaryElement && primaryElement.classList) {
                    if (inPause) {
                        if (highlightPauseEnabled && !highlightPreviousEnabled) {
                            primaryElement.classList.add('pause-highlight');
                        } else {
                            primaryElement.classList.remove('pause-highlight');
                        }
                        primaryElement.classList.remove('current-line');
                        if (!highlightPreviousEnabled) {
                            primaryElement.classList.remove('previous-line');
                        }
                    } else if (!activeSet.has(newCurrentLineIndex)) {
                        primaryElement.classList.remove('current-line');
                        if (!highlightPauseEnabled) {
                            primaryElement.classList.remove('pause-highlight');
                        }
                    }
                    if (!highlightCurrentEnabled) {
                        primaryElement.classList.remove('current-line');
                    }
                }
            }

            updatePreviousLineHighlightState({
                newCurrentLineIndex,
                previousIndex: oldCurrentIndex,
                inPause,
                highlightPreviousEnabled,
                highlightPauseEnabled,
                indexChanged,
                activeIndices
            });

            if (indexChanged) {
                resetTransportProgress();
                const previousIndex = oldCurrentIndex;
                currentLineIndex = newCurrentLineIndex;
                if (isLineAutoScroll) {
                    lastLineLookaheadIndex = -1;
                }
                try {
                    if (previousIndex !== -1) {
                        if (visibleIndices.has(previousIndex)) {
                            paintLine(previousIndex, true);
                        } else if (subtitlePaintStates && previousIndex < subtitlePaintStates.length) {
                            subtitlePaintStates[previousIndex] = -1;
                        }
                    }
                    if (currentLineIndex !== -1) {
                        if (visibleIndices.has(currentLineIndex)) {
                            paintLine(currentLineIndex, true);
                        } else if (subtitlePaintStates && currentLineIndex < subtitlePaintStates.length) {
                            subtitlePaintStates[currentLineIndex] = -1;
                        }
                    }
                } catch (err) { /* defensive: avoid breaking rAF loop */ }
                if (autoScrollEnabled && currentLineIndex !== -1 && !skipLineAutoScrollDueToLookahead) {
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
                if (initialAutoScrollPending) {
                    initialAutoScrollPending = false;
                }
                resetSubtReaderInertiaState();
            } else {
                if (!useTimecodeProgress && transportProgressValue !== 0) {
                    resetTransportProgress();
                }
                if (autoScrollEnabled && currentLineIndex !== -1 && Number.isFinite(currentTime)) {
                    applySubtReaderInertia(currentLineIndex, currentTime);
                } else {
                    resetSubtReaderInertiaState();
                }
                if (isLineAutoScroll) {
                    const upcomingIndex = (() => {
                        if (!Array.isArray(subtitleData) || subtitleData.length === 0) {
                            return -1;
                        }
                        if (newCurrentLineIndex !== -1) {
                            const candidate = newCurrentLineIndex + 1;
                            return candidate < subtitleData.length ? candidate : -1;
                        }
                        let lo = 0;
                        let hi = subtitleData.length - 1;
                        let candidate = -1;
                        while (lo <= hi) {
                            const mid = (lo + hi) >>> 1;
                            const line = subtitleData[mid];
                            const start = Number(line && line.start_time);
                            if (!Number.isFinite(start)) {
                                lo = mid + 1;
                                continue;
                            }
                            if (start >= currentTime) {
                                candidate = mid;
                                hi = mid - 1;
                            } else {
                                lo = mid + 1;
                            }
                        }
                        return candidate;
                    })();
                    if (upcomingIndex !== -1) {
                        const upcomingLine = subtitleData[upcomingIndex];
                        const startTime = Number(upcomingLine && upcomingLine.start_time);
                        if (Number.isFinite(startTime)) {
                            const timeUntilStart = startTime - currentTime;
                            if (timeUntilStart <= 0 || timeUntilStart > LINE_AUTO_SCROLL_LOOKAHEAD_SECONDS) {
                                if (lastLineLookaheadIndex === upcomingIndex && timeUntilStart > LINE_AUTO_SCROLL_LOOKAHEAD_SECONDS) {
                                    lastLineLookaheadIndex = -1;
                                }
                                if (timeUntilStart <= 0 && lastLineLookaheadIndex === upcomingIndex) {
                                    lastLineLookaheadIndex = -1;
                                }
                            } else if (lastLineLookaheadIndex !== upcomingIndex) {
                                const lookaheadPlan = computeAutoScrollPlan(upcomingIndex, {
                                    currentTime,
                                    lookahead: true
                                });
                                if (lookaheadPlan) {
                                    autoScrollToIndex(upcomingIndex, lookaheadPlan);
                                }
                                lastLineLookaheadIndex = upcomingIndex;
                            }
                        }
                    } else if (lastLineLookaheadIndex !== -1) {
                        lastLineLookaheadIndex = -1;
                    }
                }
            }

            const nextProgressSet = new Set();
            if (useSubtitleProgress) {
                activeIndices.forEach(idx => {
                    if (isLineWithinAnimationViewport(idx)) {
                        nextProgressSet.add(idx);
                    }
                });
            }
            const prevProgressSet = new Set(activeSubtitleProgressIndices);
            prevProgressSet.forEach(idx => {
                if (!nextProgressSet.has(idx)) {
                    resetSubtitleProgressAt(idx);
                }
            });
            if (useSubtitleProgress) {
                nextProgressSet.forEach(idx => {
                    const line = subtitleData[idx];
                    if (!activeSet.has(idx)) {
                        resetSubtitleProgressAt(idx);
                        return;
                    }
                    const fraction = computeLineProgressFraction(line, currentTime);
                    setSubtitleProgress(idx, fraction);
                });
            } else if (prevProgressSet.size) {
                clearSubtitleProgress();
            }

            const nextTimeSet = new Set();
            if (useTimecodeProgress) {
                activeIndices.forEach(idx => {
                    if (isLineWithinAnimationViewport(idx)) {
                        nextTimeSet.add(idx);
                    }
                });
            }
            const prevTimeSet = new Set(activeTimecodeProgressIndices);
            prevTimeSet.forEach(idx => {
                if (!nextTimeSet.has(idx)) {
                    clearTimecodeProgress(idx);
                }
            });
            if (useTimecodeProgress) {
                nextTimeSet.forEach(idx => {
                    const line = subtitleData[idx];
                    if (!activeSet.has(idx)) {
                        clearTimecodeProgress(idx);
                        return;
                    }
                    const fraction = computeLineProgressFraction(line, currentTime);
                    setTimecodeProgress(idx, fraction);
                });
            } else if (prevTimeSet.size) {
                clearTimecodeProgress();
            }

            if (!useTimecodeProgress && transportProgressValue !== 0) {
                resetTransportProgress();
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
        projectDataReady = false;
        projectDataRetryAttempt = 0;
        clearProjectDataRetryTimer();
        statusIndicator.text('Обновление данных проекта...');
        getProjectData('refresh_button', { allowCache: false, forceReload: true }).catch(err => {
            console.error('[Prompter] refresh project data failed', err);
            scheduleProjectDataRetry('refresh_button_retry');
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
    if (projectSettingsButtonEl && projectSettingsButtonEl.length) {
        projectSettingsButtonEl.on('click', function(event) {
            event.preventDefault();
            showProjectSettingsModal();
        });
    }
    if (projectSettingsModalEl && projectSettingsModalEl.length) {
        projectSettingsModalEl.on('click', function(event) {
            if (event.target === this) {
                hideProjectSettingsModal();
            }
        });
    }
    $('.modal-close-button, #settings-modal').on('click', function(event) { if (event.target === this) $('#settings-modal').hide(); });
    saveSettingsButton.on('click', saveSettings);
    resetSettingsButton.on('click', resetSettings);
    $('#actors-button').on('click', function(){
        // Заполнить textarea текущим mapping
        if (actorRoleMappingTextarea && actorRoleMappingTextarea.length) {
            actorRoleMappingTextarea.val(settings.actorRoleMappingText || '');
        }
        setActorRoleImportStatus('');
        regenerateActorColorListUI();
        updateActorRoleWarningBanner();
        updateActorRoleImportVisibility();
        $('#actors-modal').show();
    });
    if (actorRoleImportButton && actorRoleImportButton.length) {
        actorRoleImportButton.on('click', () => {
            importActorRoleGroupsFromProject();
        });
    }
    // Realtime mapping update while typing: rebuild preview without mutating user input.
    if (actorRoleMappingTextarea && actorRoleMappingTextarea.length) {
        actorRoleMappingTextarea.on('input', function(){
            const val = $(this).val();
            settings.actorRoleMappingText = typeof val === 'string' ? val : '';
            const shouldDebounce = Array.isArray(subtitleData) && subtitleData.length >= ACTOR_MAPPING_REBUILD_DEBOUNCE_THRESHOLD; // throttle heavy rebuilds for large datasets
            scheduleActorMappingPreview({ debounce: shouldDebounce });
        });
    }

    // ================= STATISTICS =================
    function isLineWithinSegment(line, segmentRange) {
        if (!segmentRange) return true;
        if (!line) return false;
        const segmentStart = Number(segmentRange.startSeconds);
        if (!Number.isFinite(segmentStart)) return false;
        const segmentEndRaw = Number(segmentRange.endSeconds);
        const segmentEnd = Number.isFinite(segmentEndRaw) ? Math.max(segmentEndRaw, segmentStart) : Number.POSITIVE_INFINITY;
        const lineStart = Number(line.start_time);
        if (!Number.isFinite(lineStart)) return false;
        const lineEndRaw = Number(line.end_time);
        const lineEnd = Number.isFinite(lineEndRaw) ? lineEndRaw : lineStart;
        const overlapsStart = lineEnd >= (segmentStart - SEGMENT_RANGE_EPSILON);
        const startsBeforeEnd = lineStart < (segmentEnd - SEGMENT_RANGE_EPSILON);
        return overlapsStart && startsBeforeEnd;
    }

    function ensureStatsDomHandles() {
        if (!statsModalEl || !statsModalEl.length) statsModalEl = $('#stats-modal');
        if (!statsSegmentControlsEl || !statsSegmentControlsEl.length) statsSegmentControlsEl = $('#stats-segmentation-controls');
        if (!statsSegmentSelectEl || !statsSegmentSelectEl.length) statsSegmentSelectEl = $('#stats-segment-select');
        if (!statsSegmentSourceEl || !statsSegmentSourceEl.length) statsSegmentSourceEl = $('#stats-segment-source');
        if (!statsRolesSectionEl || !statsRolesSectionEl.length) statsRolesSectionEl = $('#stats-roles-section');
        if (!statsActorsSectionEl || !statsActorsSectionEl.length) statsActorsSectionEl = $('#stats-actors-section');
        if (!statsColorsSectionEl || !statsColorsSectionEl.length) statsColorsSectionEl = $('#stats-colors-section');
        if (!statsEmptyEl || !statsEmptyEl.length) statsEmptyEl = $('#stats-empty');
        if (!statsRolesTableBodyEl || !statsRolesTableBodyEl.length) statsRolesTableBodyEl = $('#stats-roles-table tbody');
        if (!statsActorsTableBodyEl || !statsActorsTableBodyEl.length) statsActorsTableBodyEl = $('#stats-actors-table tbody');
        if (!statsColorsTableBodyEl || !statsColorsTableBodyEl.length) statsColorsTableBodyEl = $('#stats-colors-table tbody');
        if (!statsRolesTotalEl || !statsRolesTotalEl.length) statsRolesTotalEl = $('#stats-roles-total');
        if (!statsActorsTotalEl || !statsActorsTotalEl.length) statsActorsTotalEl = $('#stats-actors-total');
        if (!statsColorsTotalEl || !statsColorsTotalEl.length) statsColorsTotalEl = $('#stats-colors-total');
    }

    function computeStats(options = {}) {
        const opts = options || {};
        const segmentRange = opts.segmentRange && typeof opts.segmentRange === 'object' ? opts.segmentRange : null;
        const roleCounts = new Map();
        const actorCounts = new Map();
        const colorCounts = new Map();
        let totalRoleLines = 0;
        let totalActorLines = 0;
        let totalColorLines = 0;
        const haveActorMapping = Object.keys(roleToActor || {}).length > 0;
        if (Array.isArray(subtitleData)) {
            for (const line of subtitleData) {
                if (!line || !line.text) continue;
                if (segmentRange && !isLineWithinSegment(line, segmentRange)) continue;
                const match = line.text.match(/^\[(.*?)\]\s*/);
                if (!match || !match[1]) continue;
                const roleKey = String(match[1]).toUpperCase();
                if (!roleKey) continue;
                totalRoleLines += 1;
                roleCounts.set(roleKey, (roleCounts.get(roleKey) || 0) + 1);
                const actor = roleToActor[roleKey];
                if (actor) {
                    totalActorLines += 1;
                    actorCounts.set(actor, (actorCounts.get(actor) || 0) + 1);
                } else if (!haveActorMapping && line.color) {
                    totalColorLines += 1;
                    colorCounts.set(line.color, (colorCounts.get(line.color) || 0) + 1);
                }
            }
        }
        return {
            roleCounts,
            actorCounts,
            colorCounts,
            totalRoleLines,
            totalActorLines,
            totalColorLines,
            haveActorMapping,
            segmentRange: segmentRange ? { ...segmentRange } : null
        };
    }

    function renderStatsTables(options = {}) {
        ensureStatsDomHandles();
        const opts = options || {};
        const openModal = opts.openModal !== false;
        const percentDigits = typeof opts.percentDigits === 'number' ? opts.percentDigits : STATS_PERCENT_DIGITS;
        const activeEntry = statsSegmentOptionMap.get(statsSegmentSelection) || statsSegmentOptionMap.get(STATS_SEGMENT_ALL_VALUE);
        const segmentRange = activeEntry && activeEntry.range ? activeEntry.range : null;
        if (statsSegmentSelectEl && statsSegmentSelectEl.length) {
            statsSegmentSelectEl.val(statsSegmentSelection);
        }
        const stats = computeStats({ segmentRange });
        const formatPercent = (count, total) => {
            if (!total || total <= 0) return (0).toFixed(percentDigits);
            return ((count / total) * 100).toFixed(percentDigits);
        };

        let anyVisible = false;

        if (statsRolesTableBodyEl && statsRolesTableBodyEl.length) {
            statsRolesTableBodyEl.empty();
            if (stats.totalRoleLines > 0 && stats.roleCounts.size > 0) {
                const rows = Array.from(stats.roleCounts.entries()).sort((a, b) => b[1] - a[1]);
                rows.forEach(([role, count]) => {
                    const rowEl = $('<tr>')
                        .append($('<td>').text(role))
                        .append($('<td>').text(count))
                        .append($('<td>').text(formatPercent(count, stats.totalRoleLines)));
                    statsRolesTableBodyEl.append(rowEl);
                });
                if (statsRolesTotalEl && statsRolesTotalEl.length) {
                    statsRolesTotalEl.text(stats.totalRoleLines);
                }
                if (statsRolesSectionEl && statsRolesSectionEl.length) {
                    statsRolesSectionEl.show();
                }
                anyVisible = true;
            } else if (statsRolesSectionEl && statsRolesSectionEl.length) {
                statsRolesSectionEl.hide();
            }
        }

        if (statsActorsTableBodyEl && statsActorsTableBodyEl.length) {
            statsActorsTableBodyEl.empty();
            if (stats.totalActorLines > 0 && stats.actorCounts.size > 0) {
                const rows = Array.from(stats.actorCounts.entries()).sort((a, b) => b[1] - a[1]);
                rows.forEach(([actor, count]) => {
                    const rowEl = $('<tr>')
                        .append($('<td>').text(actor))
                        .append($('<td>').text(count))
                        .append($('<td>').text(formatPercent(count, stats.totalActorLines)));
                    statsActorsTableBodyEl.append(rowEl);
                });
                if (statsActorsTotalEl && statsActorsTotalEl.length) {
                    statsActorsTotalEl.text(stats.totalActorLines);
                }
                if (statsActorsSectionEl && statsActorsSectionEl.length) {
                    statsActorsSectionEl.show();
                }
                anyVisible = true;
            } else if (statsActorsSectionEl && statsActorsSectionEl.length) {
                statsActorsSectionEl.hide();
            }
        }

        if (statsColorsTableBodyEl && statsColorsTableBodyEl.length) {
            statsColorsTableBodyEl.empty();
            if (!stats.haveActorMapping) {
                const colorTotal = stats.totalColorLines;
                if (colorTotal > 0 && stats.colorCounts.size > 0) {
                    const rows = Array.from(stats.colorCounts.entries()).sort((a, b) => b[1] - a[1]);
                    rows.forEach(([color, count]) => {
                        const swatchEl = $('<span>').css({
                            display: 'inline-block',
                            width: '1.2rem',
                            height: '1.2rem',
                            'vertical-align': 'middle',
                            'border-radius': '0.2rem',
                            'margin-right': '0.4rem',
                            border: '1px solid #555',
                            background: color
                        });
                        const colorCell = $('<td>').append(swatchEl).append(document.createTextNode(color));
                        const rowEl = $('<tr>')
                            .append(colorCell)
                            .append($('<td>').text(count))
                            .append($('<td>').text(formatPercent(count, colorTotal)));
                        statsColorsTableBodyEl.append(rowEl);
                    });
                    if (statsColorsTotalEl && statsColorsTotalEl.length) {
                        statsColorsTotalEl.text(colorTotal);
                    }
                    if (statsColorsSectionEl && statsColorsSectionEl.length) {
                        statsColorsSectionEl.show();
                    }
                    anyVisible = true;
                } else if (statsColorsSectionEl && statsColorsSectionEl.length) {
                    statsColorsSectionEl.hide();
                }
            } else if (statsColorsSectionEl && statsColorsSectionEl.length) {
                statsColorsSectionEl.hide();
            }
        }

        if (statsEmptyEl && statsEmptyEl.length) {
            statsEmptyEl.toggle(!anyVisible);
        }

        if (openModal && statsModalEl && statsModalEl.length) {
            statsModalEl.show();
        }
    }

    renderStatsTablesRef = renderStatsTables;

    function buildAndShowStats(options = {}) {
        const opts = options || {};
        const preserveSelection = opts.preserveSelection !== false;
        if (opts.autoSelectFromTransport !== false) {
            const derivedSelection = determineStatsSegmentSelectionForTime(projectSegmentationInfo, latestTimecode);
            statsSegmentSelection = derivedSelection;
        }
        refreshStatsSegmentationControls({ preserveSelection, recalcIfVisible: false });
        renderStatsTables({ openModal: true });
    }

    $('#stats-button').on('click', function(){ buildAndShowStats(); });

    function evaluateStatsButtonVisibility(){
        const { roleCounts, actorCounts, haveActorMapping, colorCounts, totalColorLines } = computeStats({ segmentRange: null });
        const btn = $('#stats-button');
        const roleHas = roleCounts && roleCounts.size>0;
        const actorHas = actorCounts && actorCounts.size>0;
        const colorHas = !haveActorMapping && colorCounts.size>0 && totalColorLines>0; // only if no actor mapping
        if (roleHas || actorHas || colorHas) btn.show(); else btn.hide();
    }
    let statsEvalRaf=null; function scheduleStatsButtonEvaluation(){ if(statsEvalRaf) cancelAnimationFrame(statsEvalRaf); statsEvalRaf=requestAnimationFrame(evaluateStatsButtonVisibility); }
    $(document).on('click', '.modal-close-button', function(){
        const target = $(this).data('close');
        if (target === 'project-settings-modal') {
            hideProjectSettingsModal();
            return;
        }
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
        const actor = readActorKeyFromRow($(this).closest('.actor-color-item'));
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
        const actor = readActorKeyFromRow(row);
        if (actor) {
            setActorMuteState(actor, false);
            removeSoloActor(actor);
        }
        row.remove();
        syncActorFilterSettings({ reason: 'actor_row_deleted' });
    });
    $(document).on('click', '.actor-name', function(event){
        event.preventDefault();
        const row = $(this).closest('.actor-color-item');
        if (!row.length) return;
        beginActorInlineRename(row, $(this));
    });
    $(document).on('keydown', '.actor-name', function(event){
        if (event.key === 'Enter' || event.key === 'F2' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            const row = $(this).closest('.actor-color-item');
            if (!row.length) return;
            beginActorInlineRename(row, $(this));
        }
    });
    $(document).on('input', '.actor-name-editor', function(){
        autosizeActorNameEditor($(this));
    });
    $(document).on('keydown', '.actor-name-editor', function(event){
        const row = $(this).closest('.actor-color-item');
        if (!row.length) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            finalizeActorInlineRename(row, $(this));
        } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelActorInlineRename(row, $(this));
        }
    });
    $(document).on('blur', '.actor-name-editor', function(){
        const row = $(this).closest('.actor-color-item');
        if (!row.length) return;
        if (row.attr('data-editing') !== 'true') return;
        finalizeActorInlineRename(row, $(this));
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
    if (segmentationModeSelect.length) {
        segmentationModeSelect.on('change', function() {
            updateSegmentationControlsState({ mode: $(this).val() });
        });
    }
    if (segmentationDisplayModeSelect.length) {
        segmentationDisplayModeSelect.on('change', function() {
            updateSegmentationControlsState({ displayMode: $(this).val() });
        });
    }
    if (segmentationManualToggle.length) {
        segmentationManualToggle.on('change', function() {
            const enabled = $(this).is(':checked');
            setManualSegmentationEnabled(enabled, {
                reason: 'settings_ui_manual_toggle',
                ensureVisibility: true,
                preserveSelection: true
            });
            scheduleSettingsTileReflow();
        });
    }
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
    [highlightCurrentEnabledCheckbox, highlightPreviousEnabledCheckbox, highlightPauseEnabledCheckbox, progressBarEnabledCheckbox, highlightOverlapEnabledCheckbox].forEach($el => {
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