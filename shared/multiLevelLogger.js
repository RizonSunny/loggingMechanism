const winston = require('winston');
const os = require('os');

/**
 * Multi-Level Logger — Part 3 Enhancement
 *
 * WHY THIS EXISTS (separate from logger.js):
 * ────────────────────────────────────────────
 * logger.js (Part 2) provides the basic structured JSON logger with Winston defaults.
 * This file EXTENDS that foundation with:
 *   - Custom 6-level severity spectrum: fatal → error → warn → info → debug → trace
 *   - Environment-based level defaults (dev/staging/prod/test)
 *   - Child loggers for per-module filtering (e.g., module:"auth", module:"database")
 *   - Runtime log level changes via setLogLevel() (no restart needed)
 *   - Logger registry so level changes propagate to ALL loggers at once
 *
 * RELATIONSHIP TO logger.js:
 *   logger.js       → basic createLogger() with Winston's built-in npm levels
 *   multiLevelLogger.js → enhanced createMultiLevelLogger() with custom levels + extras
 *
 * USAGE:
 *   const { createMultiLevelLogger, createChildLogger, setLogLevel } = require('./multiLevelLogger');
 *   const logger = createMultiLevelLogger({ service: 'auth-service' });
 *   const authLogger = createChildLogger(logger, 'auth');
 *   authLogger.info('Login successful', { username: 'john' });
 *   // Output: { ..., service: "auth-service", module: "auth", message: "Login successful" }
 */

// ─── CUSTOM LOG LEVELS ──────────────────────────────────────
// Winston's built-in levels (npm): error=0, warn=1, info=2, http=3, verbose=4, debug=5, silly=6
// We define our OWN levels to match the industry-standard severity spectrum:
//
//   fatal (0) → error (1) → warn (2) → info (3) → debug (4) → trace (5)
//
// Lower number = higher severity. Winston logs everything AT or ABOVE the configured level.
// So if level = 'info' (3), it logs fatal(0), error(1), warn(2), info(3) — but NOT debug(4) or trace(5).
const CUSTOM_LEVELS = {
  levels: {
    fatal: 0,   // System cannot continue — unrecoverable
    error: 1,   // Operation failed — actionable, should alert
    warn: 2,    // Unexpected but handled — early signal of trouble
    info: 3,    // Business-relevant event — the production baseline
    debug: 4,   // Internal system behavior — development visibility
    trace: 5,   // Ultra-granular step-by-step — active debugging only
  },
  // Colors for console output (used when format.colorize() is enabled)
  colors: {
    fatal: 'magenta bold',
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'cyan',
    trace: 'gray',
  },
};

// Register colors so Winston knows how to colorize our custom levels
winston.addColors(CUSTOM_LEVELS.colors);

// ─── ENVIRONMENT-BASED LEVEL DEFAULTS ────────────────────────
// Each environment has a sensible default minimum level.
// The LOG_LEVEL env var can override this (useful for Docker/K8s config).
const LEVEL_BY_ENVIRONMENT = {
  development: 'debug',    // See everything except trace
  test: 'warn',            // Tests should be quiet — only warnings and errors
  staging: 'debug',        // Mirrors prod but with dev-level visibility for QA
  production: 'info',      // Business events + warnings + errors only
};

/**
 * Resolves the effective log level for the current environment.
 *
 * Priority:
 *   1. LOG_LEVEL env var (explicit override — e.g., in Docker Compose)
 *   2. Environment-based default from LEVEL_BY_ENVIRONMENT map
 *   3. Fallback: 'info' (safe default)
 *
 * @param {string} environment - Current NODE_ENV value
 * @returns {string} The log level to use
 */
function resolveLogLevel(environment) {
  // LOG_LEVEL env var takes highest priority — allows runtime override via config
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL;
  }
  return LEVEL_BY_ENVIRONMENT[environment] || 'info';
}

// ─── LOGGER REGISTRY ─────────────────────────────────────────
// We keep a reference to every logger we create so that when the admin
// endpoint calls setLogLevel(), we can update ALL loggers at once.
// Without this, changing the level on one logger wouldn't affect child loggers.
const loggerRegistry = [];

/**
 * Creates an enhanced structured JSON logger with custom severity levels.
 *
 * DIFFERENCE FROM createLogger() in logger.js:
 * - Uses custom levels (fatal/error/warn/info/debug/trace) instead of Winston npm defaults
 * - Resolves log level from environment config + LOG_LEVEL env var
 * - Registers itself in the logger registry for runtime level changes
 *
 * USAGE:
 *   const logger = createMultiLevelLogger({ service: 'auth-service', version: '1.0.0' });
 *   logger.info('User logged in', { user_id: 'USR-123' });
 *   logger.trace('Parsing request body', { has_username: true });
 *   logger.fatal('Cannot bind to port', { port: 3001, error: 'EADDRINUSE' });
 *
 * @param {Object} options
 * @param {string} options.service - Service name (e.g., 'auth-service')
 * @param {string} [options.version='1.0.0'] - Service version
 * @returns {winston.Logger} Configured Winston logger with custom levels
 */
