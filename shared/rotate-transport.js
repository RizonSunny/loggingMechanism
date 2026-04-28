const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

/**
 * Log Rotation Transport Factory — Part 5
 *
 * Creates a Winston transport that writes to date-stamped, size-limited,
 * compressed log files with automatic retention-based cleanup.
 *
 * WHY THIS EXISTS:
 * ─────────────────
 * Without rotation, log files grow unbounded until the disk fills up.
 * This transport implements HYBRID rotation (date + size):
 *   - A new file is created every day (time-based)
 *   - If a single day's file exceeds maxSize, it splits into numbered files (size-based)
 *   - Old files are gzipped to save ~90% disk space
 *   - Files older than maxFiles days are auto-deleted
 *
 * HOW IT WORKS UNDER THE HOOD:
 * ─────────────────────────────
 * winston-daily-rotate-file uses file-stream-rotator internally.
 * On every log write, it checks:
 *   1. Has the date changed since the last write? → rotate
 *   2. Has the current file exceeded maxSize? → rotate
 * When rotation happens:
 *   - The current file is closed
 *   - If zippedArchive is true, the closed file is gzipped in the background
 *   - A new file is opened with the current date in the filename
 *   - Files exceeding the maxFiles age are deleted
 *
 * FILE NAMING:
 * ────────────
 * Pattern: logs/{service}-{date}.log
 * Examples:
 *   logs/auth-service-2026-03-30.log        ← today's log (active, uncompressed)
 *   logs/auth-service-2026-03-29.log.gz     ← yesterday (rotated, compressed)
 *   logs/auth-service-2026-03-28.log.gz     ← two days ago (compressed)
 *   logs/auth-service-2026-03-30.1.log      ← today's 2nd file (if first hit 20MB)
 *
 * USAGE:
 *   const { createRotateTransport } = require('./rotate-transport');
 *   const transport = createRotateTransport({ service: 'auth-service' });
 *   // Then add to a Winston logger's transports array
 */

/**
 * Creates a daily-rotating file transport with compression and retention.
 *
 * @param {Object} options
 * @param {string} options.service     - Service name, used in filename (e.g., 'auth-service')
 * @param {string} [options.logDir]    - Directory for log files (default: './logs')
 * @param {string} [options.maxSize]   - Max size per file before rotation (default: '20m' = 20MB)
 * @param {string} [options.maxFiles]  - How long to keep files (default: '14d' = 14 days)
 * @param {string} [options.level]     - Minimum level for this transport (default: inherits from logger)
 * @returns {DailyRotateFile} Configured transport instance
 */
function createRotateTransport({
  service,
  logDir = './logs',
  maxSize = '20m',
  maxFiles = '14d',
  level,
}) {
  const transport = new DailyRotateFile({
    // ── FILE NAMING ────────────────────────────────────────
    // %DATE% is replaced by the current date in datePattern format.
    // Result: logs/auth-service/auth-service-2026-03-30.log
    filename: path.join(logDir, service, `${service}-%DATE%.log`),

    // ── DATE PATTERN ───────────────────────────────────────
    // YYYY-MM-DD = daily rotation. Use YYYY-MM-DD-HH for hourly.
    datePattern: 'YYYY-MM-DD',

    // ── SIZE-BASED ROTATION ────────────────────────────────
    // If the file exceeds this size WITHIN a single day, a new numbered
    // file is created: auth-service-2026-03-30.1.log
    // '20m' = 20 megabytes. In production, 50-100m is common.
    maxSize,

    // ── RETENTION ──────────────────────────────────────────
    // '14d' = delete files older than 14 days automatically.
    // Can also be a number (e.g., 5) meaning "keep at most 5 files".
    // The string format with 'd' suffix is date-aware — it checks file dates.
    maxFiles,

    // ── COMPRESSION ────────────────────────────────────────
    // When true, rotated files are gzipped in the background.
    // Active file stays uncompressed (for real-time tailing).
    // JSON logs compress ~10:1, so 20MB → ~2MB gzipped.
    zippedArchive: true,

    // ── LEVEL FILTER ───────────────────────────────────────
    // If set, this transport only receives logs at this level or above.
    // Useful for creating separate error-only files.
    // If undefined, inherits the logger's level.
    level,

    // ── DIRECTORY CREATION ─────────────────────────────────
    // Automatically creates the log directory if it doesn't exist.
    // Without this, the transport would throw ENOENT on first write.
    createSymlink: false,
    // Note: winston-daily-rotate-file auto-creates directories by default
  });

  // ── LIFECYCLE EVENTS ───────────────────────────────────
  // These events let you hook into the rotation lifecycle.
  // Useful for monitoring the logging system itself.

  // Fired when a file is rotated (closed and a new one opened)
  transport.on('rotate', (oldFilename, newFilename) => {
    // We write to stderr to avoid recursive logging
    process.stderr.write(
      `[log-rotate] ${service}: rotated ${path.basename(oldFilename)} → ${path.basename(newFilename)}\n`
    );
  });

  // Fired when old files are deleted by the retention policy
  transport.on('logRemoved', (removedFilename) => {
    process.stderr.write(
      `[log-rotate] ${service}: retention policy deleted ${path.basename(removedFilename)}\n`
    );
  });

  return transport;
}

/**
 * Creates a separate transport specifically for ERROR-level logs.
 *
 * WHY A SEPARATE ERROR FILE:
 * - During incidents, you want to quickly find errors without wading through info/debug
 * - Error files are typically much smaller, so they're faster to search
 * - Some teams set up file-based alerts that watch only the error log
 *
 * The file is named: logs/{service}-error-{date}.log
 *
 * @param {Object} options
 * @param {string} options.service  - Service name
 * @param {string} [options.logDir] - Directory for log files (default: './logs')
 * @returns {DailyRotateFile} Error-only transport
 */
function createErrorRotateTransport({ service, logDir = './logs' }) {
  return createRotateTransport({
    service: `${service}-error`,
    logDir,
    maxSize: '20m',
    maxFiles: '30d',   // Keep errors longer than general logs (30d vs 14d)
    level: 'error',    // Only captures error and fatal
  });
}

module.exports = { createRotateTransport, createErrorRotateTransport };
