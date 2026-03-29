# Part 4 — Async & Structured Logging: Changelog

## Overview

Part 4 added **asynchronous logging awareness**, **correlation IDs (trace_id)**, and **AsyncLocalStorage-based context propagation** to the multi-service e-commerce backend. A single user request (e.g., login) now flows through Auth → Order → Notification, with all logs across all three services tagged with the **same trace_id** — enabling full request tracing in Kibana via a single search.

---

## Key Concepts Introduced

### Sync vs Async Logging
- **Sync logging** (e.g., `console.log` to a terminal) blocks the Node.js event loop until the OS buffer accepts the write. At high throughput, this stalls request processing.
- **Async logging** pushes log entries to an in-memory buffer and returns immediately. The buffer drains to file/network in the background.
- Winston's **Console transport** is essentially sync. Its **File transport** uses Node.js streams (buffered/async).
- **Trade-off:** Buffered logs can be lost on crash. Mitigation: `process.on('exit', flush)`.

### Structured Logging (JSON)
- Already implemented in Parts 2-3. JSON format makes logs machine-parseable — no regex needed.
- Standard fields (`service`, `version`, `host`, `environment`, `trace_id`) are auto-injected via Winston's format pipeline.
- In Kibana: `trace_id:"abc-123"` instantly shows all logs from all services for one request.

### Correlation IDs (trace_id)
- A unique UUID that tags every log from the same request chain across services.
- Generated at the first service (Auth), propagated via `x-trace-id` HTTP header to downstream services.
- Downstream services reuse the received trace_id instead of generating a new one.

### AsyncLocalStorage
- Node.js built-in (`async_hooks` module, stable since v16+) — similar to Java's ThreadLocal but for async contexts.
- Carries request-scoped data (trace_id) through the entire async call chain without passing it as a function parameter.
- The logger reads trace_id from AsyncLocalStorage automatically — business code never touches it.

---

## New Files Created

### 1. `shared/async-context.js` — AsyncLocalStorage Singleton

**What:** A shared module that creates one `AsyncLocalStorage` instance for all services to import.

**What it provides:**
- A single `asyncLocalStorage` instance exported for use by the correlation middleware (writes trace_id) and the logger format (reads trace_id)

**How it works:**
- `asyncLocalStorage.run({ trace_id }, callback)` — creates a context scope; everything inside the callback (and its async children) can access the store
- `asyncLocalStorage.getStore()` — returns the current request's store (e.g., `{ trace_id: 'abc-123' }`) or `undefined` if outside a run scope

**Why a separate file:** The AsyncLocalStorage instance must be shared between the correlation middleware (which writes to it) and the logger format (which reads from it). A singleton module ensures both import the same instance.

**Necessity:** Without AsyncLocalStorage, trace_id would need to be passed as a parameter through every function call — impractical in real codebases with deep call stacks.

---

### 2. `shared/correlation-middleware.js` — Correlation ID Middleware

**What:** Express middleware that assigns a `trace_id` to every incoming request and propagates it via AsyncLocalStorage.

**What it does (3 steps):**
1. **CHECK:** Does the request have an `x-trace-id` header?
   - YES → reuse it (request came from another service in the chain)
   - NO → generate a new UUID (this is the first service in the chain)
2. **STORE:** Wrap `next()` inside `asyncLocalStorage.run({ trace_id }, ...)` so all downstream code can access trace_id automatically
3. **RESPOND:** Set `x-trace-id` response header so callers can see the trace_id (useful for debugging — copy from response, search in Kibana)

**Key lines explained:**
- `req.headers['x-trace-id'] || uuidv4()` — get existing or generate new
- `res.setHeader('x-trace-id', traceId)` — return to caller in response
- `asyncLocalStorage.run({ trace_id: traceId }, () => next())` — wrap remaining request handling in context scope

**Why:** Without correlation IDs, logs from 100 concurrent users across 3 services are an unsearchable mess. With trace_id, one Kibana query reconstructs the full request journey.

**Necessity:** Correlation IDs are the foundation of distributed tracing. This is what tools like Jaeger, Zipkin, and AWS X-Ray implement at scale. This middleware is a simplified version of the same concept.

