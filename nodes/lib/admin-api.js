const path = require("path");

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
 * @param {string} deps.userDir
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
    userDir,
    pageState,
    registry,
    utilities,
    extractUtilitySymbols,
    providers,
    onProviderChange,
  } = deps;

  // Since 0.56 monaco-editor has an `exports` map that hides package.json;
  // its CommonJS entry is min/vs/index.js, so the AMD build (loader.js and
  // editor/editor.main.js) sits in the same directory.
  const monacoVsPath = path.dirname(require.resolve("monaco-editor"));
  RED.httpAdmin.use(
    "/portal-react/vs",
    permRead,
    express.static(monacoVsPath),
  );

  // Editor-side workspace plugin (tree + full-screen Monaco overlay). Served
  // as static files instead of being inlined into portal-react.html so the
  // node's editor template stays readable.
  RED.httpAdmin.use(
    "/portal-react/editor",
    permRead,
    express.static(path.join(__dirname, "..", "editor")),
  );

  // The node icon doubles as the editor's status-bar mark. Serving the icons
  // directory here keeps one copy on disk and spares the client from having to
  // know the package name that Node-RED's own /icons route is keyed by.
  RED.httpAdmin.use(
    "/portal-react/icons",
    permRead,
    express.static(path.join(__dirname, "..", "icons")),
  );

  // Prettier's browser builds, straight from node_modules — same arrangement
  // as Monaco at /portal-react/vs. Nothing is fetched until someone formats.
  RED.httpAdmin.use(
    "/portal-react/prettier",
    permRead,
    express.static(path.dirname(require.resolve("prettier/package.json"))),
  );

  const { generateCandidates } = require("../tw-candidates");
  let twClassesCache = null;
  RED.httpAdmin.get("/portal-react/tw-classes", permRead, (_req, res) => {
    if (!twClassesCache) {
      twClassesCache = generateCandidates();
    }
    res.json(twClassesCache);
  });

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

  const { registerAssets } = require("./assets");
  registerAssets(RED, express, path.join(userDir, "fromcubes", "public"), {
    csrfGuard,
    rateLimit,
  });

  RED.httpAdmin.get("/portal-react/registry", permRead, (_req, res) => {
    res.json(registry);
  });

  RED.httpAdmin.post(
    "/portal-react/registry",
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
    "/portal-react/registry/:name",
    permWrite,
    csrfGuard,
    rateLimit,
    (_req, res) => {
      res.status(410).json({
        error: "registry writes are deprecated; use fc-portal-component nodes",
      });
    },
  );

  RED.httpAdmin.get("/portal-react/utilities", permRead, (_req, res) => {
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
    "/portal-react/utilities",
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
    "/portal-react/utilities/:name",
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

  RED.httpAdmin.get("/portal-react/providers", permRead, (_req, res) => {
    res.json(providers.describe());
  });

  RED.httpAdmin.put(
    "/portal-react/providers",
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

module.exports = { registerAdminApi };
