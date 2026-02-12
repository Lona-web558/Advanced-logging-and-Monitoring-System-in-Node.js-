/**
 * ============================================================
 *  ADVANCED LOGGING & MONITORING SYSTEM
 *  Traditional JavaScript — no arrow functions, var only
 *  No Express, no localhost server — pure Node.js modules
 * ============================================================
 */

"use strict";

var fs      = require("fs");
var os      = require("os");
var path    = require("path");
var events  = require("events");
var util    = require("util");

// ─────────────────────────────────────────────
//  CONSTANTS (kept as var per style requirement)
// ─────────────────────────────────────────────
var LOG_LEVELS = {
  TRACE:   0,
  DEBUG:   10,
  INFO:    20,
  SUCCESS: 25,
  WARN:    30,
  ERROR:   40,
  FATAL:   50,
  SILENT:  100
};

var ANSI = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  trace:   "\x1b[35m",   // magenta
  debug:   "\x1b[36m",   // cyan
  info:    "\x1b[34m",   // blue
  success: "\x1b[32m",   // green
  warn:    "\x1b[33m",   // yellow
  error:   "\x1b[31m",   // red
  fatal:   "\x1b[41m",   // red background
  label:   "\x1b[90m",   // grey
  value:   "\x1b[97m",   // bright white
  border:  "\x1b[90m"    // grey
};

var LOG_DIR    = path.join(process.cwd(), "logs");
var MAX_FILE_MB = 5;          // rotate after 5 MB
var MAX_BACKUPS = 5;          // keep 5 rotated files
var FLUSH_INTERVAL_MS = 3000; // async write buffer flush

// ─────────────────────────────────────────────
//  HELPER UTILITIES
// ─────────────────────────────────────────────

function padStart(str, len, char) {
  str = String(str);
  char = char || "0";
  while (str.length < len) { str = char + str; }
  return str;
}

function formatTimestamp(date) {
  return date.getFullYear()
    + "-" + padStart(date.getMonth() + 1, 2)
    + "-" + padStart(date.getDate(), 2)
    + "T" + padStart(date.getHours(), 2)
    + ":" + padStart(date.getMinutes(), 2)
    + ":" + padStart(date.getSeconds(), 2)
    + "." + padStart(date.getMilliseconds(), 3)
    + "Z";
}

function bytesToMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function uptime(startedAt) {
  var ms   = Date.now() - startedAt;
  var secs = Math.floor(ms / 1000);
  var mins = Math.floor(secs / 60);
  var hrs  = Math.floor(mins / 60);
  return padStart(hrs, 2) + "h " + padStart(mins % 60, 2) + "m " + padStart(secs % 60, 2) + "s";
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getFileSizeMB(filePath) {
  try {
    return fs.statSync(filePath).size / (1024 * 1024);
  } catch (e) {
    return 0;
  }
}

function truncateMessage(msg, maxLen) {
  if (msg.length > maxLen) {
    return msg.slice(0, maxLen) + "…[truncated]";
  }
  return msg;
}

// ─────────────────────────────────────────────
//  LOG ENTRY FORMATTER
// ─────────────────────────────────────────────

function buildEntry(level, levelName, message, meta, context) {
  var ts    = new Date();
  var entry = {
    timestamp: formatTimestamp(ts),
    level:     levelName,
    levelCode: level,
    pid:       process.pid,
    hostname:  os.hostname(),
    context:   context || "app",
    message:   truncateMessage(String(message), 4096),
    meta:      meta || null
  };
  return entry;
}

function entryToJson(entry) {
  return JSON.stringify(entry);
}

function entryToText(entry, useColor) {
  var lvlName  = padStart(entry.level, 7, " ");
  var color    = ANSI[entry.level.toLowerCase()] || ANSI.info;
  var reset    = ANSI.reset;
  var bold     = ANSI.bold;
  var dim      = ANSI.dim;
  var labelC   = ANSI.label;
  var valueC   = ANSI.value;

  if (!useColor) {
    return "[" + entry.timestamp + "] [" + lvlName + "] [" + entry.context + "] " + entry.message
      + (entry.meta ? " | meta=" + JSON.stringify(entry.meta) : "");
  }

  var metaStr = "";
  if (entry.meta) {
    metaStr = dim + " | " + labelC + "meta=" + valueC + JSON.stringify(entry.meta) + reset;
  }

  return labelC + "[" + entry.timestamp + "] " + reset
    + bold + color + "[" + lvlName + "]" + reset
    + labelC + " [" + entry.context + "] " + reset
    + valueC + entry.message + reset
    + metaStr;
}

// ─────────────────────────────────────────────
//  FILE ROTATOR
// ─────────────────────────────────────────────

function RotatingFileWriter(filePath, maxMB, maxBackups) {
  this.filePath   = filePath;
  this.maxMB      = maxMB;
  this.maxBackups = maxBackups;
  this._buffer    = [];
  this._writing   = false;
  ensureDir(path.dirname(filePath));
}

RotatingFileWriter.prototype.rotate = function() {
  if (!fs.existsSync(this.filePath)) { return; }
  for (var i = this.maxBackups - 1; i >= 1; i--) {
    var from = this.filePath + "." + i;
    var to   = this.filePath + "." + (i + 1);
    if (fs.existsSync(from)) { fs.renameSync(from, to); }
  }
  fs.renameSync(this.filePath, this.filePath + ".1");
};

RotatingFileWriter.prototype.write = function(line) {
  this._buffer.push(line);
};

RotatingFileWriter.prototype.flush = function(callback) {
  if (this._buffer.length === 0) {
    if (callback) { callback(); }
    return;
  }
  var self   = this;
  var chunk  = self._buffer.splice(0, self._buffer.length).join("\n") + "\n";

  if (getFileSizeMB(self.filePath) >= self.maxMB) {
    self.rotate();
  }

  fs.appendFile(self.filePath, chunk, function(err) {
    if (err) { process.stderr.write("[RotatingFileWriter] Write error: " + err.message + "\n"); }
    if (callback) { callback(); }
  });
};

// ─────────────────────────────────────────────
//  METRICS COLLECTOR
// ─────────────────────────────────────────────

function MetricsCollector() {
  this._startedAt    = Date.now();
  this._counts       = {};
  this._timers       = {};
  this._gauges       = {};
  this._histograms   = {};

  for (var lvl in LOG_LEVELS) {
    if (LOG_LEVELS.hasOwnProperty(lvl)) {
      this._counts[lvl] = 0;
    }
  }
}

MetricsCollector.prototype.incrementLevel = function(levelName) {
  if (this._counts.hasOwnProperty(levelName)) {
    this._counts[levelName]++;
  }
};

MetricsCollector.prototype.startTimer = function(name) {
  this._timers[name] = Date.now();
};

MetricsCollector.prototype.endTimer = function(name) {
  if (!this._timers[name]) { return null; }
  var elapsed = Date.now() - this._timers[name];
  delete this._timers[name];
  if (!this._histograms[name]) { this._histograms[name] = []; }
  this._histograms[name].push(elapsed);
  return elapsed;
};

MetricsCollector.prototype.setGauge = function(name, value) {
  this._gauges[name] = value;
};

MetricsCollector.prototype.getTimerStats = function(name) {
  var samples = this._histograms[name];
  if (!samples || samples.length === 0) { return null; }
  var sum = 0;
  var min = Infinity;
  var max = -Infinity;
  for (var i = 0; i < samples.length; i++) {
    sum += samples[i];
    if (samples[i] < min) { min = samples[i]; }
    if (samples[i] > max) { max = samples[i]; }
  }
  var avg = sum / samples.length;
  var sorted = samples.slice().sort(function(a, b) { return a - b; });
  var p95 = sorted[Math.floor(sorted.length * 0.95)] || max;
  var p99 = sorted[Math.floor(sorted.length * 0.99)] || max;
  return { count: samples.length, min: min, max: max, avg: Math.round(avg), p95: p95, p99: p99 };
};

MetricsCollector.prototype.snapshot = function() {
  var mem  = process.memoryUsage();
  var cpu  = process.cpuUsage();
  var snap = {
    uptimeFormatted: uptime(this._startedAt),
    uptimeMs:        Date.now() - this._startedAt,
    pid:             process.pid,
    node:            process.version,
    platform:        process.platform,
    arch:            process.arch,
    hostname:        os.hostname(),
    logCounts:       {},
    memory: {
      rss:        bytesToMB(mem.rss)      + " MB",
      heapUsed:   bytesToMB(mem.heapUsed) + " MB",
      heapTotal:  bytesToMB(mem.heapTotal)+ " MB",
      external:   bytesToMB(mem.external) + " MB"
    },
    cpu: {
      userMs:   Math.round(cpu.user / 1000),
      systemMs: Math.round(cpu.system / 1000)
    },
    os: {
      totalMemMB: bytesToMB(os.totalmem()),
      freeMemMB:  bytesToMB(os.freemem()),
      loadAvg:    os.loadavg().map(function(n) { return n.toFixed(2); }),
      cpuCount:   os.cpus().length
    },
    gauges:    this._gauges,
    timers:    {}
  };

  for (var lvl in this._counts) {
    if (this._counts.hasOwnProperty(lvl)) {
      snap.logCounts[lvl] = this._counts[lvl];
    }
  }
  for (var name in this._histograms) {
    if (this._histograms.hasOwnProperty(name)) {
      snap.timers[name] = this.getTimerStats(name);
    }
  }
  return snap;
};

// ─────────────────────────────────────────────
//  ALERT MANAGER
// ─────────────────────────────────────────────

function AlertManager(emitter) {
  this._emitter  = emitter;
  this._rules    = [];
  this._cooldowns = {};
}

AlertManager.prototype.addRule = function(opts) {
  // opts: { name, level, messagePattern, cooldownMs, handler }
  this._rules.push({
    name:           opts.name || "rule_" + this._rules.length,
    level:          opts.level || "ERROR",
    messagePattern: opts.messagePattern || null,
    cooldownMs:     opts.cooldownMs || 60000,
    handler:        opts.handler || null
  });
};

AlertManager.prototype.evaluate = function(entry) {
  var self = this;
  for (var i = 0; i < self._rules.length; i++) {
    var rule = self._rules[i];
    if (LOG_LEVELS[entry.level] < LOG_LEVELS[rule.level]) { continue; }
    if (rule.messagePattern && entry.message.indexOf(rule.messagePattern) === -1) { continue; }

    var now    = Date.now();
    var lastAt = self._cooldowns[rule.name] || 0;
    if (now - lastAt < rule.cooldownMs) { continue; }

    self._cooldowns[rule.name] = now;
    self._emitter.emit("alert", { rule: rule.name, entry: entry });
    if (typeof rule.handler === "function") { rule.handler(entry); }
  }
};

// ─────────────────────────────────────────────
//  QUERY ENGINE  (search in-memory ring buffer)
// ─────────────────────────────────────────────

function RingBuffer(capacity) {
  this._capacity = capacity;
  this._data     = [];
  this._head     = 0;
}

RingBuffer.prototype.push = function(item) {
  if (this._data.length < this._capacity) {
    this._data.push(item);
  } else {
    this._data[this._head] = item;
    this._head = (this._head + 1) % this._capacity;
  }
};

RingBuffer.prototype.toArray = function() {
  if (this._data.length < this._capacity) { return this._data.slice(); }
  return this._data.slice(this._head).concat(this._data.slice(0, this._head));
};

RingBuffer.prototype.query = function(opts) {
  var all = this.toArray();
  var results = [];

  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (opts.level && LOG_LEVELS[e.level] < LOG_LEVELS[opts.level]) { continue; }
    if (opts.context && e.context !== opts.context) { continue; }
    if (opts.search && e.message.indexOf(opts.search) === -1) { continue; }
    if (opts.since && e.timestamp < opts.since) { continue; }
    if (opts.until && e.timestamp > opts.until) { continue; }
    results.push(e);
  }

  if (opts.limit && results.length > opts.limit) {
    results = results.slice(results.length - opts.limit);
  }
  return results;
};

