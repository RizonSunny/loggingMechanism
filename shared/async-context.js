const { AsyncLocalStorage } = require('async_hooks');

/**
 * AsyncLocalStorage — Node.js built-in (since v12.17, stable in v16+)
 *
 * WHAT IT DOES:
 * - Creates a "storage scope" that follows async operations automatically
 * - When middleware calls asyncLocalStorage.run(store, callback), everything
 *   inside that callback (and any async operations it spawns) can access `store`
 *   via asyncLocalStorage.getStore()
 *
 * WHY ONE SHARED INSTANCE:
 * - All services import this same instance
 * - The correlation middleware sets { trace_id } in the store
 * - The logger reads trace_id from the store automatically
 * - Business code never needs to know about trace_id at all
 *
 * USAGE:
 *   // In middleware:  asyncLocalStorage.run({ trace_id: 'abc' }, next)
 *   // Anywhere else:  asyncLocalStorage.getStore()?.trace_id → 'abc'
 */
const asyncLocalStorage = new AsyncLocalStorage();

module.exports = { asyncLocalStorage };
