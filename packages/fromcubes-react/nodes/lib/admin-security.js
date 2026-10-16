/** @module nodes/lib/admin-security */

/**
 * The gates every fromcubes admin route goes through — permission scopes,
 * the CSRF header check and the per-IP rate limit — plus the express that
 * Node-RED itself ships. Shared by the core and by the add-on packages
 * (through the `api` export, lib/api.js), so an add-on's routes get exactly
 * the same protection and the same rate-limit buckets as the core's.
 */

/**
 * Borrow the express that the running Node-RED ships with instead of
 * declaring our own copy. We only need its static/json/raw middleware; the
 * server itself is RED.httpAdmin/RED.httpNode. This package lives in
 * `<userDir>/node_modules`, from where a plain require cannot see Node-RED's
 * install directory, so resolve from the entry script that started the
 * process (node-red's red.js). Embedded Node-RED (an app that requires
 * node-red itself) falls back to a plain require — such an app has express.
 * @returns {typeof import("express")}
 */
function loadExpress() {
  const entry = require.main && require.main.filename;
  if (entry) {
    try {
      return require("module").createRequire(entry)("express");
    } catch (_) {
      // not launched through node-red's own entry script
    }
  }
  return require("express");
}

/**
 * Build the admin gates bound to `RED`. Safe to call more than once (core
 * and each add-on do): the rate-limit buckets and their prune timer live on
 * `RED.settings`, so every caller shares one bucket per client IP.
 *
 * @param {Object} RED
 * @returns {{
 *   permRead: import("express").RequestHandler,
 *   permWrite: import("express").RequestHandler,
 *   csrfGuard: import("express").RequestHandler,
 *   rateLimit: import("express").RequestHandler,
 * }}
 */
function createAdminSecurity(RED) {
  // ── Admin auth gate (Node-RED 4.x adminAuth) ─────────────────
  // When the user configures `adminAuth` in settings.js, RED.auth.needsPermission
  // returns an Express middleware that enforces the named permission scope.
  // Without this gate, any endpoint mounted on RED.httpAdmin is reachable
  // without auth and can read/modify the registry, utilities, and assets.
  // Fallback no-op for runtimes that do not expose RED.auth.
  /**
   * Resolve a Node-RED permission middleware. Returns a no-op when the runtime
   * does not expose `RED.auth.needsPermission` (test harnesses, Node-RED <1.0)
   * so unit tests don't have to mock auth.
   *
   * @param {string} scope  Permission scope (e.g. `"portal-react.write"`).
   * @returns {import("express").RequestHandler}
   * @private
   */
  function needsPerm(scope) {
    if (RED.auth && typeof RED.auth.needsPermission === "function") {
      return RED.auth.needsPermission(scope);
    }
    return function (_req, _res, next) { next(); };
  }
  const PERM_READ = needsPerm("portal-react.read");
  const PERM_WRITE = needsPerm("portal-react.write");

  // ── CSRF guard for admin write endpoints ──────────────────────
  // The Node-RED editor sends `Node-RED-API-Version` on every XHR. Browsers
  // refuse to attach custom headers on cross-origin form/fetch submissions
  // without a CORS preflight, so requiring this header on write endpoints is
  // sufficient CSRF protection without per-session tokens. Same trick the
  // Node-RED core admin API uses for its own POST/PUT/DELETE routes.
  /**
   * Express middleware enforcing the `Node-RED-API-Version` header on write
   * endpoints. The header is sent by the Node-RED editor XHR layer on every
   * request; browser cross-origin form/fetch POSTs cannot attach custom
   * headers without a CORS preflight, so requiring this header gives CSRF
   * protection without per-session tokens.
   *
   * @param {import("express").Request}  req
   * @param {import("express").Response} res
   * @param {Function}                   next
   * @returns {void}
   * @private
   */
  function csrfGuard(req, res, next) {
    if (!req.get("Node-RED-API-Version")) {
      return res.status(403).json({ error: "missing Node-RED-API-Version header" });
    }
    next();
  }

  // ── Token-bucket rate limiter keyed by req.ip ─────────────────
  // Steady-state: RATE_LIMIT_TOKENS tokens refilled over RATE_LIMIT_WINDOW_MS.
  // Default = 60 tokens / 60 s → 1 req/s sustained, 60 burst. Tunable via
  // RED.settings.portalReact.rateLimit = { tokens, windowMs }. The buckets
  // are pruned every 5 minutes to bound memory usage.
  const rateLimitCfg = (RED.settings.portalReact &&
    RED.settings.portalReact.rateLimit) || {};
  const RATE_LIMIT_TOKENS = Number.isFinite(rateLimitCfg.tokens)
    ? rateLimitCfg.tokens
    : 60;
  const RATE_LIMIT_WINDOW_MS = Number.isFinite(rateLimitCfg.windowMs)
    ? rateLimitCfg.windowMs
    : 60_000;
  if (!RED.settings.portalReactRateBuckets) RED.settings.portalReactRateBuckets = new Map();
  const rateBuckets = RED.settings.portalReactRateBuckets;

  /**
   * Token-bucket rate limit middleware keyed by `req.ip`. Each bucket refills
   * `RATE_LIMIT_TOKENS` over `RATE_LIMIT_WINDOW_MS`. Steady-state default is
   * 1 request/second with a 60-token burst. On exhaustion: HTTP 429 with
   * `Retry-After`. Buckets idle > 10 minutes get pruned by a separate
   * interval (see below).
   *
   * @param {import("express").Request}  req
   * @param {import("express").Response} res
   * @param {Function}                   next
   * @returns {void}
   * @private
   */
  function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    let b = rateBuckets.get(ip);
    if (!b) {
      b = { tokens: RATE_LIMIT_TOKENS, last: now };
      rateBuckets.set(ip, b);
    }
    const elapsed = now - b.last;
    b.tokens = Math.min(
      RATE_LIMIT_TOKENS,
      b.tokens + (elapsed * RATE_LIMIT_TOKENS) / RATE_LIMIT_WINDOW_MS,
    );
    b.last = now;
    if (b.tokens < 1) {
      res.set("Retry-After", Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
      return res.status(429).json({ error: "rate limit exceeded" });
    }
    b.tokens -= 1;
    next();
  }

  if (!RED.settings.portalReactRateBucketPruneIv) {
    RED.settings.portalReactRateBucketPruneIv = setInterval(() => {
      const now = Date.now();
      for (const [ip, b] of rateBuckets) {
        if (now - b.last > 10 * 60_000) rateBuckets.delete(ip);
      }
    }, 5 * 60_000);
    RED.settings.portalReactRateBucketPruneIv.unref?.();
  }

  return { permRead: PERM_READ, permWrite: PERM_WRITE, csrfGuard, rateLimit };
}

module.exports = { createAdminSecurity, loadExpress };
