# Advanced-logging-and-Monitoring-System-in-Node.js-
Advanced logging and Monitoring System in Node.js 


# Advanced Logging & Monitoring System

A self-contained, production-grade logging and monitoring library for Node.js written in traditional JavaScript — no arrow functions, `var` only, no Express, no localhost server. Zero external dependencies.

---

## Features

- **7 log levels** — `TRACE`, `DEBUG`, `INFO`, `SUCCESS`, `WARN`, `ERROR`, `FATAL`
- **ANSI color-coded** console output with level-based coloring
- **Rotating file writer** — async buffered writes; rotates at 5 MB, keeps 5 backups
- **Three log files** — plain text (`app.log`), NDJSON (`app.json.log`), errors-only (`error.log`)
- **Child loggers** — fork a sub-context logger that pipes back to the parent transport
- **Built-in metrics** — per-level counts, heap/RSS/CPU/OS stats, load average
- **Named timers** — with p95/p99 histograms via `startTimer` / `endTimer` / `timeAsync`
- **Custom gauges** — track any numeric value (connections, queue depth, etc.)
- **Alert manager** — rule-based alerting with per-rule cooldown and event emission
- **In-memory ring buffer** — queryable circular buffer with filters for level, context, search text, and time range
- **Process safety** — auto-captures `uncaughtException`, `unhandledRejection`, `SIGINT`, `SIGTERM`, and `exit`
- **Metrics dashboard** — `log.report()` prints a formatted system report to stdout
- **EventEmitter** — emits `"log"`, `"alert"`, and `"metrics"` events

---

## Requirements

- Node.js v12 or higher
- No `npm install` needed — uses only built-in modules: `fs`, `os`, `path`, `events`, `util`

---

## Quick Start

```bash
node logger.js
```

This runs the built-in demo and writes log files to `./logs/`.

---

## Usage as a Module

```javascript
var logging = require("./logger");
var Logger  = logging.Logger;

var log = new Logger({
  context: "myapp",   // label shown in every log line
  level:   10,        // DEBUG and above (see Log Levels table)
  color:   true,      // ANSI colors in console output
  console: true,      // write to stdout / stderr
  file:    true       // write to ./logs/
});

log.info("Server started", { port: 3000 });
log.warn("High memory usage", { rss: "400 MB" });
log.error("DB connection failed", { host: "db.internal", code: "ECONNREFUSED" });
```

---

## Constructor Options

| Option | Type | Default | Description |
|---|---|---|---|
| `context` | string | `"app"` | Label shown in every log entry |
| `level` | number | `10` (DEBUG) | Minimum level to log (see table below) |
| `color` | boolean | `true` | Enable ANSI colors in console output |
| `console` | boolean | `true` | Print logs to stdout / stderr |
| `file` | boolean | `true` | Write logs to `./logs/` |
| `ringSize` | number | `2000` | Max entries in the in-memory ring buffer |
| `metricsInterval` | number | `30000` | Milliseconds between automatic metrics events |

---

## Log Levels

| Name | Code | Color | Notes |
|---|---|---|---|
| `TRACE` | 0 | Magenta | Finest detail; disabled in most production setups |
| `DEBUG` | 10 | Cyan | Development diagnostics |
| `INFO` | 20 | Blue | Normal operational messages |
| `SUCCESS` | 25 | Green | Positive confirmations |
| `WARN` | 30 | Yellow | Recoverable issues |
| `ERROR` | 40 | Red | Errors written to stderr and `error.log` |
| `FATAL` | 50 | Red BG | Critical failures; written to stderr and `error.log` |
| `SILENT` | 100 | — | Suppresses all output |

Set `level` in the constructor to filter. Only entries at or above the configured level are processed.

---

## Logging Methods

```javascript
log.trace("Reading config");
log.debug("Parsed config", { env: "production" });
log.info("Request received", { method: "GET", path: "/api/users" });
log.success("Payment processed", { amount: 99.99, currency: "USD" });
log.warn("Retry attempt", { attempt: 2, maxAttempts: 3 });
log.error("Upstream timeout", { service: "stripe", ms: 5000 });
log.fatal("Out of memory", { heapUsed: "512 MB" });
```

Each method signature: `log.level(message, meta)` where `meta` is an optional object.

---

## Child Loggers

Child loggers share the parent's file transport and ring buffer, but carry their own `context` label.

```javascript
var dbLog  = log.child("database");
var apiLog = log.child("api");

dbLog.info("Query executed", { sql: "SELECT ...", rows: 42 });
apiLog.warn("Rate limit approaching", { remaining: 12 });
```

Child log entries appear in all parent log files under their own context name.

---

## Timers

### Manual start/stop

```javascript
log.startTimer("db-query");
// ... do work ...
var ms = log.endTimer("db-query");  // returns elapsed ms
```

### Async helper

```javascript
log.timeAsync("cache-warm", function(done) {
  loadCache(done);
}, function(err) {
  // called after timeAsync logs "Timed operation: cache-warm"
});
```

Timer statistics (min, max, avg, p95, p99, count) accumulate across calls and appear in `log.report()`.

---

## Gauges

Track any numeric value that you update externally:

```javascript
log.metrics.setGauge("activeConnections", 42);
log.metrics.setGauge("requestQueueDepth", 7);
```

