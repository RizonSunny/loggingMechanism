const { v4: uuidv4 } = require('uuid');
const { asyncLocalStorage } = require('./async-context');

/**
 * Correlation ID Middleware
 *
 * WHAT IT DOES (3 steps):
 *
 * 1. CHECK: Does the incoming request have an `x-trace-id` header?
 *    - YES → use it (this request came from another service that already assigned one)
 *    - NO  → generate a new UUID (this is the first service in the chain)
 *
 * 2. STORE: Wrap the rest of the request handling inside asyncLocalStorage.run()
 *    - This makes { trace_id } available to ALL code in this request's async chain
 *    - The logger format reads it automatically — no manual passing needed
 *
 * 3. RESPOND: Set `x-trace-id` response header so the caller can see the trace_id
 *    - Useful for debugging: copy trace_id from response → search in Kibana
 *
 * USAGE:
 *   app.use(correlationMiddleware);
 *   // That's it. All subsequent middleware/routes automatically have trace_id.
 */
function correlationMiddleware(req, res, next) {
  // Step 1: Get or generate trace_id
  const traceId = req.headers['x-trace-id'] || uuidv4();

  // Step 3: Send trace_id back in response headers (for debugging)
  res.setHeader('x-trace-id', traceId);

  // Step 2: Run the rest of the request inside AsyncLocalStorage
  // Everything inside this callback (and its async children) can call
  // asyncLocalStorage.getStore() to get { trace_id: '...' }
  asyncLocalStorage.run({ trace_id: traceId }, () => {
    next();
  });
}

module.exports = { correlationMiddleware };
