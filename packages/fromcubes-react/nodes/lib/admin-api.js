const path = require("path");

/**
 * Editor assets are also served under a path carrying the core's version
 * (`fromcubes-react/0.2.0/editor/…`), and the editor template loads them from
 * there. Every cache in between — the browser, a CDN, a reverse proxy — keys
 * on the path, so a new release can never be handed an old file, nor a 404
 * remembered from a moment the route did not exist yet. Query strings are not
 * enough: some caches ignore them. The unversioned paths stay for anything
 * that still points at them.
 */
const ASSET_VERSION = String(require("../../package.json").version).replace(
  /[^0-9A-Za-z.+-]/g,
  "",
);
/** Relative to the admin root, as the editor needs it (no leading slash). */
const ASSET_BASE = "fromcubes-react/" + ASSET_VERSION + "/";

/**
 * Register editor/admin/public support routes for portal-react.
 *
 * This module intentionally owns only HTTP route registration. Runtime page
 * state and registries remain owned by portal-react.js and are passed in so
 * deploy/rebuild lifecycle stays in one place.
 *
 * @param {Object} RED
 * @param {Object} deps
 * @param {import("express")} deps.express
 * @param {Function} deps.permRead
 * @param {Function} deps.permWrite
 * @param {Function} deps.csrfGuard
 * @param {Function} deps.rateLimit
 * @param {Object<string, Object>} deps.pageState
 * @param {Object<string, Object>} deps.registry
 * @param {Object<string, Object>} deps.utilities
 * @param {(code: string) => Set<string>} deps.extractUtilitySymbols
 * @param {Object} [deps.providers]          lib/providers registry (describe/select).
 * @param {Function} [deps.onProviderChange] Called with the kind after a choice changed.
 * @returns {void}
 */