Gauges appear in `log.report()` and in the `"metrics"` event payload.

---

## Alert Manager

Define rules that fire when a matching log entry is written. Each rule has its own cooldown to prevent alert storms.

```javascript
log.alerts.addRule({
  name:           "payment-error",   // unique rule name
  level:          "ERROR",           // minimum level to trigger
  messagePattern: "payment",         // substring match on message (optional)
  cooldownMs:     60000,             // min ms between firings for this rule
  handler: function(entry) {
    // your custom alert action — send email, call PagerDuty, etc.
    console.error("ALERT:", entry.message);
  }
});

// Listen to alert events on the logger
log.on("alert", function(data) {
  console.log("Rule fired:", data.rule, "| Entry:", data.entry.message);
});
```

---

## Querying the Ring Buffer

Search recent log entries from memory without touching disk:

```javascript
// All ERROR+ entries, most recent 20
var errors = log.query({ level: "ERROR", limit: 20 });

// Only database context entries
var dbLogs = log.query({ context: "database" });

// Full-text search
var timeouts = log.query({ search: "timeout" });

// Combined filters
var recent = log.query({
  level:   "WARN",
  context: "api",
  search:  "rate limit",
  limit:   10
});
```

Available filter options: `level`, `context`, `search`, `since` (ISO timestamp), `until` (ISO timestamp), `limit`.

---

## Events

```javascript
// Fires for every log entry written
log.on("log", function(entry) {
  // entry: { timestamp, level, levelCode, pid, hostname, context, message, meta }
});

// Fires when an alert rule matches
log.on("alert", function(data) {
  // data: { rule: "rule-name", entry: { ... } }
});

// Fires on the metricsInterval
log.on("metrics", function(snapshot) {
  // snapshot: { uptimeFormatted, memory, cpu, os, logCounts, timers, gauges, ... }
});
```

---

## Metrics Snapshot

Call `log.metrics.snapshot()` to get a live system snapshot at any time:

```javascript
var snap = log.metrics.snapshot();

console.log(snap.uptimeFormatted);     // "00h 05m 32s"
console.log(snap.memory.heapUsed);     // "12.34 MB"
console.log(snap.os.freeMemMB);        // "4096.00"
console.log(snap.logCounts.ERROR);     // 3
console.log(snap.timers["db-query"]);  // { avg: 14, min: 8, max: 42, p95: 38, p99: 42, count: 120 }
```

---

## Metrics Report

Print a full formatted dashboard to stdout:

```javascript
log.report();
```

Output includes uptime, PID, hostname, Node version, memory breakdown, OS info, per-level log counts, all timer histograms, and all gauges.

---

## Log Files

All files are written to `./logs/` relative to the working directory.

| File | Format | Contains |
|---|---|---|
| `app.log` | Plain text | All entries at or above configured level |
| `app.json.log` | NDJSON (one JSON object per line) | All entries — ideal for log shippers (Logstash, Fluentd, etc.) |
| `error.log` | NDJSON | `ERROR` and `FATAL` entries only |

Files rotate automatically when they exceed **5 MB**. Up to **5 rotated backups** are kept (`.1` through `.5`). Writes are buffered in memory and flushed to disk every **3 seconds**, with a final synchronous flush on process exit.

---

## Process Safety

The logger automatically hooks into Node.js process events:

| Event | Action |
|---|---|
| `uncaughtException` | Logs `FATAL` with stack trace |
| `unhandledRejection` | Logs `ERROR` with reason |
| `SIGINT` | Logs `WARN` signal received |
| `SIGTERM` | Logs `WARN` signal received |
| `exit` | Logs `INFO` with exit code; flushes all file buffers |

---

## Log Entry Format

Every log entry — in memory, on console, and in files — has this structure:

```json
{
  "timestamp": "2026-02-12T05:29:10.390Z",
  "level":     "ERROR",
  "levelCode": 40,
  "pid":       12345,
  "hostname":  "prod-server-01",
  "context":   "api",
  "message":   "Upstream timeout",
  "meta":      { "service": "stripe", "ms": 5000 }
}
```

---

## Full Example

```javascript
var logging = require("./logger");
var Logger  = logging.Logger;

var log = new Logger({ context: "app", level: 0, color: true });

// Alert on any FATAL entry
log.alerts.addRule({
  name:       "fatal-alert",
  level:      "FATAL",
  cooldownMs: 30000,
  handler:    function(entry) { /* notify on-call */ }
});

// Child loggers per module
var db  = log.child("database");
var api = log.child("api");

// Timer
log.startTimer("startup");

db.info("Connected", { host: "db.internal", pool: 10 });
api.info("Listening", { port: 3000 });

log.endTimer("startup");

// Gauge
log.metrics.setGauge("activeConnections", 0);

// Query
var warns = log.query({ level: "WARN", limit: 5 });
log.info("Recent warnings", { count: warns.length });

// Dashboard
log.report();
```

---

## Project Structure

```
logger.js       ← single-file library + demo (run directly with node logger.js)
logs/
  app.log       ← plain-text log (auto-created on first run)
  app.json.log  ← NDJSON log
  error.log     ← errors and fatals only
```

---

## License

MIT

