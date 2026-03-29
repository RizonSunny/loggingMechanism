const express = require('express');
const cors = require('cors');
const { createMultiLevelLogger, createChildLogger, setLogLevel, getLogLevel } = require('../../shared/multiLevelLogger');
const { createMorganMiddleware } = require('../../shared/morgan-stream');
const { createSecurityLogger } = require('../../shared/security-logger');
const { createEventLogger } = require('../../shared/event-logger');
const { connectDatabase } = require('../../shared/database');

const app = express();
app.use(cors());
app.use(express.json());

// ─── INITIALIZE LOGGERS ────────────────────────────────────
// Parent logger for the service — carries { service: 'auth-service' }
// Uses createMultiLevelLogger (from multiLevelLogger.js) instead of createLogger (from logger.js)
// because we need custom levels (fatal/trace) + runtime level changes + child loggers
const logger = createMultiLevelLogger({ service: 'auth-service', version: '1.0.0' });

// Child loggers — each adds { module: '<name>' } to every log entry.
// In Kibana: service:"auth-service" AND module:"auth" → only auth logic logs
const authLogger = createChildLogger(logger, 'auth');
const dbLogger = createChildLogger(logger, 'database');

// Security and event loggers now use the auth child logger for proper module tagging
const securityLogger = createSecurityLogger(authLogger);
const eventLogger = createEventLogger(authLogger);

// ─── SERVER LOG: Morgan HTTP access logging ────────────────
// Morgan logs go through the parent logger (no module tag needed — they have log_type: "access")
app.use(createMorganMiddleware(logger));

const PORT = process.env.PORT || 3001;

// Simulated user database
const users = {
  'john': { password: 'pass123', role: 'customer' },
  'admin': { password: 'admin456', role: 'admin' },
};

// Track login attempts per IP (for suspicious activity detection)
const loginAttempts = {};

// -------------------------------------------------------
// POST /login
//
// LOG LEVELS DEMONSTRATED:
//   trace  → request body parsing details (deep diagnostic)
//   debug  → user lookup result
//   info   → business outcome (login success)
//   warn   → auth failure (via securityLogger)
//   error  → suspicious activity (via securityLogger)
// -------------------------------------------------------
app.post('/login', (req, res) => {
  console.log('\n═══════════ POST /login | auth | auth-service ═══════════');
  const { username, password } = req.body;
  const ip = req.ip;

  // TRACE — ultra-granular: what exact data did we receive?
  // Only visible when level=trace (never in production by default)
  authLogger.trace('Parsing login request body', {
    has_username: !!username,
    has_password: !!password,
    ip,
  });

  // DEBUG — internal system step: looking up the user
  authLogger.debug('Looking up user in database', { username, ip });

  const user = users[username];

  if (!user) {
    // SECURITY LOG (WARN) — unknown user, track for brute force detection
    securityLogger.authFailure({ username, ip, reason: 'user_not_found' });
    trackFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (user.password !== password) {
    // SECURITY LOG (WARN) — wrong password
    securityLogger.authFailure({ username, ip, reason: 'invalid_password' });
    trackFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Reset failed attempts on success
  loginAttempts[ip] = 0;

  // SECURITY LOG (INFO) — successful authentication
  securityLogger.authSuccess({ username, ip, role: user.role });

  // EVENT LOG (INFO) — domain event for analytics/downstream systems
  eventLogger.emit('USER_LOGIN', { username, role: user.role, ip });

  // INFO — business outcome: login succeeded
  authLogger.info('Login successful', { username, role: user.role });

  res.json({ message: 'Login successful', token: 'fake-jwt-token', role: user.role });
});

/**
 * Track failed login attempts per IP.
 * If an IP fails 5+ times, log a SUSPICIOUS_ACTIVITY security event.
 */
function trackFailedAttempt(ip) {
  loginAttempts[ip] = (loginAttempts[ip] || 0) + 1;

  // DEBUG — track the running count (useful for investigating brute force thresholds)
  authLogger.debug('Failed login attempt tracked', {
    ip,
    attempt_count: loginAttempts[ip],
    threshold: 5,
  });

  if (loginAttempts[ip] >= 5) {
    // ERROR (via securityLogger) — this needs immediate attention
    securityLogger.suspiciousActivity({
      ip,
      reason: 'too_many_failed_logins',
      details: { attempt_count: loginAttempts[ip] },
    });
  }
}

// -------------------------------------------------------
// ADMIN ENDPOINTS — Runtime log level management
//
// These allow on-call engineers to change log verbosity
// without restarting the service. Protected by role check.
// -------------------------------------------------------

/**
 * GET /admin/log-level
 * Returns the current log level and available options.
 * Useful for checking state before/after a change.
 */
app.get('/admin/log-level', (req, res) => {
  console.log('\n═══════════ GET /admin/log-level | auth | auth-service ═══════════');
  const levelInfo = getLogLevel();
  authLogger.debug('Log level queried', { current_level: levelInfo.current });
  res.json(levelInfo);
});

/**
 * POST /admin/log-level
 * Changes the log level at runtime for ALL loggers in this process.
 *
 * Body: { "level": "debug" }
 * Valid levels: fatal, error, warn, info, debug, trace
 *
 * Security: In production, this should be behind authentication + admin role check.
 * For now, we log the change as an admin action for audit trail.
 */
app.post('/admin/log-level', (req, res) => {
  console.log('\n═══════════ POST /admin/log-level | auth | auth-service ═══════════');
  const { level } = req.body;

  if (!level) {
    return res.status(400).json({ error: 'Missing "level" field in request body' });
  }

  // Log the admin action for audit trail
  securityLogger.adminAction({
    username: 'admin',   // In real app: extract from JWT
    ip: req.ip,
    action: 'change_log_level',
    target: level,
  });

  const result = setLogLevel(level);

  if (!result.success) {
    authLogger.warn('Invalid log level change attempted', { requested: level });
    return res.status(400).json(result);
  }

  authLogger.info('Log level changed via admin endpoint', {
    new_level: result.level,
    previous_level: result.previous_level,
    loggers_updated: result.loggers_updated,
  });

  res.json(result);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'auth-service',
  });
});

// ─── START SERVER + CONNECT DB ─────────────────────────────
app.listen(PORT, async () => {
  // INFO — service lifecycle event (business-relevant: "is the service running?")
  logger.info('Service started', {
    port: PORT,
    log_level: getLogLevel().current,
    environment: process.env.NODE_ENV || 'development',
  });

  // Database connection uses the db child logger for proper module tagging
  await connectDatabase(dbLogger);
});