// ─────────────────────────────────────────────
//  CORE LOGGER
// ─────────────────────────────────────────────

function Logger(opts) {
  events.EventEmitter.call(this);

  opts = opts || {};
  this._context       = opts.context     || "app";
  this._level         = (opts.level !== undefined) ? opts.level : LOG_LEVELS.DEBUG;
  this._useColor      = (opts.color !== undefined) ? opts.color : true;
  this._logToConsole  = (opts.console !== undefined) ? opts.console : true;
  this._logToFile     = (opts.file !== undefined) ? opts.file : true;
  this._jsonFile      = (opts.jsonFile !== undefined) ? opts.jsonFile : true;
  this._ringSize      = opts.ringSize     || 2000;
  this._metricsInterval = opts.metricsInterval || 30000;

  this.metrics    = new MetricsCollector();
  this.alerts     = new AlertManager(this);
  this._ring      = new RingBuffer(this._ringSize);
  this._children  = [];

  if (this._logToFile) {
    ensureDir(LOG_DIR);
    this._textWriter = new RotatingFileWriter(
      path.join(LOG_DIR, "app.log"), MAX_FILE_MB, MAX_BACKUPS
    );
    this._jsonWriter = new RotatingFileWriter(
      path.join(LOG_DIR, "app.json.log"), MAX_FILE_MB, MAX_BACKUPS
    );
    this._errorWriter = new RotatingFileWriter(
      path.join(LOG_DIR, "error.log"), MAX_FILE_MB, MAX_BACKUPS
    );

    var self = this;
    this._flushTimer = setInterval(function() {
      self._textWriter.flush();
      self._jsonWriter.flush();
      self._errorWriter.flush();
    }, FLUSH_INTERVAL_MS);
    this._flushTimer.unref();
  }

  this._metricsTimer = setInterval(
    this._emitMetrics.bind(this),
    this._metricsInterval
  );
  this._metricsTimer.unref();

  process.on("uncaughtException", this._onUncaughtException.bind(this));
  process.on("unhandledRejection", this._onUnhandledRejection.bind(this));
  process.on("exit", this._onExit.bind(this));
  process.on("SIGINT",  this._onSignal.bind(this, "SIGINT"));
  process.on("SIGTERM", this._onSignal.bind(this, "SIGTERM"));
}

