# How to Run ELK (Elasticsearch, Logstash, Kibana)

This guide covers running the complete ELK stack with the ecommerce microservices logging system.

## Prerequisites

- Docker and Docker Compose installed
- Git (for version control)
- 4+ GB available RAM (recommended 8GB for comfortable operation)
- Port availability: 3000-3003 (services), 5000 (Logstash), 5601 (Kibana), 9200 (Elasticsearch), 27017 (MongoDB)

## Quick Start

### 1. Start the ELK Stack and Services

```bash
cd d:/corner/Logging/ecommerce-logging

# Build and run all containers (ELK + microservices)
docker-compose -f docker-compose.elk.yml up --build
```

This command:
- Builds Docker images for all services
- Starts MongoDB (data storage)
- Starts Elasticsearch (log indexing)
- Starts Logstash (log processing)
- Starts Kibana (log UI)
- Starts Frontend (port 3000)
- Starts Auth Service (port 3001)
- Starts Order Service (port 3002)
- Starts Notification Service (port 3003)

### 2. Wait for Everything to Start

Watch the logs for these signals:
- **Elasticsearch**: `"started"`
- **Logstash**: `"Successfully started Logstash API endpoint"`
- **Kibana**: `"Server running at http://0.0.0.0:5601"`

Typically takes 30-60 seconds for full startup.

## Checking the Services

### Kibana (Log Viewer)

1. **Open Kibana UI**
   ```
   http://localhost:5601
   ```

2. **Create Index Pattern** (first time only)
   - Go to **Menu → Stack Management → Index Patterns**
   - Click **Create index pattern**
   - Enter: `logs-*`
   - Click **Next step → Create index pattern**

3. **View Logs**
   - Go to **Menu → Discover**
   - Select the `logs-*` index pattern
   - Browse logs from auth-service, order-service, notification-service
   - Filter by service: `service: "auth-service"`
   - Filter by trace ID: `trace_id: "abc-123"`
   - Filter by level: `level: "error"`

### Elasticsearch (Direct API)

Check Elasticsearch health:
```bash
curl http://localhost:9200/_cluster/health
```

Response should show `"status":"green"` (all shards allocated):
```json
{
  "cluster_name": "docker-cluster",
  "status": "green",
  "timed_out": false,
  "number_of_nodes": 1,
  "active_shards": 3
}
```

List all indexes:
```bash
curl http://localhost:9200/_cat/indices?v
```

Example output:
```
health status index                                     uuid                   pri rep docs.count docs.deleted store.size pri.store.size
yellow open   ecommerce-notification-service-2026.04.28 -bar1j0RSlSCGO38oDXl1A   1   1          6            0     79.2kb         79.2kb
yellow open   ecommerce-auth-service-2026.04.28         CWxNm6gTSTuArBX7r-Xd9A   1   1         11            0       81kb           81kb
yellow open   ecommerce-order-service-2026.04.28        DffU6v1DSQ-9VyumZ1crIQ   1   1          4            0     40.7kb         40.7kb
```

## Generating Test Logs

### Via Frontend UI

1. Open **http://localhost:3000**
2. Use the interactive API tester to:
   - **Login** (creates auth logs + security event)
   - **Create Order** (creates order logs + event logs)
   - **Notify** (creates notification logs)

### Via cURL

**Login (Auth Service)**
```bash
curl -X POST http://localhost:3001/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin456"}'
```

**Create Order (Order Service)**
```bash
curl -X POST http://localhost:3002/orders \
  -H "Content-Type: application/json" \
  -d '{"user_id":"usr-123","items":[{"product_id":"prod-1","qty":2}]}'
```

**Send Notification (Notification Service)**
```bash
curl -X POST http://localhost:3003/notify \
  -H "Content-Type: application/json" \
  -d '{"user_id":"usr-123","channel":"email","message":"Order shipped"}'
```

**Change Log Level**
```bash
curl -X POST http://localhost:3001/admin/log-level \
  -H "Content-Type: application/json" \
  -d '{"level":"trace"}'
```

## Monitoring & Troubleshooting

### Check Container Status

```bash
docker-compose -f docker-compose.elk.yml ps
```

Expected output:
```
CONTAINER ID   IMAGE                              STATUS       PORTS
abc123         docker.elastic.co/elasticsearch    Up 2 minutes 0.0.0.0:9200->9200/tcp
def456         docker.elastic.co/kibana           Up 2 minutes 0.0.0.0:5601->5601/tcp
ghi789         docker.elastic.co/logstash         Up 2 minutes 0.0.0.0:5000->5000/tcp
jkl012         mongo:7                            Up 2 minutes 0.0.0.0:27017->27017/tcp
mno345         ecommerce-logging_frontend         Up 2 minutes 0.0.0.0:3000->3000/tcp
pqr678         ecommerce-logging_auth-service    Up 2 minutes 0.0.0.0:3001->3001/tcp
...
```

### View Logs for a Specific Service

```bash
# Elasticsearch logs
docker-compose -f docker-compose.elk.yml logs elasticsearch

# Logstash logs
docker-compose -f docker-compose.elk.yml logs logstash

# Auth Service logs
docker-compose -f docker-compose.elk.yml logs auth-service-elk

# Follow logs in real-time
docker-compose -f docker-compose.elk.yml logs -f logstash
```

