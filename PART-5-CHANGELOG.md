# Part 5 — Log Rotation & Retention Policies: Changelog

## Overview

Part 5 added **log rotation**, **retention policies**, **gzip compression**, **Docker log driver configuration**, and a **compliance-ready audit logger** to the multi-service e-commerce backend. Without rotation, log files grow unbounded until the host disk fills — crashing the database, Docker daemon, and the services themselves. Part 5 solves this at both the application layer (Winston) and the infrastructure layer (Docker).

---

## Key Concepts Introduced

### Why Log Rotation Matters
- Without rotation, a single service logging at ~500 lines/minute generates ~1GB/day. In a 4-service stack, that's ~4GB/day with no cleanup.
- When disk hits 100%: MongoDB can't write its journal, Docker can't start containers, the OS can't write temp files, and Winston can't write the very logs you need to diagnose the problem.
- Rotation ensures no single log file grows unbounded, old files are compressed and cleaned up automatically.

### Hybrid Rotation (Time + Size)
- **Time-based only:** A traffic spike can produce a single 50GB file for one day — unusable.
- **Size-based only:** File boundaries don't align with dates — "show me yesterday's logs" is impossible.
- **Hybrid (what we use):** Daily rotation as the primary trigger, with a size cap as a safety valve. Result: date-stamped files that never grow beyond the size limit.

### Hot / Warm / Cold Storage Tiers
- **Hot (0-7 days):** Local SSD, full-text searchable in Elasticsearch. Fast, expensive.
- **Warm (7-30 days):** Compressed `.gz` files on cheaper disks. Searchable with `zcat`/`zgrep`. Moderate cost.
- **Cold (30-90+ days):** Object storage (S3, Azure Blob). Must download to search. Cheap ($0.023/GB/month vs $0.75/GB for hot).

### Docker Log Driver
- Docker captures everything written to stdout/stderr and stores it in `/var/lib/docker/containers/<id>/<id>-json.log` on the host.
- By default, this file grows **unbounded** — completely separate from Winston's application-level rotation.
- The `json-file` driver with `max-size` and `max-file` is the safety net at the infrastructure layer.

### Audit Logs and Compliance
- Audit logs record **who did what, when** — different purpose and audience from application logs.
- Must be **append-only**: the API exposes only a `record()` method — no update, no delete.
- **Hash chaining** provides tamper evidence: each entry includes a SHA-256 hash of itself combined with the previous entry's hash. If any entry is deleted or modified, the chain breaks.
- Longer retention (90d) than application logs (14d) — driven by SOC2/PCI-DSS compliance requirements.

---

## New Files Created

### 1. `shared/rotate-transport.js` — Daily Rotating File Transport Factory

**What:** A factory module that creates Winston `DailyRotateFile` transport instances with hybrid rotation, gzip compression, and configurable retention.

**What it provides:**
- `createRotateTransport({ service, logDir, maxSize, maxFiles, level })` — Creates the main application log transport
- `createErrorRotateTransport({ service, logDir })` — Creates an error-only transport (level: 'error') with 30-day retention

