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
├── public/
│   ├── index.html                   → Interactive API tester UI
│   └── Dockerfile
├── shared/                          → Logging utilities (shared across services)
│   ├── logger.js                    → Base Winston logger factory (Part 2)
│   ├── multiLevelLogger.js          → Enhanced logger with custom levels (Part 3)
│   ├── morgan-stream.js             → Morgan-to-Winston bridge (access logs)
│   ├── database.js                  → MongoDB connection + query logging
│   ├── event-logger.js              → Domain event logger
│   └── security-logger.js           → Security/auth event logger
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

## Quick Start

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

# Run with Docker
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