---

## Modified Files

---

### 3. `shared/multiLevelLogger.js` — Auto-inject trace_id from AsyncLocalStorage

**What changed:**
- Added import: `const { asyncLocalStorage } = require('./async-context')`
- Added a new Winston format step in the `format.combine()` pipeline (between field enrichment and `json()`) that reads `trace_id` from AsyncLocalStorage and injects it into every log entry

**New format step:**
```js
winston.format((info) => {
  const store = asyncLocalStorage.getStore();
  if (store?.trace_id) {
    info.trace_id = store.trace_id;
  }
  return info;
})()
```

**How it works:**
- Every time a log is emitted, this format function runs
- It calls `asyncLocalStorage.getStore()` to check if there's a request context active
- If a trace_id exists in the store, it's added to the log entry
- If no context exists (e.g., startup logs, background tasks), trace_id is simply absent — no error

**Why:** This is the "magic" that connects correlation middleware to the logger. Business code calls `logger.info('Order created', { order_id })` — and trace_id appears in the output automatically without the developer knowing or caring about it.

**Necessity:** Manual `{ trace_id }` in every log call is error-prone and clutters business logic. Auto-injection ensures 100% of logs within a request context are tagged.

---

### 4. `services/auth-service/index.js` — Correlation Middleware + Cross-Service Call

**What changed:**
- Added imports: `correlationMiddleware` from `shared/correlation-middleware.js`, `asyncLocalStorage` from `shared/async-context.js`
- Added `app.use(correlationMiddleware)` before route handlers
- Made `POST /login` handler `async` (needed for `await fetch`)
- After successful login, added a cross-service call to Order Service (`POST http://localhost:3002/orders`) that:
  - Reads trace_id from AsyncLocalStorage via `asyncLocalStorage.getStore()`
  - Forwards it as `x-trace-id` HTTP header to Order Service
  - Logs the cross-service call at DEBUG level
  - Logs success/failure of the downstream call (INFO for success, WARN for failure — because login itself already succeeded)

**Key pattern — trace_id propagation:**
```js
const store = asyncLocalStorage.getStore();
const traceId = store?.trace_id;
await fetch('http://localhost:3002/orders', {
  headers: { 'x-trace-id': traceId }
});
```

**Why:** Auth is the entry point for the request chain. It generates the trace_id (via middleware) and must forward it to every downstream service call. The cross-service call demonstrates the Auth → Order link in the chain.

**Necessity:** Without forwarding the `x-trace-id` header, Order Service would generate a new trace_id and the chain would break.

---

### 5. `services/order-service/index.js` — Correlation Middleware + Cross-Service Call to Notification

**What changed:**
- Added imports: `correlationMiddleware` from `shared/correlation-middleware.js`, `asyncLocalStorage` from `shared/async-context.js`
- Added `app.use(correlationMiddleware)` before route handlers
- Made `POST /orders` handler `async`
- After creating an order, added a cross-service call to Notification Service (`POST http://localhost:3003/notify`) that:
  - Reads trace_id from AsyncLocalStorage
  - Forwards it as `x-trace-id` HTTP header to Notification Service
  - Sends notification details (type, recipient, order_id, message)

**Why:** Order Service is the middle of the chain (Auth → Order → Notification). It receives the trace_id from Auth's header and must forward it to Notification.

**Necessity:** Completes the 3-service chain. Without this, Notification Service logs would be disconnected from the originating login request.

---

### 6. `services/notification-service/index.js` — Correlation Middleware

**What changed:**
- Added import: `correlationMiddleware` from `shared/correlation-middleware.js`
- Added `app.use(correlationMiddleware)` before route handlers

**Why:** Notification Service is the end of the chain. It receives `x-trace-id` from Order Service's call, and the middleware stores it in AsyncLocalStorage. All notification logs then auto-include the same trace_id.

**Necessity:** Even though Notification doesn't call any further services, it still needs the middleware so its logs are tagged with the correct trace_id.

---

## Correlation ID Flow (Step by Step)