### Check Logstash Pipeline

Logstash reads files from `/logs/{service}/*.log` mounted in the container.

Verify Logstash can access log files:
```bash
docker exec logstash ls -la /logs/auth-service/
docker exec logstash ls -la /logs/order-service/
docker exec logstash ls -la /logs/notification-service/
```

If files aren't appearing, check:
1. Services are running and generating logs
2. Volume mounts are correct in `docker-compose.elk.yml`
3. Logstash has read permissions

### No Logs in Kibana?

**Step 1: Verify logs exist in containers**
```bash
docker exec auth-service-elk ls -la /app/logs/auth-service/
```

**Step 2: Check Logstash is reading them**
```bash
docker-compose -f docker-compose.elk.yml logs logstash | grep -E "ERROR|sincedb"
```

**Step 3: Verify Elasticsearch has indexes**
```bash
curl http://localhost:9200/_cat/indices
```

**Step 4: Check Kibana index pattern**
- Go to **Stack Management → Index Patterns**
- Verify `logs-*` pattern shows matching indexes
- Click refresh (circular arrow icon)

### Elasticsearch Out of Memory

If Elasticsearch keeps crashing, increase Java heap:

Edit `docker-compose.elk.yml`, find the Elasticsearch service, and add:
```yaml
elasticsearch:
  image: docker.elastic.co/elasticsearch/elasticsearch:8.0.0
  environment:
    - discovery.type=single-node
    - xpack.security.enabled=false
    - ES_JAVA_OPTS=-Xms512m -Xmx512m  # Increase from default
```

Then restart:
```bash
docker-compose -f docker-compose.elk.yml down
docker-compose -f docker-compose.elk.yml up --build
```

## Stopping the Stack

### Stop All Containers (Keep Data)
```bash
docker-compose -f docker-compose.elk.yml stop
```

### Stop and Remove Containers (Keep Data)
```bash
docker-compose -f docker-compose.elk.yml down
```

### Stop and Remove Everything (Delete Data)
```bash
docker-compose -f docker-compose.elk.yml down -v
```

⚠️ The `-v` flag deletes all Docker volumes, including Elasticsearch indexes and MongoDB data.

## Useful Kibana Queries

### All errors in the last 24 hours
```
level: "error" OR level: "fatal"
```

### Trace a single request across all services
```
trace_id: "your-trace-id-here"
```

### Auth service only
```
service: "auth-service"
```

### Login failures
```
service: "auth-service" AND log_type: "security" AND message: "auth failure"
```

### Orders with high amounts
```
service: "order-service" AND total_amount: > 5000
```

### Failed notifications
```
service: "notification-service" AND level: "error"
```

## Data Retention

| Log Type | Retention | Where |
|----------|-----------|-------|
| Application | 14 days | `logs/{service}-{date}.log` |
| Error | 30 days | `logs/{service}-error-{date}.log` |
| Audit | 90 days | `logs/audit/{service}-audit-{date}.log` |
| Docker container | 30 MB (3 × 10MB) | Docker log driver |
| Elasticsearch | Indefinite | Indexes kept in volume |

Old log files are automatically compressed to `.gz` and deleted after retention period expires.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                   Services Layer                         │
│  ┌────────────┐  ┌────────────┐  ┌───────────────────┐  │
│  │ Frontend   │  │   Auth     │  │   Order Service   │  │
│  │ (3000)     │  │  (3001)    │  │      (3002)       │  │
│  └────────────┘  └────────────┘  └───────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │     Winston Logger (structured JSON to file)     │   │
│  └──────────────────────────────────────────────────┘   │
│                          ↓                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │        /app/logs/{service}/*.log (container)     │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
                          ↓ (Volume Mount)
┌──────────────────────────────────────────────────────────┐
│                   ELK Stack Layer                        │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Logstash (5000)                                   │  │
│  │  ├─ Input:  Read .log files                        │  │
│  │  ├─ Filter: Parse JSON, enrich, validate          │  │
│  │  └─ Output: Send to Elasticsearch                 │  │
│  └────────────────────────────────────────────────────┘  │
│                          ↓                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Elasticsearch (9200)                              │  │
│  │  └─ Indexes: logs-auth-service-2026.03.30        │  │
│  │              logs-order-service-2026.03.30        │  │
│  │              logs-notification-2026.03.30         │  │
│  └────────────────────────────────────────────────────┘  │
│                          ↓                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Kibana (5601)                                     │  │
│  │  └─ UI for search, filter, visualize, alert       │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Next Steps

1. **Create Dashboards** in Kibana to visualize metrics
2. **Set Up Alerts** for error spikes
3. **Index snapshots** for long-term backup
4. **Tune performance** based on log volume
5. **Configure SSL/TLS** for production environments

## Reference

- [Kibana Documentation](https://www.elastic.co/guide/en/kibana/current/index.html)
- [Elasticsearch Query DSL](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl.html)
- [Logstash Pipeline Configuration](https://www.elastic.co/guide/en/logstash/current/configuration.html)
- [Winston Logger](https://github.com/winstonjs/winston)
