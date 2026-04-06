/**
 * Logging — matches the Python RNS log levels (0-7).
 *
 * LOG_CRITICAL = 0
 * LOG_ERROR    = 1
 * LOG_WARNING  = 2
 * LOG_NOTICE   = 3
 * LOG_INFO     = 4
 * LOG_VERBOSE  = 5
 * LOG_DEBUG    = 6
 * LOG_EXTREME  = 7
 */

export const LOG_CRITICAL = 0;
export const LOG_ERROR    = 1;
export const LOG_WARNING  = 2;
export const LOG_NOTICE   = 3;
export const LOG_INFO     = 4;
export const LOG_VERBOSE  = 5;
export const LOG_DEBUG    = 6;
export const LOG_EXTREME  = 7;

const LEVEL_NAMES = [
  'CRITICAL', 'ERROR', 'WARNING', 'NOTICE',
  'INFO', 'VERBOSE', 'DEBUG', 'EXTREME'
];

let currentLevel = LOG_INFO;
let logOutput = null; // null = use level-appropriate console method

/**
 * Set the current log level. Messages above this level are suppressed.
 * @param {number} level
 */
export function setLogLevel(level) {
  currentLevel = level;
}

/**
 * Get the current log level.
 * @returns {number}
 */
export function getLogLevel() {
  return currentLevel;
}

/**
 * Set a custom log output function. Default is console.error.
 * @param {function(string): void} fn
 */
export function setLogOutput(fn) {
  logOutput = fn;
}

/**
 * Log a message at the given level.
 * @param {number} level
 * @param {string} source - Module/component name
 * @param {string} message
 */
export function log(level, source, message) {
  if (level > currentLevel) return;
  const timestamp = new Date().toISOString();
  const levelName = LEVEL_NAMES[level] || 'UNKNOWN';
  const formatted = `[${timestamp}] [${levelName}] [${source}] ${message}`;

  if (logOutput) {
    logOutput(formatted);
  } else {
    // Use level-appropriate console method
    if (level <= LOG_ERROR) console.error(formatted);
    else if (level <= LOG_WARNING) console.warn(formatted);
    else if (level <= LOG_INFO) console.info(formatted);
    else console.debug(formatted);
  }
}
