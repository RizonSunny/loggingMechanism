/**
 * Creates a domain event logger.
 *
 * WHY THIS EXISTS:
 * ─────────────────
 * Event logs are different from regular application logs:
 *
 *   Application log:  "Order created"           → tells you what your CODE did
 *   Event log:        "EVENT: ORDER_CREATED"     → tells you what HAPPENED in the business
 *
 * Event logs:
 *   - Have a standardized event_type field (for filtering/aggregation)
 *   - Are used for analytics ("how many orders per hour?")
 *   - Can trigger downstream systems (order created → send notification)
 *   - Can be replayed for event sourcing
 *   - Always use log_type: "event" so you can filter them in Kibana
 *
 * USAGE:
 *   const eventLogger = createEventLogger(logger);
 *   eventLogger.emit('ORDER_CREATED', { order_id: 'ORD-123', total: 99.99 });
 *   eventLogger.emit('ORDER_STATUS_CHANGED', { order_id: 'ORD-123', from: 'pending', to: 'confirmed' });
 */
function createEventLogger(logger) {
  return {
    /**
     * Log a domain event.
     * @param {string} eventType - Event name in UPPER_SNAKE_CASE (e.g., ORDER_CREATED)
     * @param {Object} payload - Event-specific data
     */
    emit(eventType, payload = {}) {
      logger.info(`EVENT: ${eventType}`, {
        log_type: 'event',
        event_type: eventType,
        ...payload,
        event_timestamp: new Date().toISOString(),
      });
    },
  };
}

module.exports = { createEventLogger };
