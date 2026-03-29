# Part 3 — Log Levels: Changelog

## Overview

Part 3 upgraded the logging infrastructure to support the **full industry-standard log level spectrum** (TRACE → DEBUG → INFO → WARN → ERROR → FATAL). Changes include custom Winston levels, environment-based level defaults, child loggers for per-module filtering, runtime log level changes via admin endpoints, and proper level usage across all services.

---

## New Files Created

### 1. `shared/multiLevelLogger.js` — Custom Levels, Child Loggers, Runtime Level Control

**What:** A new logger module that EXTENDS the original `logger.js` foundation with Part 3 features. Kept separate so `logger.js` remains the clean Part 2 base.

**What it provides:**
- `createMultiLevelLogger()` — like `createLogger()` but with custom 6-level severity spectrum: `fatal(0) → error(1) → warn(2) → info(3) → debug(4) → trace(5)`
- `LEVEL_BY_ENVIRONMENT` map with defaults for development (`debug`), test (`warn`), staging (`debug`), and production (`info`)
- `resolveLogLevel()` function that checks `LOG_LEVEL` env var first, then environment map, then falls back to `info`
- `loggerRegistry` — an array tracking all created loggers for bulk level updates
- `createChildLogger(parentLogger, moduleName)` — creates loggers that inherit parent config and add `{ module: '<name>' }` to every log
- `setLogLevel(newLevel)` — validates the level, updates all registered loggers, logs the change for audit
- `getLogLevel()` — returns current level and available options for introspection
- Custom colors for console output (fatal=magenta bold, error=red, warn=yellow, info=green, debug=cyan, trace=gray)

**Relationship to logger.js:**
- `shared/logger.js` (Part 2) → basic `createLogger()` with Winston's built-in npm levels. Unchanged.
- `shared/multiLevelLogger.js` (Part 3) → enhanced `createMultiLevelLogger()` with custom levels + child loggers + runtime control.
- Services import from `multiLevelLogger.js`. The original `logger.js` is still used by `server.js` (frontend) which doesn't need Part 3 features.

**Why separate file:** Keeps the Part 2 foundation clean and untouched. Each part of the study builds on top of the previous without modifying existing foundations. Clear separation of concerns.

**Necessity:** Log levels are the primary filter mechanism for log volume control. Without proper levels, production logs are either too noisy (everything at INFO) or too sparse (missing DEBUG for troubleshooting). The child logger pattern is essential for multi-module services where you need to trace which component produced a log.

---

## Modified Files

---

### 2. `services/auth-service/index.js` — Child Loggers + Admin Endpoints + Level Corrections

**What changed:**
- Switched import from `createLogger` (logger.js) to `createMultiLevelLogger` (multiLevelLogger.js)
- Created child loggers: `authLogger` (module: "auth") and `dbLogger` (module: "database")
- Wired security/event loggers through `authLogger` for proper module tagging
- Added TRACE-level logging for request body parsing (deep diagnostic)
- Added DEBUG-level logging for user lookup and failed attempt tracking
- Added `GET /admin/log-level` endpoint — returns current log level state
- Added `POST /admin/log-level` endpoint — changes log level at runtime with validation and audit logging
- Enhanced startup log to include resolved log level and environment
- Passed `dbLogger` to `connectDatabase()` for proper module tagging

**Why:** Single-logger services can't distinguish which component produced a log. With child loggers, filtering `module:"auth"` in Kibana shows only authentication logic, while `module:"database"` shows DB operations — from the same service. The admin endpoints enable runtime debugging without service restart.

**Necessity:** During production incidents, the ability to temporarily increase log verbosity to `debug` or `trace` without restarting (which changes system state) is critical. The child logger pattern is standard practice in microservice observability.

---

### 3. `services/order-service/index.js` — Child Loggers + Graduated Level Usage

**What changed:**
- Switched import from `createLogger` (logger.js) to `createMultiLevelLogger` (multiLevelLogger.js)
- Created child loggers: `orderLogger` (module: "orders") and `dbLogger` (module: "database")
- Added TRACE-level logging for request parsing and state machine evaluation details
- Split order creation logging: DEBUG for computed values, INFO for business outcome
- Added admin endpoints (`GET /admin/log-level`, `POST /admin/log-level`)
- Enhanced startup log with log level and environment

**Why:** The order service's state machine evaluation is complex (5 states, multiple valid/invalid transitions). TRACE logging shows the full evaluation path including `is_valid`, `allowed_transitions`, making it trivial to debug why a transition was accepted or rejected. But this detail is invisible in production (INFO level) — zero noise cost.

**Necessity:** The principle of "log generously, filter by level" means you add trace/debug logs at diagnostic points during development. They cost nothing in production because the level filter prevents them from being emitted. When an incident occurs, you enable debug temporarily and the diagnostic data is already in the code.

---

### 4. `services/notification-service/index.js` — Child Logger + Delivery Diagnostics

**What changed:**
- Switched import from `createLogger` (logger.js) to `createMultiLevelLogger` (multiLevelLogger.js)
- Created child logger: `notifyLogger` (module: "delivery")
- Added TRACE-level logging for request parsing
- Added DEBUG-level logging before delivery attempts (entry point — "what are we about to do?")
- Added admin endpoints for runtime level control
- Enhanced startup log with log level and environment

**Why:** Notification delivery has a 10% simulated failure rate, making it a frequent source of investigation. The DEBUG log before each attempt creates a clear entry→success/failure pattern. In development, you see: `debug: Attempting notification delivery` → `info: Notification sent successfully` or `error: Notification delivery failed`. In production, you only see the outcome.

