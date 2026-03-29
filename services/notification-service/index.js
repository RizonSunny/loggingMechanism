const express = require('express');
const cors = require('cors');
const { createMultiLevelLogger, createChildLogger, setLogLevel, getLogLevel } = require('../../shared/multiLevelLogger');
const { createMorganMiddleware } = require('../../shared/morgan-stream');
const { createEventLogger } = require('../../shared/event-logger');

const app = express();
app.use(cors());
app.use(express.json());

// ─── INITIALIZE LOGGERS ────────────────────────────────────
// Uses createMultiLevelLogger for custom levels (fatal/trace) + runtime control + child loggers
const logger = createMultiLevelLogger({ service: 'notification-service', version: '1.0.0' });

// Child loggers for this service's modules
const notifyLogger = createChildLogger(logger, 'delivery');

const eventLogger = createEventLogger(notifyLogger);

// ─── SERVER LOG: Morgan ────────────────────────────────────
app.use(createMorganMiddleware(logger));

const PORT = process.env.PORT || 3003;

// -------------------------------------------------------
// POST /notify
//
// LOG LEVELS DEMONSTRATED:
//   trace  → delivery attempt details
//   debug  → provider selection / delivery simulation
//   info   → notification sent (business outcome)
//   error  → delivery failure (actual failure that needs attention)
// -------------------------------------------------------
app.post('/notify', (req, res) => {
  process.stderr.write('\n\x1b[1m\x1b[33m═══════════ POST /notify | delivery | notification-service ═══════════\x1b[0m\n');
  const { type, recipient, order_id, message } = req.body;

  // TRACE — raw request details (deep diagnostic)
  notifyLogger.trace('Parsing notification request', {
    has_type: !!type,
    has_recipient: !!recipient,
    has_order_id: !!order_id,
  });

  // DEBUG — what we're about to attempt (internal system step)
  notifyLogger.debug('Attempting notification delivery', {
    type,
    recipient,
    order_id,
    provider: 'simulated',
  });

  // Simulate a random failure (10% chance)
  if (Math.random() < 0.1) {
    const error = new Error('Email provider timeout');

    // ERROR — actual failure: we couldn't deliver the notification
    // This is a real error because the operation the user requested could not be completed
    notifyLogger.error('Notification delivery failed', {
      type,
      recipient,
      order_id,
      error_message: error.message,
    });

    // EVENT LOG — failure event (can trigger retry logic)
    eventLogger.emit('NOTIFICATION_FAILED', {
      type,
      recipient,
      order_id,
      reason: error.message,
    });

    return res.status(500).json({ error: 'Delivery failed' });
  }

  // INFO — business outcome: notification was sent successfully
  notifyLogger.info('Notification sent successfully', { type, recipient, order_id });

  // EVENT LOG — success event (for analytics: "how many emails sent today?")
  eventLogger.emit('NOTIFICATION_SENT', {
    type,
    recipient,
    order_id,
  });

  res.json({ status: 'sent', type, recipient });
});

// ─── ADMIN: Runtime log level management ────────────────────
app.get('/admin/log-level', (req, res) => {
  process.stderr.write('\n\x1b[1m\x1b[33m═══════════ GET /admin/log-level | delivery | notification-service ═══════════\x1b[0m\n');
  res.json(getLogLevel());
});

app.post('/admin/log-level', (req, res) => {
  process.stderr.write('\n\x1b[1m\x1b[33m═══════════ POST /admin/log-level | delivery | notification-service ═══════════\x1b[0m\n');
  const { level } = req.body;
  if (!level) {
    return res.status(400).json({ error: 'Missing "level" field in request body' });
  }

  const result = setLogLevel(level);
  if (!result.success) {
    return res.status(400).json(result);
  }

  notifyLogger.info('Log level changed via admin endpoint', {
    new_level: result.level,
    previous_level: result.previous_level,
  });

  res.json(result);
});

// Health check
app.get('/health', (req, res) => {
  process.stderr.write('\n\x1b[1m\x1b[33m═══════════ GET /health | delivery | notification-service ═══════════\x1b[0m\n');
  res.json({ status: 'ok', service: 'notification-service' });
});

app.listen(PORT, () => {
  logger.info('Service started', {
    port: PORT,
    log_level: getLogLevel().current,
    environment: process.env.NODE_ENV || 'development',
  });
});