function registerAdminApi(RED, deps) {
  const {
    express,
    permRead,
    permWrite,
    csrfGuard,
    rateLimit,
    pageState,
    registry,
    utilities,
    extractUtilitySymbols,
    providers,
    onProviderChange,
  } = deps;

  /**
   * Mount one static directory at both its plain and its versioned path.
   * @param {string} name
   * @param {string} dir
   * @returns {void}
   */
  function serveStatic(name, dir) {
    const files = express.static(dir);
    RED.httpAdmin.use("/fromcubes-react/" + name, permRead, files);
    RED.httpAdmin.use("/" + ASSET_BASE + name, permRead, files);
  }

  // Since 0.56 monaco-editor has an `exports` map that hides package.json;
  // its CommonJS entry is min/vs/index.js, so the AMD build (loader.js and
  // editor/editor.main.js) sits in the same directory.
  serveStatic("vs", path.dirname(require.resolve("monaco-editor")));

  // Editor-side workspace plugin (tree + full-screen Monaco overlay). Served
  // as static files instead of being inlined into portal-react.html so the
  // node's editor template stays readable.
  serveStatic("editor", path.join(__dirname, "..", "editor"));

  // The node icon doubles as the editor's status-bar mark. Serving the icons
  // directory here keeps one copy on disk and spares the client from having to
  // know the package name that Node-RED's own /icons route is keyed by.
  serveStatic("icons", path.join(__dirname, "..", "icons"));

  // Prettier's browser builds, straight from node_modules — same arrangement
  // as Monaco at /fromcubes-react/vs. Nothing is fetched until someone formats.
  serveStatic("prettier", path.dirname(require.resolve("prettier/package.json")));

  const CSS_HASH_RE = /^[a-f0-9]{1,64}$/;
  function findCssByHash(reqHash) {
    for (const ep in pageState) {
      if (pageState[ep]?.cssHash === reqHash) return pageState[ep].css;
    }
    return null;
  }
  function serveCss(req, res) {
    const reqHash = req.params.hash;
    if (!CSS_HASH_RE.test(reqHash)) {
      res.status(400).send("Bad request");
      return;
    }
    const css = findCssByHash(reqHash);
    if (!css) {
      res.status(404).send("Not found");
      return;
    }
    res.set({
      "Content-Type": "text/css",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.send(css);
  }

  RED.httpNode.get("/fromcubes/css/:hash.css", serveCss);


  RED.httpAdmin.get("/fromcubes-react/registry", permRead, (_req, res) => {
    res.json(registry);
  });

  RED.httpAdmin.post(
    "/fromcubes-react/registry",
    permWrite,
    csrfGuard,
    rateLimit,
    (_req, res) => {
      res.status(410).json({
        error: "registry writes are deprecated; use fc-portal-component nodes",
      });
    },
  );

  RED.httpAdmin.delete(
    "/fromcubes-react/registry/:name",
    permWrite,
    csrfGuard,
    rateLimit,
    (_req, res) => {
      res.status(410).json({
        error: "registry writes are deprecated; use fc-portal-component nodes",
      });
    },
  );

  RED.httpAdmin.get("/fromcubes-react/utilities", permRead, (_req, res) => {
    const out = {};
    for (const [name, u] of Object.entries(utilities)) {
      out[name] = {
        code: u.code,
        error: u.error || null,
        symbols: [...extractUtilitySymbols(u.code || "")],
      };
    }
    res.json(out);
  });

  RED.httpAdmin.post(
    "/fromcubes-react/utilities",
    permWrite,
    csrfGuard,
    rateLimit,
    (_req, res) => {
      res.status(410).json({
        error: "utility writes are deprecated; use fc-portal-utility nodes",
      });
    },
  );

  RED.httpAdmin.delete(
    "/fromcubes-react/utilities/:name",
    permWrite,
    csrfGuard,
    rateLimit,
    (_req, res) => {
      res.status(410).json({
        error: "utility writes are deprecated; use fc-portal-utility nodes",
      });
    },
  );

  if (providers) registerProviderRoutes(RED, deps);
}

// select() error code → HTTP status
const SELECT_STATUS = { "bad-kind": 400, "bad-id": 400, unknown: 400, locked: 409 };

/**
 * Settings → Fromcubes: read and change the identity provider and CSS engine.
 * Changing identity decides who counts as logged in, so the write sits
 * behind the same permission, CSRF and rate-limit gates as every other
 * admin write, and is logged with the editor user who made it.
 *
 * @param {Object} RED
 * @param {Object} deps  See registerAdminApi.
 * @returns {void}
 * @private
 */
function registerProviderRoutes(RED, deps) {
  const { express, permRead, permWrite, csrfGuard, rateLimit, providers, onProviderChange } = deps;
  // Node-RED's admin app parses JSON already (capped by apiMaxLength); parse
  // only where nothing upstream did — the same arrangement as lib/assets.js.
  const parseJson = express.json({ limit: (RED.settings && RED.settings.apiMaxLength) || "5mb" });
  const jsonBody = (req, res, next) => (req._body ? next() : parseJson(req, res, next));

  RED.httpAdmin.get("/fromcubes-react/providers", permRead, (_req, res) => {
    res.json(providers.describe());
  });

  // Completion data for className="…", from whichever CSS engine is in force.
  // `engine` lets the editor tell a stale list from a fresh one.
  RED.httpAdmin.get("/fromcubes-react/css-classes", permRead, async (_req, res) => {
    try {
      res.json(await providers.editorClasses());
    } catch (e) {
      RED.log.error("[portal-react] css-classes: " + e.message);
      res.status(500).json({ error: "could not list classes" });
    }
  });

  // What the editor shows for classes it has in hand: a completion's CSS,
  // a hover, a modifier's swatch, whether a variant exists. `c` carries the
  // candidates newline-separated — a class never holds whitespace, and one
  // string sidesteps query-string array parsing.
  // Canonical spellings (`w-[16px]` → `w-4`) for the diagnostic — apart
  // from css-describe because an engine may be slow here, and a hover must
  // not wait for it. Same `c` format.
  for (const [route, method, what] of [
    ["css-describe", "describeClasses", "describe"],
    ["css-canonical", "canonicalClasses", "canonicalise"],
  ]) {
    RED.httpAdmin.get("/fromcubes-react/" + route, permRead, async (req, res) => {
      const c = req.query.c;
      if (typeof c !== "string") {
        res.status(400).json({ error: "expected class candidates in c" });
        return;
      }
      try {
        res.json(await providers[method](c.split("\n")));
      } catch (e) {
        if (e instanceof TypeError) {
          res.status(400).json({ error: e.message });
          return;
        }
        RED.log.error(`[portal-react] ${route}: ${e.message}`);
        res.status(500).json({ error: `could not ${what} classes` });
      }
    });
  }

  RED.httpAdmin.put(
    "/fromcubes-react/providers",
    permWrite,
    csrfGuard,
    rateLimit,
    jsonBody,
    (req, res) => {
      const { kind, id } = req.body || {};
      let changed;
      try {
        changed = providers.select(kind, id);
      } catch (e) {
        const status = SELECT_STATUS[e.code];
        if (!status) {
          RED.log.error("[portal-react] saving provider choice failed: " + e.message);
          res.status(500).json({ error: "could not save the provider choice" });
          return;
        }
        res.status(status).json({ error: e.message, code: e.code });
        return;
      }
      if (changed) {
        const who = (req.user && req.user.username) || "anonymous editor";
        RED.log.warn(`[portal-react] ${kind} provider set to "${id}" by ${who}`);
        if (onProviderChange) onProviderChange(kind);
      }
      res.json(providers.describe());
    },
  );
}

module.exports = { registerAdminApi, ASSET_BASE };
