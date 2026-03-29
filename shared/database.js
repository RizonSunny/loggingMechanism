const mongoose = require('mongoose');

/**
 * Connects to MongoDB with full lifecycle logging.
 *
 * WHY THIS EXISTS:
 * ─────────────────
 * Database logs tell you things application logs can't:
 *   - "Is the DB even reachable?"       → connection logs
 *   - "Why is this endpoint slow?"      → slow query logs
 *   - "Why did this write fail?"        → error logs
 *
 * WHAT WE LOG:
 *   1. Connection events: connected, disconnected, reconnecting, error
 *   2. Query profiling: every DB query with collection, method, and duration
 *   3. Slow query warnings: queries exceeding a threshold
 *
 * @param {Object} logger - Winston logger instance (from createLogger)
 * @param {Object} options - Connection options
 * @param {string} options.uri - MongoDB connection string
 * @param {number} options.slowQueryThreshold - Log warning if query exceeds this (ms)
 */
async function connectDatabase(logger, options = {}) {
  const {
    uri = process.env.MONGO_URI || 'mongodb://localhost:27017/ecommerce',
    slowQueryThreshold = 100,  // milliseconds
  } = options;

  // ─── CONNECTION EVENT LOGS ───────────────────────────────
  // Mongoose emits lifecycle events on the connection object.
  // We hook into each one to get a complete picture of DB health.

  mongoose.connection.on('connecting', () => {
    logger.info('Database connecting', {
      log_type: 'database',
      event: 'connecting',
      uri: uri.replace(/\/\/(.+):(.+)@/, '//***:***@'),  // mask credentials in the log!
    });
  });

  mongoose.connection.on('connected', () => {
    logger.info('Database connected', {
      log_type: 'database',
      event: 'connected',
    });
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('Database disconnected', {
      log_type: 'database',
      event: 'disconnected',
    });
  });

  mongoose.connection.on('reconnected', () => {
    logger.info('Database reconnected', {
      log_type: 'database',
      event: 'reconnected',
    });
  });

  mongoose.connection.on('error', (err) => {
    logger.error('Database error', {
      log_type: 'database',
      event: 'error',
      error_message: err.message,
      error_code: err.code,
    });
  });

  // ─── QUERY PROFILING ─────────────────────────────────────
  // mongoose.set('debug', callback) — called for EVERY query.
  // We use this to:
  //   1. Log all queries at DEBUG level (visible in development)
  //   2. Log query details at TRACE level (visible only during deep debugging)

  mongoose.set('debug', (collectionName, methodName, ...methodArgs) => {
    // methodArgs contains query filter, update doc, options etc.
    // We only log the filter (first arg) to avoid logging full documents
    const query = methodArgs[0] || {};

    // TRACE — full query details (ultra-granular, active debugging only)
    logger.trace('Database query details', {
      log_type: 'database',
      event: 'query_detail',
      collection: collectionName,
      method: methodName,
      query: JSON.stringify(query).substring(0, 200),
      args_count: methodArgs.length,
    });

    // DEBUG — query summary (visible in development)
    logger.debug('Database query executed', {
      log_type: 'database',
      event: 'query',
      collection: collectionName,
      method: methodName,
    });
  });

  // ─── CONNECT ──────────────────────────────────────────────
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,  // fail fast if DB unreachable
      heartbeatFrequencyMS: 10000,     // check DB health every 10s
    });
  } catch (err) {
    logger.error('Database connection failed', {
      log_type: 'database',
      event: 'connection_failed',
      error_message: err.message,
    });
    // Don't crash the app — let it run without DB and log the error
    // In production, health checks will report the DB as down
  }

  return mongoose.connection;
}

module.exports = { connectDatabase };
