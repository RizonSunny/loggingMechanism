# Part 2 — Log Types: Changelog

## Overview

Part 2 added **6 log type categories** to our project: Application, Server (Access), Database, Event, Security, and Container logs. Each log type now has a dedicated utility and produces structured JSON with a `log_type` field so logs can be filtered/categorized in ELK later.

---

## New Files Created

### 1. `shared/morgan-stream.js` — Server/Access Log Bridge

**What:** Morgan middleware that pipes HTTP access logs into Winston as structured JSON.

**Why:** Morgan (HTTP logger) and Winston (application logger) are separate systems by default. Morgan writes plain text to stdout (`POST /login 200 12ms`), but we need ALL logs in the same structured JSON format so ELK can parse them uniformly. This bridge:
- Captures every HTTP request/response at the server level
- Converts it to structured JSON with fields: `method`, `url`, `status`, `response_time_ms`, `remote_addr`, `user_agent`
- Adds `log_type: "access"` to distinguish server logs from app logs
- Auto-selects log level based on status code: 2xx/3xx → `info`, 4xx → `warn`, 5xx → `error`
- Returns `null` to suppress Morgan's default stdout output (Winston handles all output)

**Necessity:** Without this, you'd have two separate log streams (Morgan plain text + Winston JSON) that can't be queried together in Kibana. With this, every log — whether HTTP-level or business-level — has the same shape.

---

### 2. `shared/database.js` — MongoDB Connection & Query Logging

**What:** A `connectDatabase()` function that wraps Mongoose connection with full lifecycle logging.

**Why:** Database issues are invisible without DB-specific logs. This captures:
- **Connection events**: `connecting`, `connected`, `disconnected`, `reconnected`, `error` — so you know if the DB is reachable
- **Query profiling**: Every DB query is logged with `collection`, `method`, and `query` filter — so you can spot slow/problematic queries
- **Credential masking**: The MongoDB URI is sanitized before logging (`//user:pass@` → `//***:***@`) to avoid leaking credentials
- All logs tagged with `log_type: "database"` for filtering

**Necessity:** When a service is slow or unresponsive, the first question is often "is the DB okay?" Without database logs, you have no visibility into connection health, query patterns, or errors. In production, these logs help you detect connection pool exhaustion, slow queries, and failover events.

---

### 3. `shared/event-logger.js` — Domain Event Logger

**What:** A `createEventLogger(logger)` factory that provides an `emit(eventType, payload)` method for logging business domain events.

**Why:** Event logs are fundamentally different from application logs:

| Application Log | Event Log |
|---|---|
| "Order created" — what the **code** did | `EVENT: ORDER_CREATED` — what **happened** in the business |
| Developer-focused | Business/analytics-focused |
| Free-form messages | Standardized `event_type` field |

Event logs:
- Have a consistent `event_type` field in `UPPER_SNAKE_CASE` for aggregation (`ORDER_CREATED`, `ORDER_STATUS_CHANGED`, `USER_LOGIN`)
- Are tagged with `log_type: "event"` for Kibana filtering
- Include an `event_timestamp` for precise event timing
- Can feed analytics ("how many orders per hour?") and trigger downstream systems

**Necessity:** Without event logs, you can't distinguish "what the code did" from "what happened in the business." In Kibana, filtering `log_type: "event"` gives you a clean audit trail of all business events — useful for analytics, debugging, and compliance.

---

### 4. `shared/security-logger.js` — Security Event Logger

**What:** A `createSecurityLogger(logger)` factory with typed methods: `authSuccess()`, `authFailure()`, `accessDenied()`, `suspiciousActivity()`, `adminAction()`.

**Why:** Security logs answer "is someone trying to break in?" and are treated specially:
- **Stored longer** (90+ days vs 7-30 days for app logs) for compliance
- **May be immutable** (append-only, no deletion allowed)
- **Feed SIEM tools** (Security Information and Event Management)
- **Audited** during compliance reviews (SOC2, GDPR, ISO 27001)

