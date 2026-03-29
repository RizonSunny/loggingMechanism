const winston = require('winston');
const os = require('os');

/**
 * Creates a structured JSON logger for a service.
 *
 * WHY this exists:
 * - Every service needs the same log format (so ELK can parse them uniformly)
 * - Standard fields (service, environment, host, version) are added automatically
 * - You only pass event-specific data when logging
 *
 * USAGE:
 *   const logger = createLogger({ service: 'auth-service', version: '1.0.0' });
 *   logger.info('User logged in', { user_id: 'USR-123', ip: '192.168.1.1' });
 *
 * OUTPUT:
 *   {
 *     "timestamp": "2026-03-27T10:30:00.000Z",
 *     "level": "info",
 *     "message": "User logged in",
 *     "service": "auth-service",
 *     "environment": "development",
 *     "version": "1.0.0",
 *     "host": "your-machine",
 *     "user_id": "USR-123",
 *     "ip": "192.168.1.1"
 *   }
 */
function createLogger({ service, version = '1.0.0' }) {
  const environment = process.env.NODE_ENV || 'development';

  const logger = winston.createLogger({
    // -----------------------------------------------------------
    // LEVEL: minimum severity to log
    // In development we want everything (debug+), in production only info+
    // -----------------------------------------------------------
    level: environment === 'production' ? 'info' : 'debug',

    // -----------------------------------------------------------
    // FORMAT: how each log entry is shaped
    // We combine multiple formatters in a pipeline:
    //   1. timestamp()  → adds "timestamp" field in ISO 8601
    //   2. errors()     → if an Error object is logged, extract stack trace
    //   3. json()       → serialize everything as JSON
    // -----------------------------------------------------------
    format: winston.format.combine(
      // Add ISO 8601 timestamp
      winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),

      // When you log an Error object, extract its stack trace into the log
      winston.format.errors({ stack: true }),

      // Add our standard fields to EVERY log entry
      winston.format((info) => {
        info.service = service;
        info.environment = environment;
        info.version = version;
        info.host = os.hostname();
        return info;
      })(),

      // Final output: JSON
      winston.format.json()
    ),

    // -----------------------------------------------------------
    // TRANSPORTS: where logs go
    // For now, just stdout (console) — later we'll add file + ELK
    // -----------------------------------------------------------
    transports: [
      new winston.transports.Console()
    ],

    // -----------------------------------------------------------
    // Don't crash the app if logging itself fails
    // -----------------------------------------------------------
    exitOnError: false,
  });

  return logger;
}

module.exports = { createLogger };
