# Logging Mechanism Mastery — E-Commerce Backend

A hands-on study project for mastering **structured logging** in a Node.js microservices architecture. Built incrementally across multiple parts, each focusing on a core logging concept.

## Tech Stack

- **Runtime:** Node.js 18
- **Framework:** Express.js
- **Logging:** Winston 3
- **HTTP Logging:** Morgan (bridged to Winston)
- **Database:** MongoDB via Mongoose
- **Containerization:** Docker + Docker Compose
- **Future:** ELK Stack (Elasticsearch, Logstash, Kibana)

## Project Structure

```
ecommerce-logging/
├── server.js                        → Frontend UI server (port 3000)
├── docker-compose.yml               → 4-service orchestration
├── package.json
├── .gitignore
├── PART-2-CHANGELOG.md              → Part 2 detailed changes
├── PART-3-CHANGELOG.md              → Part 3 detailed changes
├── PART-4-CHANGELOG.md              → Part 4 detailed changes
├── PART-5-CHANGELOG.md              → Part 5 detailed changes
├── public/
│   ├── index.html                   → Interactive API tester UI
│   └── Dockerfile
├── shared/                          → Logging utilities (shared across services)
│   ├── logger.js                    → Base Winston logger factory (Part 2)
│   ├── multiLevelLogger.js          → Enhanced logger with custom levels (Part 3)
│   ├── morgan-stream.js             → Morgan-to-Winston bridge (access logs)
│   ├── database.js                  → MongoDB connection + query logging
│   ├── event-logger.js              → Domain event logger
│   ├── security-logger.js           → Security/auth event logger
│   ├── async-context.js             → Shared AsyncLocalStorage instance (Part 4)
│   ├── correlation-middleware.js     → Trace ID generation + propagation (Part 4)
│   ├── rotate-transport.js          → Daily rotating file transport factory (Part 5)
│   └── audit-logger.js              → Append-only compliance audit logger (Part 5)
├── logs/                            → Generated log files (gitignored)
│   ├── {service}-{date}.log         → All logs, daily rotation, 14d retention
│   ├── {service}-error-{date}.log   → Error-only logs, 30d retention
│   └── audit/
│       └── {service}-audit-{date}.log → Audit trail, 90d retention, hash-chained
└── services/
    ├── auth-service/                → Authentication (port 3001)
    │   ├── index.js
    │   └── Dockerfile
    ├── order-service/               → Order management (port 3002)
    │   ├── index.js
    │   └── Dockerfile
    └── notification-service/        → Notifications (port 3003)
        ├── index.js
        └── Dockerfile
```

## Services

| Service | Port | Purpose |
|---------|------|---------|
| Frontend UI | 3000 | Interactive API tester with buttons for all endpoints |
| Auth Service | 3001 | Login, brute-force detection, security logging |
| Order Service | 3002 | Order CRUD, state machine (pending → confirmed → shipped → delivered) |
| Notification Service | 3003 | Email/SMS/push delivery with simulated 10% failure rate |

## What's Covered

### Part 2 — Log Types

Established **6 log type categories**, each with a dedicated utility and a `log_type` field for filtering in ELK:

| Log Type | Field Value | Source | Purpose |
|----------|-------------|--------|---------|
| Application | _(default)_ | `logger.info/warn/error` | Business logic flow |
| Server/Access | `access` | `morgan-stream.js` | Every HTTP request/response |
| Database | `database` | `database.js` | Connection lifecycle + query profiling |
| Event | `event` | `event-logger.js` | Domain events (ORDER_CREATED, USER_LOGIN) |
| Security | `security` | `security-logger.js` | Auth attempts, suspicious activity, admin actions |
| Container | _(Docker stdout)_ | Docker runtime | Container-level logs |

**Key utilities built:**
- `createLogger()` — Base structured JSON logger with standard fields (service, environment, host, version, timestamp)
- `createMorganMiddleware()` — Bridges Morgan HTTP logs into Winston as structured JSON
- `connectDatabase()` — MongoDB connection with lifecycle logging and query profiling
- `createEventLogger()` — Domain event logger with standardized `event_type` field
- `createSecurityLogger()` — Typed security methods (authSuccess, authFailure, suspiciousActivity, etc.)