Each method enforces a consistent schema:
- `authSuccess` / `authFailure` — always log `username`, `ip`, `reason`
- `accessDenied` — logs `resource` and `required_role`
- `suspiciousActivity` — logged at `error` level for immediate alerting
- `adminAction` — tracks privileged operations for audit

All tagged with `log_type: "security"` and a specific `security_event` type (`AUTH_SUCCESS`, `AUTH_FAILURE`, `SUSPICIOUS_ACTIVITY`, etc.)

**Necessity:** Without dedicated security logging, auth failures get mixed in with normal app logs and are hard to find. Security logs need to be filterable, alertable, and retainable separately. In Kibana, querying `log_type: "security" AND security_event: "AUTH_FAILURE"` instantly shows all failed login attempts.

---

## Modified Files

### 5. `services/auth-service/index.js` — Added All Log Types

**What changed:**
- Added `morgan`, `security-logger`, `event-logger`, `database` imports
- Added Morgan middleware (`createMorganMiddleware`) — every HTTP request now produces a server/access log automatically
- Replaced simple `logger.warn('Login failed')` with typed security logs:
  - `securityLogger.authFailure()` on wrong password / unknown user
  - `securityLogger.authSuccess()` on valid login
  - `securityLogger.suspiciousActivity()` after 5+ failed attempts from same IP
- Added `eventLogger.emit('USER_LOGIN')` on successful login
- Added `connectDatabase(logger)` call on startup
- Added `loginAttempts` tracking map for brute-force detection

**Why:** Auth service is the most security-sensitive service. A single login attempt now produces up to 4 log types:
1. **Server log** (Morgan): `POST /login 401 8ms` — HTTP layer
2. **Application log**: `Login attempt received` — business logic flow
3. **Security log**: `SECURITY: Authentication failed` — security audit
4. **Event log**: `EVENT: USER_LOGIN` — domain event (on success only)

**Necessity:** In a real system, the auth service is the #1 target for attacks. Without security-specific logging, you can't detect brute force, track who logged in when, or satisfy compliance audits. The `trackFailedAttempt()` function demonstrates how logs can trigger real-time security alerting.

---

### 6. `services/order-service/index.js` — Added Event Logs + Status Changes