```
1. User sends POST /login to Auth Service (port 3001)
   → No x-trace-id header present

2. Auth's correlationMiddleware:
   → No header → generates UUID "94185144-696c-4e42-92bb-be5ffe28e6e2"
   → Stores in AsyncLocalStorage
   → Sets x-trace-id response header

3. Auth's route handler logs:
   → All logs auto-include trace_id:"94185144..." (via logger format)

4. Auth calls Order Service (port 3002):
   → fetch('http://localhost:3002/orders', { headers: { 'x-trace-id': '94185144...' } })

5. Order's correlationMiddleware:
   → Found x-trace-id header → REUSES "94185144..." (does NOT generate new)
   → Stores in AsyncLocalStorage

6. Order's route handler logs:
   → All logs auto-include trace_id:"94185144..." (same ID!)

7. Order calls Notification Service (port 3003):
   → fetch('http://localhost:3003/notify', { headers: { 'x-trace-id': '94185144...' } })

8. Notification's correlationMiddleware:
   → Found x-trace-id header → REUSES "94185144..."

9. Notification's route handler logs:
   → All logs auto-include trace_id:"94185144..."

RESULT: Kibana search trace_id:"94185144..." shows ALL logs from ALL 3 services
```

---

## Verified Test Output

One login request → trace_id `94185144` appears across all 3 services:

```
AUTH SERVICE (port 3001):
  [debug] trace=94185144 | Looking up user in database
  [info]  trace=94185144 | SECURITY: Authentication success
  [info]  trace=94185144 | EVENT: USER_LOGIN
  [info]  trace=94185144 | Login successful
  [debug] trace=94185144 | Calling order-service with trace_id
  [info]  trace=94185144 | Welcome order created via order-service
  [info]  trace=94185144 | HTTP request completed

ORDER SERVICE (port 3002):
  [debug] trace=94185144 | Order totals computed
  [info]  trace=94185144 | Order created
  [info]  trace=94185144 | EVENT: ORDER_CREATED
  [info]  trace=94185144 | Notification sent for order
  [info]  trace=94185144 | HTTP request completed

NOTIFICATION SERVICE (port 3003):
  [debug] trace=94185144 | Attempting notification delivery
  [info]  trace=94185144 | Notification sent successfully
  [info]  trace=94185144 | EVENT: NOTIFICATION_SENT
  [info]  trace=94185144 | HTTP request completed
```

Startup logs show `no-trace` — correct behavior, since they occur outside any request context.

---

## Exports from New Modules

### `shared/async-context.js`

| Export | Type | Purpose |
|--------|------|---------|
| `asyncLocalStorage` | AsyncLocalStorage instance | Shared context store for request-scoped data (trace_id) |

### `shared/correlation-middleware.js`

| Export | Type | Purpose |
|--------|------|---------|
| `correlationMiddleware` | Express middleware function | Generates/propagates trace_id, stores in AsyncLocalStorage |

---

## Project Structure After Part 4

```
ecommerce-logging/
├── PART-2-CHANGELOG.md
├── PART-3-CHANGELOG.md
├── PART-4-CHANGELOG.md              ← NEW
├── docker-compose.yml
├── package.json
├── server.js
├── public/
│   ├── Dockerfile
│   └── index.html
├── shared/
│   ├── async-context.js             ← NEW (AsyncLocalStorage singleton)
│   ├── correlation-middleware.js     ← NEW (trace_id generation + propagation)
│   ├── logger.js                    ← UNCHANGED (Part 2 base)
│   ├── multiLevelLogger.js          ← MODIFIED (auto-injects trace_id from AsyncLocalStorage)
│   ├── morgan-stream.js
│   ├── database.js
│   ├── event-logger.js
│   └── security-logger.js
└── services/
    ├── auth-service/
    │   ├── index.js                 ← MODIFIED (correlation middleware, cross-service call to Order)
    │   └── Dockerfile
    ├── order-service/
    │   ├── index.js                 ← MODIFIED (correlation middleware, cross-service call to Notification)
    │   └── Dockerfile
    └── notification-service/
        ├── index.js                 ← MODIFIED (correlation middleware)
        └── Dockerfile
```