util.inherits(Logger, events.EventEmitter);

Logger.prototype._emitMetrics = function() {
  var snap = this.metrics.snapshot();
  this.emit("metrics", snap);
  this.info("[Monitor] Metrics snapshot", snap.memory);
};

Logger.prototype._onUncaughtException = function(err) {
  this.fatal("UncaughtException: " + err.message, { stack: err.stack });
};

Logger.prototype._onUnhandledRejection = function(reason) {
  var msg = (reason instanceof Error) ? reason.message : String(reason);
  this.error("UnhandledPromiseRejection: " + msg,
    { stack: (reason instanceof Error) ? reason.stack : null });
};

Logger.prototype._onExit = function(code) {
  this.info("Process exiting", { code: code });
  if (this._logToFile) {
    this._textWriter.flush();
    this._jsonWriter.flush();
    this._errorWriter.flush();
  }
};

Logger.prototype._onSignal = function(sig) {
  this.warn("Signal received: " + sig);
};

// Core write method
Logger.prototype._write = function(levelName, message, meta) {
  var level = LOG_LEVELS[levelName];
  if (level === undefined || level < this._level) { return; }

  var entry = buildEntry(level, levelName, message, meta, this._context);
  this._ring.push(entry);
  this.metrics.incrementLevel(levelName);
  this.alerts.evaluate(entry);
  this.emit("log", entry);

  if (this._logToConsole) {
    var line = entryToText(entry, this._useColor);
    if (level >= LOG_LEVELS.ERROR) {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  if (this._logToFile) {
    var textLine = entryToText(entry, false);
    var jsonLine = entryToJson(entry);
    this._textWriter.write(textLine);
    this._jsonWriter.write(jsonLine);
    if (level >= LOG_LEVELS.ERROR) {
      this._errorWriter.write(jsonLine);
    }
  }
};

// ── Public log-level methods ──────────────────
Logger.prototype.trace   = function(msg, meta) { this._write("TRACE",   msg, meta); };
Logger.prototype.debug   = function(msg, meta) { this._write("DEBUG",   msg, meta); };
Logger.prototype.info    = function(msg, meta) { this._write("INFO",    msg, meta); };
Logger.prototype.success = function(msg, meta) { this._write("SUCCESS", msg, meta); };
Logger.prototype.warn    = function(msg, meta) { this._write("WARN",    msg, meta); };
Logger.prototype.error   = function(msg, meta) { this._write("ERROR",   msg, meta); };
Logger.prototype.fatal   = function(msg, meta) { this._write("FATAL",   msg, meta); };

// ── Timer helpers ─────────────────────────────
Logger.prototype.startTimer = function(name) {
  this.metrics.startTimer(name);
  this.debug("Timer started: " + name);
};

Logger.prototype.endTimer = function(name) {
  var elapsed = this.metrics.endTimer(name);
  if (elapsed !== null) {
    this.debug("Timer ended: " + name, { ms: elapsed });
  }
  return elapsed;
};

Logger.prototype.timeAsync = function(name, fn, callback) {
  var self = this;
  self.startTimer(name);
  fn(function() {
    var elapsed = self.endTimer(name);
    self.info("Timed operation: " + name, { ms: elapsed });
    if (typeof callback === "function") { callback.apply(null, arguments); }
  });
};

// ── Child logger (forked context) ─────────────
Logger.prototype.child = function(childContext, extraOpts) {
  extraOpts = extraOpts || {};
  var child = new Logger({
    context:   childContext,
    level:     extraOpts.level     || this._level,
    color:     extraOpts.color     !== undefined ? extraOpts.color : this._useColor,
    console:   extraOpts.console   !== undefined ? extraOpts.console : this._logToConsole,
    file:      false,   // child writes go to parent transport
    ringSize:  extraOpts.ringSize  || 500
  });

  // Pipe child events to parent
  var parent = this;
  child.on("log", function(entry) {
    parent._ring.push(entry);
    parent.metrics.incrementLevel(entry.level);
    parent.alerts.evaluate(entry);
    parent.emit("log", entry);
    if (parent._logToFile) {
      parent._textWriter.write(entryToText(entry, false));
      parent._jsonWriter.write(entryToJson(entry));
      if (LOG_LEVELS[entry.level] >= LOG_LEVELS.ERROR) {
        parent._errorWriter.write(entryToJson(entry));
      }
    }
  });

  this._children.push(child);
  return child;
};

// ── Query ring buffer ─────────────────────────
Logger.prototype.query = function(opts) {
  return this._ring.query(opts || {});
};

// ── Print formatted metrics report ───────────
Logger.prototype.report = function() {
  var snap  = this.metrics.snapshot();
  var sep   = ANSI.border + "─".repeat(60) + ANSI.reset;
  var bold  = ANSI.bold;
  var reset = ANSI.reset;
  var label = ANSI.label;
  var val   = ANSI.value;
  var green = ANSI.success;

  process.stdout.write("\n" + sep + "\n");
  process.stdout.write(bold + green + "  ◉  ADVANCED LOGGING & MONITORING — REPORT" + reset + "\n");
  process.stdout.write(sep + "\n");

  process.stdout.write(label + "  Uptime    : " + val + snap.uptimeFormatted + reset + "\n");
  process.stdout.write(label + "  PID       : " + val + snap.pid + reset + "\n");
  process.stdout.write(label + "  Hostname  : " + val + snap.hostname + reset + "\n");
  process.stdout.write(label + "  Node.js   : " + val + snap.node + reset + "\n");
  process.stdout.write(label + "  Platform  : " + val + snap.platform + "/" + snap.arch + reset + "\n");

  process.stdout.write("\n" + bold + "  Memory" + reset + "\n");
  for (var mk in snap.memory) {
    if (snap.memory.hasOwnProperty(mk)) {
      process.stdout.write(label + "    " + padStart(mk, 10, " ") + " : " + val + snap.memory[mk] + reset + "\n");
    }
  }

  process.stdout.write("\n" + bold + "  OS" + reset + "\n");
  process.stdout.write(label + "    Total RAM  : " + val + snap.os.totalMemMB + " MB" + reset + "\n");
  process.stdout.write(label + "    Free RAM   : " + val + snap.os.freeMemMB  + " MB" + reset + "\n");
  process.stdout.write(label + "    Load Avg   : " + val + snap.os.loadAvg.join(", ") + reset + "\n");
  process.stdout.write(label + "    CPU Cores  : " + val + snap.os.cpuCount + reset + "\n");

  process.stdout.write("\n" + bold + "  Log Counts" + reset + "\n");
  for (var lk in snap.logCounts) {
    if (snap.logCounts.hasOwnProperty(lk)) {
      var color = ANSI[lk.toLowerCase()] || ANSI.info;
      process.stdout.write(
        label + "    " + padStart(lk, 8, " ") + " : "
        + color + bold + padStart(snap.logCounts[lk], 5, " ") + reset + "\n"
      );
    }
  }

  if (Object.keys(snap.timers).length > 0) {
    process.stdout.write("\n" + bold + "  Timers (ms)" + reset + "\n");
    for (var tk in snap.timers) {
      if (snap.timers.hasOwnProperty(tk)) {
        var ts = snap.timers[tk];
        if (!ts) { continue; }
        process.stdout.write(
          label + "    " + padStart(tk, 14, " ") + " : "
          + val + "avg=" + ts.avg + " min=" + ts.min + " max=" + ts.max
          + " p95=" + ts.p95 + " p99=" + ts.p99 + " n=" + ts.count + reset + "\n"
        );
      }
    }
  }

  if (Object.keys(snap.gauges).length > 0) {
    process.stdout.write("\n" + bold + "  Gauges" + reset + "\n");
    for (var gk in snap.gauges) {
      if (snap.gauges.hasOwnProperty(gk)) {
        process.stdout.write(label + "    " + padStart(gk, 14, " ") + " : " + val + snap.gauges[gk] + reset + "\n");
      }
    }
  }

  process.stdout.write(sep + "\n\n");
};

// ─────────────────────────────────────────────
//  MODULE EXPORTS
// ─────────────────────────────────────────────
module.exports = { Logger: Logger, LOG_LEVELS: LOG_LEVELS };


/* ═══════════════════════════════════════════════════════
   DEMO  —  executed when you run:  node logger.js
   ═══════════════════════════════════════════════════════ */

if (require.main === module) {

  var Logger     = module.exports.Logger;

  var log = new Logger({
    context:         "main",
    level:           0,          // TRACE = show everything
    color:           true,
    console:         true,
    file:            true,
    metricsInterval: 60000       // emit metrics every 60s
  });

  // ── Alert rule: fire on any ERROR+ ──────────
  log.alerts.addRule({
    name:       "error-alert",
    level:      "ERROR",
    cooldownMs: 5000,
    handler:    function(entry) {
      process.stdout.write(
        ANSI.fatal + ANSI.bold + " !! ALERT !! " + ANSI.reset
        + " Rule triggered for: " + entry.message + "\n"
      );
    }
  });

  // ── Metrics event listener ───────────────────
  log.on("metrics", function(snap) {
    log.debug("[Metrics] Heartbeat", {
      uptime: snap.uptimeFormatted,
      rss:    snap.memory.rss
    });
  });

  // ── Alert event listener ─────────────────────
  log.on("alert", function(data) {
    log.warn("[AlertManager] Alert fired", { rule: data.rule, msg: data.entry.message });
  });

  // ─────────────────────────────────────────
  //  DEMO SEQUENCE
  // ─────────────────────────────────────────
  log.info("=== Advanced Logging & Monitoring System — Demo ===");

  log.trace("Trace-level detail: reading config file");
  log.debug("Parsed configuration", { env: process.env.NODE_ENV || "development", pid: process.pid });
  log.info("Application initialised", { version: "1.0.0", node: process.version });
  log.success("Database connection established", { host: "db.internal", pool: 10 });
  log.warn("Disk usage above 80%", { path: "/var/data", used: "82%" });

  // ── Child logger for a sub-module ───────────
  var dbLog = log.child("database");
  dbLog.info("Query executed", { sql: "SELECT * FROM users", rows: 128, ms: 14 });
  dbLog.warn("Slow query detected", { ms: 950, threshold: 500 });

  var apiLog = log.child("api");
  apiLog.info("Incoming request", { method: "GET", path: "/users", ip: "10.0.0.1" });
  apiLog.info("Response sent",    { status: 200, ms: 37 });

  // ── Timer usage ──────────────────────────────
  log.startTimer("init");
  setTimeout(function() {
    var ms = log.endTimer("init");
    log.success("Initialisation complete", { ms: ms });

    // ── Gauge ────────────────────────────────
    log.metrics.setGauge("activeConnections", 42);
    log.metrics.setGauge("requestQueueDepth",  7);

    // ── Trigger alert ─────────────────────────
    log.error("Payment gateway timeout", { gateway: "stripe", attempt: 3 });
    log.fatal("Out-of-memory condition detected", { heapUsed: "512 MB", limit: "512 MB" });

    // ── timeAsync helper ─────────────────────
    log.timeAsync("cache-warm", function(done) {
      setTimeout(done, 60);
    }, function() {
      log.success("Cache warmed successfully");

      // ── Query in-memory ring buffer ─────────
      var errors = log.query({ level: "ERROR", limit: 10 });
      log.info("Recent ERROR entries in ring buffer", { count: errors.length });

      var dbEntries = log.query({ context: "database", limit: 5 });
      log.info("Recent database log entries", { count: dbEntries.length });

      // ── Final report ────────────────────────
      setTimeout(function() {
        log.report();
        log.info("Demo complete — check ./logs/ for log files");
      }, 200);
    });

  }, 120);
}