### Part 3 — Log Levels

Built on top of Part 2 with the **full industry-standard log level spectrum** and runtime control:

| Level | Priority | When to Use |
|-------|----------|-------------|
| `fatal` | 0 (highest) | System cannot continue — unrecoverable failure |
| `error` | 1 | Operation failed — actionable, should trigger alerts |
| `warn` | 2 | Unexpected but handled — early signal of trouble |
| `info` | 3 | Business-relevant event — production baseline |
| `debug` | 4 | Internal system behavior — development visibility |
| `trace` | 5 (lowest) | Ultra-granular step-by-step — active debugging only |

**Key features built:**
- `createMultiLevelLogger()` — Enhanced logger with custom 6-level severity spectrum
- `createChildLogger()` — Per-module loggers that add a `module` field (auth, orders, database, delivery)
- `setLogLevel()` / `getLogLevel()` — Runtime log level changes without restart
- Environment-based level defaults (dev=debug, staging=debug, prod=info, test=warn)
- `LOG_LEVEL` env var override for Docker/K8s configuration
- Admin endpoints (`GET/POST /admin/log-level`) on all services
- Log Level Admin panel in the UI for interactive level changes

**Environment defaults:**

| Environment | Default Level | Override |
|-------------|---------------|----------|
| development | `debug` | `LOG_LEVEL` env var |
| staging | `debug` | `LOG_LEVEL` env var |
| production | `info` | `LOG_LEVEL` env var |
| test | `warn` | `LOG_LEVEL` env var |

### Part 4 — Correlation IDs & Async Context

Added **cross-service request tracing** using correlation IDs (trace_id) that propagate across service boundaries, powered by Node.js AsyncLocalStorage.

**The problem solved:** When a login request triggers calls to order-service and notification-service, how do you find ALL logs from ALL services for that single user action? Without correlation, you'd be searching three different log streams with no way to connect them.

**How it works:**

```
User → POST /login → auth-service (trace_id: abc-123)
                          │
                          ├→ POST /orders → order-service (x-trace-id: abc-123)
                          │                      │
                          │                      └→ POST /notify → notification-service (x-trace-id: abc-123)
                          │
                          └→ All 3 services log trace_id: "abc-123"
                             → Search Kibana: trace_id:"abc-123" → full request story
```

**Key features built:**
- `asyncLocalStorage` (async-context.js) — Shared AsyncLocalStorage instance so trace_id follows async operations automatically without manual passing
- `correlationMiddleware` (correlation-middleware.js) — Express middleware that generates or accepts `x-trace-id`, stores it in AsyncLocalStorage, and returns it in response headers
- Auto-injection in `multiLevelLogger.js` — Logger format reads trace_id from AsyncLocalStorage context, zero manual effort in business code
- Cross-service propagation — Services forward `x-trace-id` header when calling other services

**Trace ID flow per request:**
1. Request arrives → middleware checks for `x-trace-id` header
2. If present → reuse it (request came from another service)
3. If absent → generate new UUID (this is the origin service)
4. Store in AsyncLocalStorage → available to all async code in this request
5. Logger format auto-reads it → every log entry gets `trace_id` field
6. Outbound HTTP calls forward it via `x-trace-id` header

### Part 5 — Log Rotation & Retention Policies

Added **file-based log rotation** with compression, retention policies, Docker log driver configuration, and a compliance-ready audit logger.

**The problem solved:** Without rotation, log files grow unbounded until the disk fills up — crashing the database, Docker daemon, and the services themselves. Part 5 adds size limits, automatic cleanup, and tiered retention.

**Log file structure:**

```
logs/
  auth-service-2026-03-30.log            ← ALL logs (active, uncompressed)
  auth-service-2026-03-29.log.gz         ← Yesterday (rotated, compressed ~10:1)
  auth-service-error-2026-03-30.log      ← Errors only (separate file for fast incident response)
  audit/
    auth-service-audit-2026-03-30.log    ← Compliance audit trail (hash-chained)
```

**Three transport layers per service:**

