const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const crypto = require('crypto');

/**
 * Audit Logger — Part 5 (Compliance)
 *
 * A separate, append-only logger for compliance-relevant events.
 *
 * WHY THIS IS SEPARATE FROM THE REGULAR LOGGER:
 * ──────────────────────────────────────────────
 * Regular application logs and audit logs serve different masters:
 *
 *   Application logs → Engineers (debugging, monitoring)
 *   Audit logs       → Compliance officers, security teams, legal
 *
 * Key differences:
 *   ┌──────────────────┬─────────────────────┬──────────────────────┐
 *   │                  │ Application Logs     │ Audit Logs           │
 *   ├──────────────────┼─────────────────────┼──────────────────────┤
 *   │ Retention        │ 14 days             │ 90+ days             │
 *   │ Mutability       │ Can be deleted      │ Append-only          │
 *   │ Level filtering  │ Yes (debug/info/..) │ No — always written  │
 *   │ Content          │ Technical details   │ Who did what, when   │
 *   │ Audience         │ Engineers           │ Auditors, legal      │
 *   │ Schema           │ Flexible            │ Fixed, strict        │
 *   └──────────────────┴─────────────────────┴──────────────────────┘
 *
 * APPEND-ONLY GUARANTEE:
 * ──────────────────────
 * This module only exposes a `record()` method — there is no update, delete,
 * or truncate function. At the application level, audit entries can only be
 * created, never modified.
 *
 * For true immutability in production, you'd combine this with:
 *   - Write-once storage (S3 Object Lock, Azure Immutable Blob)
 *   - Hash chaining (each entry includes a hash of the previous entry)
 *   - Separate write credentials (the app can append but not delete)
 *
 * We implement hash chaining here as a tamper-evidence demonstration.
 *
 * AUDIT SCHEMA (every entry has these fields):
 * ─────────────────────────────────────────────
 *   timestamp   — when it happened (ISO 8601)
 *   actor       — who did it (user_id or system)
 *   action      — what they did (e.g., 'LOGIN', 'CHANGE_ROLE', 'DELETE_USER')
 *   resource    — what was affected (e.g., 'user:USR-123')
 *   outcome     — 'success' or 'failure'
 *   service     — which service recorded this
 *   ip          — client IP (if applicable)
 *   trace_id    — correlation ID for cross-service tracing
 *   details     — additional context (free-form object)
 *   hash        — SHA-256 hash of this entry + previous hash (tamper evidence)
 *
 * USAGE:
 *   const { createAuditLogger } = require('./audit-logger');
 *   const audit = createAuditLogger({ service: 'auth-service' });
 *
 *   audit.record({
 *     actor: 'admin',
 *     action: 'CHANGE_LOG_LEVEL',
 *     resource: 'system:log-config',
 *     outcome: 'success',
 *     ip: '192.168.1.1',
 *     details: { from: 'info', to: 'debug' },
 *   });
 */

/**
 * Creates an append-only audit logger for a service.
 *
 * @param {Object} options
 * @param {string} options.service     - Service name
 * @param {string} [options.logDir]    - Directory for audit files (default: './logs/audit')
 * @param {string} [options.maxFiles]  - Retention period (default: '90d')
 * @returns {{ record: Function }} Audit logger with a single record() method
 */
function createAuditLogger({ service, logDir = './logs/audit', maxFiles = '90d' }) {
  // ── INTERNAL WINSTON LOGGER ────────────────────────────────
  // We create a dedicated Winston logger that ONLY writes to audit files.
  // It uses 'info' as its only level because audit entries aren't severity-graded —
  // they're all equally important.
  const logger = winston.createLogger({
    levels: { audit: 0 },
    level: 'audit',

    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
      winston.format.json()
    ),

    transports: [
      new DailyRotateFile({
        // Audit files go in a separate subdirectory
        filename: path.join(logDir, `${service}-audit-%DATE%.log`),
        datePattern: 'YYYY-MM-DD',

        // Audit files are typically small (fewer events than app logs)
        // but we still set a size limit as a safety valve
        maxSize: '20m',

        // 90 days retention — matches SOC2 minimum recommendation
        // Adjust to '365d' for financial/healthcare compliance
        maxFiles,

        // Compress rotated audit files
        zippedArchive: true,
      }),
    ],

    // Audit logging must never crash the app
    exitOnError: false,
  });

  // ── HASH CHAIN STATE ───────────────────────────────────────
  // We track the hash of the previous audit entry.
  // Each new entry includes: hash = SHA-256(previousHash + entryContent)
  // If someone deletes or modifies an entry, the chain breaks —
  // the next entry's hash won't match a recalculated chain.
  //
  // NOTE: This is a demonstration. In production, you'd persist the
  // previous hash to disk or a database so it survives process restarts.
  let previousHash = 'GENESIS'; // Seed value for the first entry

  /**
   * Records an audit event. This is the ONLY public method — no update, no delete.
   *
   * @param {Object} entry
   * @param {string} entry.actor     - Who performed the action (user_id or 'system')
   * @param {string} entry.action    - What was done (e.g., 'LOGIN', 'CHANGE_ROLE')
   * @param {string} entry.resource  - What was affected (e.g., 'user:USR-123')
   * @param {string} entry.outcome   - 'success' or 'failure'
   * @param {string} [entry.ip]      - Client IP address
   * @param {string} [entry.trace_id]- Correlation ID
   * @param {Object} [entry.details] - Additional context
   */
  function record(entry) {
    // ── SCHEMA ENFORCEMENT ─────────────────────────────────
    // Audit entries must have these fields. We don't silently accept
    // incomplete entries because missing audit data is a compliance risk.
    const requiredFields = ['actor', 'action', 'resource', 'outcome'];
    for (const field of requiredFields) {
      if (!entry[field]) {
        // Log the validation error to stderr (not to the audit log itself)
        process.stderr.write(
          `[audit-logger] WARNING: Missing required field "${field}" — entry not recorded\n`
        );
        return;
      }
    }

    // ── BUILD THE AUDIT RECORD ─────────────────────────────
    const auditRecord = {
      log_type: 'audit',
      service,
      actor: entry.actor,
      action: entry.action,
      resource: entry.resource,
      outcome: entry.outcome,
      ip: entry.ip || 'unknown',
      trace_id: entry.trace_id || 'none',
      details: entry.details || {},
    };

    // ── HASH CHAIN ─────────────────────────────────────────
    // Create a deterministic string from the record, then hash it
    // together with the previous hash. This creates a chain:
    //   hash_1 = SHA-256(GENESIS + entry_1)
    //   hash_2 = SHA-256(hash_1 + entry_2)
    //   hash_3 = SHA-256(hash_2 + entry_3)
    // If entry_2 is tampered with, hash_3 won't validate.
    const contentToHash = previousHash + JSON.stringify(auditRecord);
    const currentHash = crypto
      .createHash('sha256')
      .update(contentToHash)
      .digest('hex');

    auditRecord.previous_hash = previousHash;
    auditRecord.hash = currentHash;

    // Update chain state for the next entry
    previousHash = currentHash;

    // ── WRITE (APPEND-ONLY) ────────────────────────────────
    // The 'audit' level always writes — there's no level filtering.
    logger.audit(auditRecord);
  }

  return { record };
}

module.exports = { createAuditLogger };
