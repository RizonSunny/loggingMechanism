const morgan = require('morgan');

/**
 * Creates Morgan HTTP access logging middleware that writes to Winston.
 *
 * WHY THIS EXISTS:
 * ─────────────────
 * Morgan logs HTTP requests (server logs), but by default it writes to stdout
 * as plain text like: "POST /login 200 12ms"
 *
 * We want ALL logs (server + application) in the SAME structured JSON format
 * so ELK can parse them uniformly. This bridge:
 *   1. Tells Morgan to output JSON tokens (method, url, status, response-time)
 *   2. Pipes that output into Winston (which adds timestamp, service, host, etc.)
 *
 * RESULT:
 * Instead of: "POST /login 200 12ms"
 * We get:
 * {
 *   "timestamp": "2026-03-27T10:30:00.000Z",
 *   "level": "info",
 *   "message": "HTTP request completed",
 *   "service": "auth-service",
 *   "log_type": "access",
 *   "method": "POST",
 *   "url": "/login",
 *   "status": 200,
 *   "response_time_ms": 12,
 *   "content_length": "45",
 *   "remote_addr": "::1"
 * }
 */
function createMorganMiddleware(logger) {
  // Custom Morgan token format — we return a JSON string
  // Morgan calls this function for every HTTP request/response
  return morgan(
    (tokens, req, res) => {
      const status = parseInt(tokens.status(req, res), 10);

      // Choose log level based on HTTP status code:
      //   2xx/3xx → info (normal traffic)
      //   4xx     → warn (client errors — bad input, not found, unauthorized)
      //   5xx     → error (server errors — our code broke)
      const logLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

      // Write directly to Winston with structured fields
      logger[logLevel]('HTTP request completed', {
        log_type: 'access',                                        // ← identifies this as a server/access log
        method: tokens.method(req, res),                           // GET, POST, etc.
        url: tokens.url(req, res),                                 // /login, /orders, etc.
        status: status,                                            // 200, 404, 500, etc.
        response_time_ms: parseFloat(tokens['response-time'](req, res)) || 0,
        content_length: tokens.res(req, res, 'content-length') || '0',
        remote_addr: tokens['remote-addr'](req, res),              // Client IP
        user_agent: tokens['user-agent'](req, res),                // Browser/client info
      });

      // Return null — we already wrote to Winston, don't let Morgan write to stdout too
      return null;
    },
    {
      // Morgan's "stream" option — skip its default stdout writing
      // since we write directly via logger above
      stream: { write: () => {} },
    }
  );
}

module.exports = { createMorganMiddleware };