**Necessity:** The entry→exit logging pattern (debug at entry, info/error at exit) is a best practice for troubleshooting. It answers both "what was the system trying to do?" and "did it succeed?"

---

### 5. `server.js` — Replaced console.log with Structured Logger

**What changed:**
- Added `const { createLogger } = require('./shared/logger')` import
- Created logger instance for the frontend service
- Replaced `console.log(...)` with `logger.info('API Tester UI started', { port, url })`

**Why:** `console.log` produces unstructured plain text with no timestamp, no level, no service name, and no JSON structure. It cannot be parsed by ELK, cannot be filtered by level, and won't appear in centralized logging pipelines.

**Necessity:** Every output from every process must go through the structured logger. A single `console.log` is a gap in observability — if the frontend server has issues, there's no way to find its logs in Kibana.

---

### 6. `shared/database.js` — Split Query Logging into TRACE + DEBUG

**What changed:**
- Query profiling now logs at two levels:
  - TRACE: Full query details (filter content, args count) — `event: 'query_detail'`
  - DEBUG: Query summary (collection + method only) — `event: 'query'`

**Why:** Previously, every query logged at DEBUG with the full query filter. This is too much detail for normal development (hundreds of queries per request). Now:
- In production (INFO): No query logs (correct — they're internal details)
- In development (DEBUG): Brief query summaries (collection + method)
- During deep debugging (TRACE): Full query filters and argument counts

**Necessity:** Database query logging is high-volume. A service making 50 DB queries per request generates 50 debug logs. With the TRACE/DEBUG split, normal development sees only brief summaries, while active debugging gets the full picture.

---

### 7. `public/index.html` — Log Level Admin Panel

**What changed:**
- Added a new "Log Level Admin" card to the UI with:
  - `GET /admin/log-level` — check current level of any service
  - `POST /admin/log-level` — change level at runtime with dropdown selector
  - Service selector (auth/order/notification)
  - Level dropdown with descriptions (fatal through trace)
  - Guided "Try this" section explaining how to test runtime level changes
- Added `getLogLevel()` and `changeLogLevel()` JavaScript functions
- Updated tip section to mention the new `module` field and admin panel

**Why:** The admin panel makes runtime level changes accessible without needing curl/Postman. During the learning exercise, you can change a service to `trace`, make API calls, watch the detailed logs appear, then switch back to `info`.

**Necessity:** Demonstrates the practical workflow of runtime log level management that on-call engineers use in production incidents.

---

## Exports from `shared/multiLevelLogger.js`

| Export | Type | Purpose |
|--------|------|---------|
| `createMultiLevelLogger()` | Function | Creates a parent logger with custom levels (fatal→trace) + env config |
| `createChildLogger()` | Function | Creates a child logger with a `module` field |
| `setLogLevel()` | Function | Changes log level of ALL registered loggers at runtime |
| `getLogLevel()` | Function | Returns current level, available levels, and registry count |
| `CUSTOM_LEVELS` | Object | Level definitions and colors (for reference/validation) |

## Exports from `shared/logger.js` (unchanged from Part 2)

| Export | Type | Purpose |
|--------|------|---------|
| `createLogger()` | Function | Basic structured JSON logger with Winston npm defaults. Used by `server.js`. |

## New Admin Endpoints (All Services)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/admin/log-level` | Returns current log level and available options |
| `POST` | `/admin/log-level` | Changes log level at runtime. Body: `{ "level": "debug" }` |

## Custom Log Levels

| Level | Priority | When to Use |
|-------|----------|-------------|
| `fatal` | 0 (highest) | System cannot continue — unrecoverable failure |
| `error` | 1 | Operation failed — actionable, should trigger alerts |
| `warn` | 2 | Unexpected but handled — early signal of trouble |
| `info` | 3 | Business-relevant event — production baseline |
| `debug` | 4 | Internal system behavior — development visibility |
| `trace` | 5 (lowest) | Ultra-granular step-by-step — active debugging only |

## Environment Level Defaults

| Environment | Default Level | Override |
|-------------|---------------|----------|
| development | `debug` | `LOG_LEVEL` env var |
| staging | `debug` | `LOG_LEVEL` env var |
| production | `info` | `LOG_LEVEL` env var |
| test | `warn` | `LOG_LEVEL` env var |

## Project Structure After Part 3

```
ecommerce-logging/
├── PART-2-CHANGELOG.md
├── PART-3-CHANGELOG.md              ← NEW
├── docker-compose.yml
├── package.json
├── server.js                        ← MODIFIED (console.log → logger.info, uses logger.js)
├── public/
│   ├── Dockerfile
│   └── index.html                   ← MODIFIED (added Log Level Admin panel)
├── shared/
│   ├── logger.js                    ← UNCHANGED (Part 2 base — basic createLogger)
│   ├── multiLevelLogger.js          ← NEW (Part 3 — custom levels, child loggers, runtime control)
│   ├── morgan-stream.js
│   ├── database.js                  ← MODIFIED (TRACE + DEBUG split for query logging)
│   ├── event-logger.js
│   └── security-logger.js
└── services/
    ├── auth-service/
    │   ├── index.js                 ← MODIFIED (uses multiLevelLogger, child loggers, admin endpoints)
    │   └── Dockerfile
    ├── order-service/
    │   ├── index.js                 ← MODIFIED (uses multiLevelLogger, child loggers, admin endpoints)
    │   └── Dockerfile
    └── notification-service/
        ├── index.js                 ← MODIFIED (uses multiLevelLogger, child logger, admin endpoints)
        └── Dockerfile
```