**How it works:**
- Uses `winston-daily-rotate-file` (backed by `file-stream-rotator` internally)
- On every log write, checks: has the date changed? has the file exceeded `maxSize`? If either is true, the current file is closed and a new one is opened
- Rotated files are gzipped in the background (async — doesn't block log writes)
- Files older than `maxFiles` (e.g., `'14d'`) are automatically deleted

**Key options explained:**

| Option | Value | Why |
|--------|-------|-----|
| `filename` | `logs/{service}-%DATE%.log` | `%DATE%` is replaced with current date → `auth-service-2026-03-30.log` |
| `datePattern` | `'YYYY-MM-DD'` | Daily rotation. Use `'YYYY-MM-DD-HH'` for hourly in high-volume systems |
| `maxSize` | `'20m'` | Rotate mid-day if file hits 20MB. Prevents single-day spikes from producing huge files |
| `maxFiles` | `'14d'` | Auto-delete files older than 14 days. String with 'd' suffix is date-aware |
| `zippedArchive` | `true` | Gzip rotated files. JSON compresses ~10:1 → 20MB becomes ~2MB |
| `level` | `'error'` (error transport) | Per-transport level filter — error transport only receives error + fatal |

**Lifecycle events:**
- `transport.on('rotate', ...)` — fires when a file is rotated; logs the old and new filename to stderr
- `transport.on('logRemoved', ...)` — fires when a file is deleted by retention policy; logs filename to stderr

**Why separate error file:**
During incidents, you need to find errors fast. A general log file mixes thousands of info/debug lines with the few errors you care about. The error-only file contains nothing but actionable failures — fast to grep, fast to read.

**Why a factory function:**
Every service needs the same rotation config. Centralizing it means a single change (e.g., retention from 14 to 30 days) updates all services at once.

**Necessity:** `winston-daily-rotate-file` adds hybrid rotation, compression, and retention that Winston's built-in `File` transport cannot provide. Without it, you'd need to implement your own rotation logic or use OS-level tools like `logrotate`.

---

### 2. `shared/audit-logger.js` — Append-Only Compliance Audit Logger

**What:** A separate logger module for compliance-relevant events with an append-only API, fixed schema, hash chaining, and 90-day retention.

**What it provides:**
- `createAuditLogger({ service, logDir, maxFiles })` — Returns an object with a single `record()` method

**Audit schema (every entry must have):**

| Field | Type | Purpose |
|-------|------|---------|
| `actor` | string | Who performed the action (user_id or 'system') |
| `action` | string | What was done (e.g., 'LOGIN', 'CHANGE_LOG_LEVEL') |
| `resource` | string | What was affected (e.g., 'user:admin', 'system:log-config') |
| `outcome` | string | 'success' or 'failure' |
| `ip` | string | Client IP address |
| `trace_id` | string | Correlation ID for cross-referencing with application logs |
| `details` | object | Additional context (free-form) |
| `hash` | string | SHA-256 hash of this entry + previous hash |
| `previous_hash` | string | Hash of the preceding entry ('GENESIS' for first entry) |

**How append-only is enforced:**
The module exports only `{ record }`. There is no update, delete, truncate, or seek method. At the application layer, audit entries can only be created — never modified.

**How hash chaining works:**
```
Entry 1: previous_hash = "GENESIS"
         content = { actor: 'admin', action: 'LOGIN', ... }
         hash = SHA-256("GENESIS" + JSON.stringify(content)) = "3e833a..."

Entry 2: previous_hash = "3e833a..."
         content = { actor: 'admin', action: 'CHANGE_LOG_LEVEL', ... }
         hash = SHA-256("3e833a..." + JSON.stringify(content)) = "efba90..."
```
If Entry 1 is deleted or modified, Entry 2's `previous_hash` won't match a recalculated hash — tampering is detectable.

**Schema enforcement:**
The `record()` function validates required fields (`actor`, `action`, `resource`, `outcome`) before writing. Incomplete audit entries are rejected with a stderr warning — a half-recorded audit event is worse than none.

**Why separate from application logs:**

| Aspect | Application Logs | Audit Logs |
|--------|-----------------|------------|
| Audience | Engineers | Auditors, legal, security |
| Retention | 14 days | 90+ days |
| Mutability | Can be deleted | Append-only |
| Level filtering | Yes (debug/info/etc.) | No — always written |
| Schema | Flexible | Fixed, strict |
| Compression | On rotate | On rotate |

**Necessity:** Compliance frameworks (SOC2, PCI-DSS, GDPR) require records of who accessed or changed what, retained for defined periods, with tamper evidence. Application logs aren't suitable for this — they're filtered by level, not schema-validated, and have short retention. A dedicated audit logger makes the compliance boundary explicit.

---

## Modified Files

---

### 3. `shared/multiLevelLogger.js` — Added File Transports (Part 5)

**What changed:**
- Added import: `const { createRotateTransport, createErrorRotateTransport } = require('./rotate-transport')`
- Expanded the `transports` array from one transport to three

**Before (Part 4):**
```js
transports: [
  new winston.transports.Console()
]
```

**After (Part 5):**
```js
transports: [
  new winston.transports.Console(),           // Transport 1: stdout (Docker captures)
  createRotateTransport({ service }),          // Transport 2: all logs, 14d retention
  createErrorRotateTransport({ service }),     // Transport 3: errors only, 30d retention
]
```

**How Winston fan-out works:**
A single `logger.error('Payment failed')` is sent to all three transports simultaneously. Each transport applies its own level filter — the error-only transport accepts it, the general transport accepts it, Console outputs it. A `logger.debug(...)` call only reaches Console and the general file (error transport rejects it).

**Why three transports:**
- Console is required for `docker compose logs` to work and for ELK Filebeat shipping
- General file gives you the complete structured log history, date-aligned, compressed
- Error-only file gives incident responders fast access to failures without wading through thousands of info/debug lines

**Necessity:** Console-only logging is ephemeral — container restart wipes stdout history. File transports persist logs across restarts (via Docker named volumes), allow direct `cat`/`grep` access, and provide the compressed archive that retention policies operate on.

---

### 4. `services/auth-service/index.js` — Audit Logger Integration (Part 5)

**What changed:**
- Added import: `const { createAuditLogger } = require('../../shared/audit-logger')`
- Initialized audit logger: `const audit = createAuditLogger({ service: 'auth-service' })`
- Added `audit.record(...)` call on the login success path
- Added `audit.record(...)` call after a successful log-level change via the admin endpoint
- Removed duplicate `const store = asyncLocalStorage.getStore()` declaration (consolidated with the audit block's store variable)

**Audit events now recorded:**

**`POST /login` (success path):**
```js
audit.record({
  actor: username,
  action: 'LOGIN',
  resource: `user:${username}`,
  outcome: 'success',
  ip,
  trace_id: store?.trace_id,
  details: { role: user.role },
});
```

**`POST /admin/log-level` (success path):**
```js
audit.record({
  actor: 'admin',
  action: 'CHANGE_LOG_LEVEL',
  resource: 'system:log-config',
  outcome: 'success',
  ip: req.ip,
  details: { from: result.previous_level, to: result.level },
});
```

**Why these two events:**
- `LOGIN` — authentication events are the most fundamental audit record. Regulators want to know who authenticated, when, and from where.
- `CHANGE_LOG_LEVEL` — changing log verbosity is an operational action that affects what the system records. An auditor must be able to reconstruct: "at 14:30 on March 30, admin increased the log level to trace — therefore the detailed logs from 14:30-15:00 exist and are relevant."

**Why login failure is NOT in the audit log:**
Failed logins are already captured in the security log (`securityLogger.authFailure`). Audit logs record *completed actions*, not *attempts*. A failed login attempt is a security event, not a compliance event.

**Necessity:** Without audit logging, there is no immutable record of system access and administrative changes. Application logs can be filtered by level and deleted by retention policy. Audit logs exist outside that system.

---

### 5. `docker-compose.yml` — Log Driver + Named Volumes (Part 5)

**What changed:**
- Added `logging:` block with `driver: json-file` and `options: { max-size: "10m", max-file: "3" }` to all 4 services
- Added `volumes:` mount (`auth-logs`, `order-logs`, `notification-logs`) to the 3 backend services
- Added top-level `volumes:` section declaring the named volumes

**Docker log driver explained:**
Docker captures everything written to container stdout/stderr and stores it at `/var/lib/docker/containers/<id>/<id>-json.log` on the HOST machine — completely separate from Winston's application log files inside the container. Without `max-size`/`max-file`, this host file grows **unbounded**.

```
Without our config:   /var/lib/.../abc123-json.log → 18GB after 1 year (one container)
With our config:      /var/lib/.../abc123-json.log → 30MB maximum (10MB × 3 files, then Docker rotates)
```

**Named volumes explained:**
Winston writes log files to `./logs/` inside the container. Without a volume mount, those files are in the container's writable layer — they vanish when the container is recreated. Named volumes are managed by Docker and persist across `docker-compose down/up` cycles.

```yaml
volumes:
  - auth-logs:/app/logs   # Maps named volume "auth-logs" to /app/logs inside container
```

**The two-layer protection:**
```
Application layer:   Winston → ./logs/auth-service-2026-03-30.log  (14d rotation, gzip)
Infrastructure layer: stdout → Docker json-file driver              (30MB hard cap per container)
```

**Necessity:** The Docker log driver is a silent disk killer. Developers set up application-level rotation and assume the problem is solved — but Docker's separate copy continues growing. Both layers must be configured.

---

### 6. `package.json` + `package-lock.json` — New Dependency

**Added:** `winston-daily-rotate-file: ^5.0.0`

**Transitive dependencies added:**
- `file-stream-rotator` — handles the actual file rotation mechanics
- `moment` — date parsing used by file-stream-rotator
- `object-hash` — used internally by winston-daily-rotate-file for transport identity

**Why not use Winston's built-in File transport:**
Winston's `transports.File` has a basic `maxsize` and `maxFiles` option but **no date-based rotation** — files are just numbered sequentially. You can't ask for "logs from March 28th" and you can't set date-based retention policies. `winston-daily-rotate-file` provides the hybrid time+size rotation with gzip and date-aware retention.

---

### 7. `.gitignore` — Added `logs/` (Part 5)

**What changed:** Added `logs/` to prevent generated log files from being committed to git.

**Why:** Log files are generated output — they don't belong in version control. They're environment-specific, change constantly, can contain sensitive data, and would create noise in every commit. The `logs/` directory is created at runtime when the first log entry is written.

---

## Verified Test Output

```
logs/
  auth-service-2026-03-30.log          (6468 bytes — all logs)
  auth-service-error-2026-03-30.log    (1200 bytes — errors only)
  audit/
    auth-service-audit-2026-03-30.log  (824 bytes — 2 audit entries)
```

**Audit log after LOGIN + CHANGE_LOG_LEVEL:**
```
Entry 1: actor=admin  action=LOGIN             previous_hash=GENESIS   hash=3e833a...
Entry 2: actor=admin  action=CHANGE_LOG_LEVEL  previous_hash=3e833a... hash=efba90...
```

Hash chain verified: Entry 2's `previous_hash` matches Entry 1's `hash` exactly.

---

## Exports from New Modules

### `shared/rotate-transport.js`

| Export | Type | Purpose |
|--------|------|---------|
| `createRotateTransport()` | Function | Creates a daily-rotating file transport (all levels, 14d retention) |
| `createErrorRotateTransport()` | Function | Creates an error-only rotating file transport (30d retention) |

### `shared/audit-logger.js`

| Export | Type | Purpose |
|--------|------|---------|
| `createAuditLogger()` | Function | Returns `{ record }` — append-only audit logger with hash chaining |

---

## Retention Policy Summary

| Log Category | File Pattern | Retention | Compression | Notes |
|--------------|-------------|-----------|-------------|-------|
| Application logs | `{service}-{date}.log` | 14 days | gzip on rotate | All levels |
| Error logs | `{service}-error-{date}.log` | 30 days | gzip on rotate | error + fatal only |
| Audit logs | `audit/{service}-audit-{date}.log` | 90 days | gzip on rotate | Append-only, hash-chained |
| Docker stdout | Host json-file driver | 30MB max | None | 10MB × 3 files |

---

## Project Structure After Part 5

```
ecommerce-logging/
├── PART-2-CHANGELOG.md
├── PART-3-CHANGELOG.md
├── PART-4-CHANGELOG.md
├── PART-5-CHANGELOG.md              ← NEW
├── docker-compose.yml               ← MODIFIED (log driver + named volumes on all services)
├── package.json                     ← MODIFIED (added winston-daily-rotate-file)
├── package-lock.json                ← MODIFIED
├── .gitignore                       ← MODIFIED (added logs/)
├── server.js
├── public/
│   ├── Dockerfile
│   └── index.html
├── shared/
│   ├── async-context.js
│   ├── correlation-middleware.js
│   ├── logger.js
│   ├── multiLevelLogger.js          ← MODIFIED (added 2 file transports)
│   ├── morgan-stream.js
│   ├── database.js
│   ├── event-logger.js
│   ├── security-logger.js
│   ├── rotate-transport.js          ← NEW (hybrid rotation + compression + retention)
│   └── audit-logger.js             ← NEW (append-only, hash-chained, 90d retention)
└── services/
    ├── auth-service/
    │   ├── index.js                 ← MODIFIED (audit logger wired for LOGIN + CHANGE_LOG_LEVEL)
    │   └── Dockerfile
    ├── order-service/
    │   ├── index.js
    │   └── Dockerfile
    └── notification-service/
        ├── index.js
        └── Dockerfile
```