| Transport | Destination | Level | Retention | Compression |
|-----------|-------------|-------|-----------|-------------|
| Console | stdout (Docker captures) | All | Docker `max-size: 10m × 3` | No |
| Daily Rotate File | `logs/{service}-{date}.log` | All | 14 days | gzip on rotate |
| Error Rotate File | `logs/{service}-error-{date}.log` | error + fatal only | 30 days | gzip on rotate |
| Audit File | `logs/audit/{service}-audit-{date}.log` | audit (always) | 90 days | gzip on rotate |

**Key features built:**
- `createRotateTransport()` (rotate-transport.js) — Factory for daily-rotating Winston file transports with hybrid rotation (time + size), gzip compression, and configurable retention
- `createErrorRotateTransport()` — Separate error-only transport with longer 30-day retention
- `createAuditLogger()` (audit-logger.js) — Append-only audit logger with:
  - Single `record()` method (no update/delete — enforced immutability at API level)
  - Fixed schema: actor, action, resource, outcome, ip, trace_id, details
  - SHA-256 hash chaining for tamper evidence (each entry hashes with previous)
  - 90-day retention for compliance (SOC2/PCI-DSS)
- Docker Compose log driver — `json-file` with `max-size: 10m` and `max-file: 3` on every service (prevents host disk overflow from container stdout)
- Named Docker volumes (`auth-logs`, `order-logs`, `notification-logs`) — persists Winston log files across container restarts

**Retention policy:**

| Log Category | Retention | Rationale |
|--------------|-----------|-----------|
| Application logs | 14 days | 95% of bugs found within 2 weeks |
| Error logs | 30 days | Longer retention for postmortem investigations |
| Audit logs | 90 days | SOC2 minimum recommendation |

**Compliance concepts covered (conceptual):**
- GDPR — PII minimization in logs, automated retention-based deletion, documented legal basis per log category
- Immutable audit logs — append-only API, hash chaining, write-once storage
- Encryption at rest — filesystem-level (LUKS/BitLocker), application-level, storage-level (S3 SSE)
- Hot/Warm/Cold storage tiers — cost optimization by matching storage speed to data age

## Quick Start
### Run manually

```bash
# Install dependencies
npm install

# Run all services locally
npm run dev:all

# Or run individually
npm run dev:auth          # Auth service on :3001
npm run dev:order         # Order service on :3002
npm run dev:notification  # Notification service on :3003
npm run dev:ui            # Frontend UI on :3000
```

### Run with Docker
```bash
docker-compose up --build
```

Then open `http://localhost:3000` to use the interactive API tester.

## Testing Log Levels

```bash
# Default (development) — debug level
npm run dev:auth

# Production mode — info level only
NODE_ENV=production npm run dev:auth

# Override with specific level
LOG_LEVEL=trace npm run dev:auth

# Change at runtime (no restart)
curl -X POST http://localhost:3001/admin/log-level \
  -H "Content-Type: application/json" \
  -d '{"level": "trace"}'

# Check current level
curl http://localhost:3001/admin/log-level
```

## Testing Log Rotation & Audit (Part 5)

```bash
# Start the auth service
npm run dev:auth

# Trigger a login (creates audit entry + app/error log files)
curl -X POST http://localhost:3001/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin456"}'

# Trigger an admin action (creates audit entry)
curl -X POST http://localhost:3001/admin/log-level \
  -H "Content-Type: application/json" \
  -d '{"level":"trace"}'

# Check generated log files
cat logs/auth-service-2026-03-30.log          # All logs
cat logs/auth-service-error-2026-03-30.log    # Errors only
cat logs/audit/auth-service-audit-2026-03-30.log  # Audit trail with hash chain

# Verify hash chain integrity (each entry's previous_hash matches prior entry's hash)
# Entry 1: previous_hash = "GENESIS" (first entry)
# Entry 2: previous_hash = Entry 1's hash
```

## Log Output Format

Every log entry is structured JSON with standard fields:

```json
{
  "level": "info",
  "message": "Order created",
  "timestamp": "2026-03-29T10:30:00.000+06:00",
  "service": "order-service",
  "module": "orders",
  "environment": "development",
  "version": "1.0.0",
  "host": "your-machine",
  "order_id": "ORD-ABC123",
  "user_id": "USR-456",
  "total_amount": 1059.97
}
```