function createMultiLevelLogger({ service, version = '1.0.0' }) {
  const environment = process.env.NODE_ENV || 'development';
  const level = resolveLogLevel(environment);

  const logger = winston.createLogger({
    // Use our custom level definitions instead of Winston's built-in npm levels
    levels: CUSTOM_LEVELS.levels,

    // Minimum severity to log — determined by environment (see resolveLogLevel)
    level,

    format: winston.format.combine(
      // Add ISO 8601 timestamp to every log entry
      winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),

      // When you log an Error object, extract its stack trace into the log
      winston.format.errors({ stack: true }),

      // Add standard fields to EVERY log entry
      winston.format((info) => {
        info.service = service;
        info.environment = environment;
        info.version = version;
        info.host = os.hostname();
        return info;
      })(),

      // Final output: JSON (machine-readable for ELK)
      winston.format.json()
    ),

    transports: [
      new winston.transports.Console()
    ],

    // Don't crash the app if logging itself fails
    exitOnError: false,
  });

  // Register this logger so setLogLevel() can update it later
  loggerRegistry.push(logger);

  return logger;
}

/**
 * Creates a child logger that inherits the parent's config but adds a module context field.
 *
 * WHY:
 * - A service has many modules (auth, database, http, orders, etc.)
 * - Child loggers add a `module` field to every log entry automatically
 * - In Kibana, you can filter: service:"auth-service" AND module:"database"
 * - No need to manually pass { module: 'xxx' } in every log call
 *
 * HOW IT WORKS:
 * - Winston's logger.child() creates a new logger that inherits ALL parent config
 *   (level, format, transports) but merges in the additional metadata you provide
 * - The child is added to the registry so runtime level changes affect it too
 *
 * USAGE:
 *   const logger = createMultiLevelLogger({ service: 'order-service' });
 *   const dbLogger = createChildLogger(logger, 'database');
 *   dbLogger.info('Connected');
 *   // Output: { ..., service: "order-service", module: "database", message: "Connected" }
 *
 * @param {winston.Logger} parentLogger - The parent logger to inherit from
 * @param {string} moduleName - Module name to inject (e.g., 'auth', 'database', 'http')
 * @returns {winston.Logger} Child logger with module field
 */
function createChildLogger(parentLogger, moduleName) {
  const child = parentLogger.child({ module: moduleName });
  // Register the child so setLogLevel() updates it too
  loggerRegistry.push(child);
  return child;
}

/**
 * Changes the log level of ALL registered loggers at runtime.
 *
 * WHY:
 * - In production, you may need to temporarily enable debug logs to investigate an issue
 * - Without this, you'd have to redeploy the service with a different LOG_LEVEL
 * - This lets an admin endpoint change the level instantly, without restart
 *
 * SECURITY:
 * - This function itself has no auth — the admin endpoint that calls it must be protected
 * - We log the level change as a WARN (it's an operational change that should be auditable)
 *
 * USAGE:
 *   setLogLevel('debug');  // Now all loggers emit debug+ logs
 *   setLogLevel('info');   // Back to normal production level
 *
 * @param {string} newLevel - The new minimum log level (fatal|error|warn|info|debug|trace)
 * @returns {{ success: boolean, level: string, loggersUpdated: number }}
 */
function setLogLevel(newLevel) {
  // Validate that the requested level exists in our custom levels
  if (!CUSTOM_LEVELS.levels.hasOwnProperty(newLevel)) {
    return {
      success: false,
      error: `Invalid level: "${newLevel}". Valid levels: ${Object.keys(CUSTOM_LEVELS.levels).join(', ')}`,
    };
  }

  const previousLevel = loggerRegistry.length > 0 ? loggerRegistry[0].level : 'unknown';

  // Update every registered logger (parent + all children)
  loggerRegistry.forEach((logger) => {
    logger.level = newLevel;
  });

  // Log the change itself — this is an operational event, so WARN is appropriate
  // (it's noteworthy but not an error)
  if (loggerRegistry.length > 0) {
    loggerRegistry[0].warn('Log level changed at runtime', {
      log_type: 'admin',
      previous_level: previousLevel,
      new_level: newLevel,
      loggers_updated: loggerRegistry.length,
    });
  }

  return {
    success: true,
    level: newLevel,
    previous_level: previousLevel,
    loggers_updated: loggerRegistry.length,
  };
}

/**
 * Returns the current log level and available levels for introspection.
 * Used by the admin endpoint to show the current state.
 */
function getLogLevel() {
  return {
    current: loggerRegistry.length > 0 ? loggerRegistry[0].level : 'unknown',
    available: Object.keys(CUSTOM_LEVELS.levels),
    loggers_registered: loggerRegistry.length,
  };
}

module.exports = {
  createMultiLevelLogger,
  createChildLogger,
  setLogLevel,
  getLogLevel,
  CUSTOM_LEVELS,
};
