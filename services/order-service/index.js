const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { createMultiLevelLogger, createChildLogger, setLogLevel, getLogLevel } = require('../../shared/multiLevelLogger');
const { createMorganMiddleware } = require('../../shared/morgan-stream');
const { createEventLogger } = require('../../shared/event-logger');
const { connectDatabase } = require('../../shared/database');

const app = express();
app.use(cors());
app.use(express.json());

// ─── INITIALIZE LOGGERS ────────────────────────────────────
// Uses createMultiLevelLogger for custom levels (fatal/trace) + runtime control + child loggers
const logger = createMultiLevelLogger({ service: 'order-service', version: '1.0.0' });

// Child loggers — each adds { module: '<name>' } to every log entry
const orderLogger = createChildLogger(logger, 'orders');
const dbLogger = createChildLogger(logger, 'database');

const eventLogger = createEventLogger(orderLogger);

// ─── SERVER LOG: Morgan ────────────────────────────────────
app.use(createMorganMiddleware(logger));

const PORT = process.env.PORT || 3002;

// In-memory order storage
const orders = [];

// Valid status transitions (state machine)
const VALID_TRANSITIONS = {
  pending:    ['confirmed', 'cancelled'],
  confirmed:  ['shipped', 'cancelled'],
  shipped:    ['delivered'],
  delivered:  [],  // terminal state
  cancelled:  [],  // terminal state
};

// -------------------------------------------------------
// POST /orders
//
// LOG LEVELS DEMONSTRATED:
//   trace  → input validation details
//   debug  → computed values (totals, IDs)
//   info   → business outcome (order created)
// -------------------------------------------------------
app.post('/orders', (req, res) => {
  console.log('\n═══════════ POST /orders | orders | order-service ═══════════');
  const { user_id, items } = req.body;

  // TRACE — what exact data did we receive? (deep diagnostic only)
  orderLogger.trace('Parsing order request body', {
    has_user_id: !!user_id,
    item_count: items ? items.length : 0,
  });

  const order_id = `ORD-${uuidv4().slice(0, 8).toUpperCase()}`;
  const total_amount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  // DEBUG — computed values useful for debugging price calculations
  orderLogger.debug('Order totals computed', {
    order_id,
    user_id,
    item_count: items.length,
    total_amount,
  });

  const order = {
    order_id,
    user_id,
    items,
    total_amount,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  orders.push(order);

  // INFO — business outcome: an order was created (production baseline log)
  orderLogger.info('Order created', {
    order_id,
    user_id,
    item_count: items.length,
    total_amount,
  });

  // EVENT LOG — domain event for analytics and downstream systems
  eventLogger.emit('ORDER_CREATED', {
    order_id,
    user_id,
    total_amount,
    item_count: items.length,
  });

  res.status(201).json(order);
});

// -------------------------------------------------------
// PATCH /orders/:id/status
//
// LOG LEVELS DEMONSTRATED:
//   trace  → state machine evaluation details
//   warn   → invalid transition attempted (expected but noteworthy)
//   info   → status change applied (business event)
// -------------------------------------------------------
app.patch('/orders/:id/status', (req, res) => {
  console.log('\n═══════════ PATCH /orders/:id/status | orders | order-service ═══════════');
  const { status: newStatus } = req.body;
  const order = orders.find(o => o.order_id === req.params.id);

  if (!order) {
    // WARN — not found is expected behavior (client error), not a system error
    orderLogger.warn('Status update failed — order not found', { order_id: req.params.id });
    return res.status(404).json({ error: 'Order not found' });
  }

  const oldStatus = order.status;
  const allowedTransitions = VALID_TRANSITIONS[oldStatus] || [];

  // TRACE — show the full state machine evaluation (deep diagnostic)
  orderLogger.trace('Evaluating status transition', {
    order_id: order.order_id,
    current_status: oldStatus,
    requested_status: newStatus,
    allowed_transitions: allowedTransitions,
    is_valid: allowedTransitions.includes(newStatus),
  });

  if (!allowedTransitions.includes(newStatus)) {
    // WARN — invalid transition is a client mistake, not a system error
    orderLogger.warn('Invalid status transition attempted', {
      order_id: order.order_id,
      current_status: oldStatus,
      requested_status: newStatus,
      allowed_transitions: allowedTransitions,
    });
    return res.status(400).json({
      error: `Cannot transition from '${oldStatus}' to '${newStatus}'`,
      allowed: allowedTransitions,
    });
  }

  // Apply the transition
  order.status = newStatus;

  // INFO — state change applied (business event — tells the story)
  orderLogger.info('Order status updated', {
    order_id: order.order_id,
    from_status: oldStatus,
    to_status: newStatus,
  });

  // EVENT LOG — domain event for downstream (notifications, analytics)
  eventLogger.emit('ORDER_STATUS_CHANGED', {
    order_id: order.order_id,
    user_id: order.user_id,
    from_status: oldStatus,
    to_status: newStatus,
  });

  res.json(order);
});

// -------------------------------------------------------
// GET /orders/:id
// -------------------------------------------------------
app.get('/orders/:id', (req, res) => {
  console.log('\n═══════════ GET /orders/:id | orders | order-service ═══════════');
  const order = orders.find(o => o.order_id === req.params.id);

  if (!order) {
    // WARN — resource not found (client error, not system error)
    orderLogger.warn('Order not found', { order_id: req.params.id });
    return res.status(404).json({ error: 'Order not found' });
  }

  // DEBUG — successful read operation (internal detail, not business event)
  orderLogger.debug('Order retrieved', { order_id: order.order_id, status: order.status });
  res.json(order);
});

// ─── ADMIN: Runtime log level management ────────────────────
app.get('/admin/log-level', (req, res) => {
  console.log('\n═══════════ GET /admin/log-level | orders | order-service ═══════════');
  res.json(getLogLevel());
});

app.post('/admin/log-level', (req, res) => {
  console.log('\n═══════════ POST /admin/log-level | orders | order-service ═══════════');
  const { level } = req.body;
  if (!level) {
    return res.status(400).json({ error: 'Missing "level" field in request body' });
  }

  const result = setLogLevel(level);
  if (!result.success) {
    return res.status(400).json(result);
  }

  orderLogger.info('Log level changed via admin endpoint', {
    new_level: result.level,
    previous_level: result.previous_level,
  });

  res.json(result);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'order-service' });
});

// ─── START SERVER + CONNECT DB ─────────────────────────────
app.listen(PORT, async () => {
  logger.info('Service started', {
    port: PORT,
    log_level: getLogLevel().current,
    environment: process.env.NODE_ENV || 'development',
  });
  await connectDatabase(dbLogger);
});