**What changed:**
- Added `morgan`, `event-logger`, `database` imports
- Added Morgan middleware for HTTP access logging
- Added `eventLogger.emit('ORDER_CREATED')` when an order is created
- **New endpoint: `PATCH /orders/:id/status`** — changes order status with state machine validation
- Added `eventLogger.emit('ORDER_STATUS_CHANGED')` with `from_status` and `to_status` fields
- Added `VALID_TRANSITIONS` state machine: `pending → confirmed → shipped → delivered` (with `cancelled` as terminal)
- Added validation logging for invalid transitions (what was attempted, what's allowed)
- Added `connectDatabase(logger)` call on startup

**Why:** Order status changes are critical domain events. The new `PATCH /orders/:id/status` endpoint demonstrates:
- **Event logging for state transitions**: every status change produces an `ORDER_STATUS_CHANGED` event with `from_status` and `to_status` — essential for tracking order lifecycle
- **Decision point logging**: when an invalid transition is attempted (e.g., `delivered → pending`), the log captures *what was attempted* and *what was allowed* — invaluable for debugging
- **State machine pattern**: real e-commerce systems use state machines; our logs capture the full transition history

**Necessity:** Without event logs for status changes, you can't answer "what happened to order ORD-123?" In Kibana, filtering `event_type: "ORDER_STATUS_CHANGED" AND order_id: "ORD-123"` shows the complete lifecycle of any order.

---

### 7. `services/notification-service/index.js` — Added Event Logs

**What changed:**
- Added `morgan`, `event-logger` imports
- Added Morgan middleware for HTTP access logging
- Added `eventLogger.emit('NOTIFICATION_SENT')` on success
- Added `eventLogger.emit('NOTIFICATION_FAILED')` on failure (with `reason` field)

**Why:** Notification failures are critical — a user might not receive their order confirmation. Event logs distinguish between "the HTTP call to `/notify` succeeded (200)" and "the notification was actually delivered." The failure event can trigger retry logic in a real system.

**Necessity:** Without notification events, you can't answer "did user X actually receive their email for order ORD-123?" Monitoring `event_type: "NOTIFICATION_FAILED"` in Kibana lets you alert on delivery failures.

---

### 8. `public/index.html` — New Frontend Test Features

**What changed:**
- Added `.method.patch` CSS class for PATCH badge styling (yellow)
- **New: `PATCH /orders/:id/status` section** in Order Service card with status dropdown (`confirmed`, `shipped`, `delivered`, `cancelled`)
- **New: "Full Lifecycle" button** (`testFullLifecycle()`) — creates an order and transitions it through `pending → confirmed → shipped → delivered` in one click, producing 4 event logs
- **New: "Brute Force (6x)" button** (`bruteForce()`) — sends 6 failed logins to trigger `SUSPICIOUS_ACTIVITY` security alert after the 5th attempt
- Auto-fills order ID in both GET and STATUS fields after creating an order
- Updated tip section to explain `log_type` field categories

**Why:** The frontend makes it easy to trigger different log types without using curl. Each button is designed to produce specific log patterns:
- **"Full Lifecycle"** → produces `ORDER_CREATED` + 3× `ORDER_STATUS_CHANGED` event logs
- **"Brute Force"** → produces 6× `AUTH_FAILURE` + 2× `SUSPICIOUS_ACTIVITY` security logs
- **"Send 10x"** → produces mix of `NOTIFICATION_SENT` and `NOTIFICATION_FAILED` event logs

**Necessity:** Learning is faster when you can see cause and effect immediately. Click a button → see the exact structured JSON log in the terminal → understand which log type was produced and why.

---

### 9. `package.json` — New Dependencies

**Added:**
- `morgan` — HTTP request logging middleware for Express
- `mongoose` — MongoDB ODM (for database connection and query logging)

**Why:** Morgan provides server-level access logs. Mongoose provides the connection lifecycle events and query profiling hooks we need for database logs.

---

## New `log_type` Field Values

Every log now includes a `log_type` field for easy filtering:

| `log_type` | Source | Example filter in Kibana |
|---|---|---|
| `access` | Morgan (server logs) | `log_type: "access" AND status >= 500` |
| `event` | Event logger (domain events) | `log_type: "event" AND event_type: "ORDER_CREATED"` |
| `security` | Security logger (auth events) | `log_type: "security" AND security_event: "AUTH_FAILURE"` |
| `database` | Database module (MongoDB) | `log_type: "database" AND event: "disconnected"` |
| *(none)* | Regular application logs | `NOT log_type: *` (logs without log_type) |

---

## Project Structure After Part 2

```
ecommerce-logging/
├── package.json                          (updated: +morgan, +mongoose)
├── server.js                             (unchanged — static file server)
├── public/
│   └── index.html                        (updated: +PATCH status, +brute force, +lifecycle)
├── shared/
│   ├── logger.js                         (unchanged — base Winston logger)
│   ├── morgan-stream.js                  ✨ NEW — Morgan-to-Winston bridge
│   ├── database.js                       ✨ NEW — MongoDB connection logging
│   ├── event-logger.js                   ✨ NEW — Domain event logger
│   └── security-logger.js               ✨ NEW — Security event logger
└── services/
    ├── auth-service/index.js             (updated: +morgan, +security, +events, +db)
    ├── order-service/index.js            (updated: +morgan, +events, +status endpoint, +db)
    └── notification-service/index.js     (updated: +morgan, +events)
```
