/** @module nodes/lib/providers */

/**
 * Pluggable providers for @aaqu/fromcubes-portal-react.
 *
 * Two extension points, each a Node-RED plugin type:
 *
 *   RED.plugins.registerPlugin("my-sso", {
 *     type: "fromcubes-portal-identity",
 *     apiVersion: 1,
 *     resolveUser(req) { return { userId, login, displayName, email, role, groups } | null },
 *   })
 *
 *   RED.plugins.registerPlugin("my-css", {
 *     type: "fromcubes-portal-css",
 *     apiVersion: 1,
 *     generate(source) { return { css } },
 *     editor: { classes() { return ["p-4", …] } },   // optional: completion
 *   })
 *
 * The built-in providers (`headers` and `none` for identity, `tailwind` and
 * `none` for css) are defined with the same shape and pass through the same
 * validation, so the API is exercised by our own code on every request and
 * every build.
 *
 * Selection is explicit, exactly one provider per kind, first match wins:
 *   1. `RED.settings.portalReact.identityProvider` / `.cssEngine` (settings.js)
 *      — the administrator's word; the editor shows it locked.
 *   2. The choice made in the editor (Settings → Fromcubes), persisted in
 *      `<userDir>/fromcubes/providers.json`.
 *   3. The defaults, `headers` and `tailwind`.
 * Installing a plugin never switches anything on its own — for identity that
 * would let a package change who counts as logged in.
 *
 * Failure semantics:
 * - identity: unknown provider, wrong apiVersion, throw, timeout or a result
 *   that does not validate ⇒ anonymous (`null`). Fail closed: anonymous is the
 *   least privileged answer.
 * - css: unknown provider or wrong apiVersion ⇒ `generate` rejects, which the
 *   build turns into the yellow `css-fail` status (page still served).
 */

const IDENTITY_TYPE = "fromcubes-portal-identity";
const CSS_TYPE = "fromcubes-portal-css";
const API_VERSION = 1;

const DEFAULT_IDENTITY = "headers";
const DEFAULT_CSS = "tailwind";

// Bounds on what a provider may hand us. Generous enough that anything the
// built-in header parser produces passes untouched (its groups header is
// capped at 8 KB, so at most ~4096 one-char groups); anything above is
// dropped rather than cut, same reasoning as the groups header: a shortened
// value could match a different, real one.
const MAX_USER_STRING = 8192;
const MAX_GROUPS = 4096;
const IDENTITY_TIMEOUT_MS = 5000;
// Completion list sent to the editor. Tailwind's own list is a few thousand
// entries; the caps only stop a plugin from shipping something absurd to
// every editor that opens a dialog.
const MAX_EDITOR_CLASSES = 50000;
const MAX_EDITOR_CLASS_LEN = 200;

const USER_STRING_FIELDS = ["login", "displayName", "email", "role"];

const KINDS = {
  identity: { type: IDENTITY_TYPE, setting: "identityProvider", fallback: DEFAULT_IDENTITY },
  css: { type: CSS_TYPE, setting: "cssEngine", fallback: DEFAULT_CSS },
};

// Provider ids travel through the settings file, the admin API and the
// editor's DOM. Plugin ids are free-form in Node-RED; anything outside this
// shape can be registered but not selected.
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Error from `select()`, with a code the admin API maps to an HTTP status.
 */
class ProviderSelectError extends Error {
  /**
   * @param {"bad-kind"|"bad-id"|"locked"|"unknown"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {*} v
 * @returns {boolean}
 */
function isBoundedString(v) {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_USER_STRING;
}

/**
 * Normalize a provider's answer into a PortalUser, or null. Only the known
 * fields are copied — never the provider's object itself — so a provider
 * cannot smuggle extra keys (or a getter, or a prototype) into `msg._client`
 * and `useNodeRed().user`.
 *
 * @param {*} raw
 * @returns {import("./helpers").PortalUser|null}
 */
function sanitizeUser(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!isBoundedString(raw.userId)) return null;
  const user = { userId: raw.userId };
  for (const field of USER_STRING_FIELDS) {
    if (isBoundedString(raw[field])) user[field] = raw[field];
  }
  const groups = [];
  if (Array.isArray(raw.groups) && raw.groups.length <= MAX_GROUPS) {
    for (const g of raw.groups) if (isBoundedString(g)) groups.push(g);
  }
  user.groups = groups;
  return user;
}

/**
 * Built-in providers. `helpers` supplies the actual implementations so this
 * module stays free of tailwind/header specifics.
 *
 * @param {{ extractPortalUser: Function, generateCSS: Function, tailwindClasses?: Function }} helpers
 * @returns {{ identity: Object<string,Object>, css: Object<string,Object> }}
 */
function builtinProviders(helpers) {
  return {
    identity: {
      headers: {
        id: "headers",
        type: IDENTITY_TYPE,
        apiVersion: API_VERSION,
        label: "x-portal-user-* headers from a reverse proxy",
        resolveUser: (req) => helpers.extractPortalUser(req.headers || {}),
      },
      none: {
        id: "none",
        type: IDENTITY_TYPE,
        apiVersion: API_VERSION,
        label: "Nobody is identified — every session is anonymous",
        resolveUser: () => null,
      },
    },
    css: {
      tailwind: {
        id: "tailwind",
        type: CSS_TYPE,
        apiVersion: API_VERSION,
        label: "Tailwind CSS 4 utility classes",
        generate: async (source) => {
          const { css } = await helpers.generateCSS(source);
          return { css };
        },
        editor: {
          classes: () => (helpers.tailwindClasses ? helpers.tailwindClasses() : []),
        },
      },
      none: {
        id: "none",
        type: CSS_TYPE,
        apiVersion: API_VERSION,
        label: "No stylesheet",
        generate: () => ({ css: "" }),
      },
    },
  };
}

/**
 * Create the provider registry bound to `RED`.
 *
 * @param {Object} RED
 * @param {{ extractPortalUser: Function, generateCSS: Function }} helpers
 * @param {{ identityTimeoutMs?: number, storeFile?: string }} [opts]
 *   `storeFile`: where the editor's choice is persisted; without it the
 *   choice lives in memory only (tests, embedded use).
 * @returns {{
 *   resolveUser: function(Object): Promise<Object|null>,
 *   generateCss: function(string): Promise<{css: string}>,
 *   identityId: function(): string,
 *   cssEngineId: function(): string,
 *   describe: function(): Object,
 *   select: function(string, string): boolean,
 *   editorClasses: function(): Promise<{engine: string, classes: Array<string>}>,
 * }}
 */
function createProviders(RED, helpers, opts = {}) {
  const fs = require("fs");
  const path = require("path");
  const builtins = builtinProviders(helpers);
  const tables = { identity: builtins.identity, css: builtins.css };
  const identityTimeoutMs = opts.identityTimeoutMs ?? IDENTITY_TIMEOUT_MS;
  const storeFile = opts.storeFile || null;
  const logged = new Set();
  /** @type {{identity?: string, css?: string}} */
  const chosen = loadChoice();
  // provider object → its validated class list. Keyed by the object, not the
  // id, so a plugin reinstalled at runtime (a new definition) is asked again.
  const classCache = new WeakMap();

  /**
   * Log a configuration problem once per process — these are evaluated per
   * request, and a misconfigured provider must not flood the log.
   * @param {string} msg
   * @returns {void}
   */
  function logOnce(msg) {
    if (logged.has(msg)) return;
    logged.add(msg);
    RED.log.error("[portal-react] " + msg);
  }

  /** @returns {Object} */
  function cfg() {
    return (RED.settings && RED.settings.portalReact) || {};
  }

  /**
   * Read the editor's persisted choice. A missing file is the normal first
   * run; a malformed one is reported and ignored (defaults apply) rather
   * than stopping Node-RED.
   * @returns {{identity?: string, css?: string}}
   */
  function loadChoice() {
    if (!storeFile) return {};
    let raw;
    try {
      raw = fs.readFileSync(storeFile, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") {
        RED.log.warn(`[portal-react] cannot read ${storeFile}: ${e.message}`);
      }
      return {};
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      RED.log.warn(`[portal-react] ignoring malformed ${storeFile}: ${e.message}`);
      return {};
    }
    const out = {};
    if (data && typeof data === "object") {
      for (const kind of Object.keys(KINDS)) {
        if (typeof data[kind] === "string" && PROVIDER_ID_RE.test(data[kind])) {
          out[kind] = data[kind];
        }
      }
    }
    return out;
  }

  /**
   * Persist the choice atomically: a crash mid-write must not leave a
   * half-written file that silently resets identity to the default.
   * @returns {void}
   */
  function saveChoice() {
    if (!storeFile) return;
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const tmp = storeFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(chosen, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, storeFile);
  }

  /**
   * The provider id in force for `kind`, and where it came from.
   * @param {"identity"|"css"} kind
   * @returns {{ id: string, source: "settings"|"editor"|"default" }}
   */
  function current(kind) {
    const k = KINDS[kind];
    const fromSettings = cfg()[k.setting];
    if (typeof fromSettings === "string" && fromSettings) {
      return { id: fromSettings, source: "settings" };
    }
    if (chosen[kind]) return { id: chosen[kind], source: "editor" };
    return { id: k.fallback, source: "default" };
  }

  /**
   * Plugins registered with Node-RED for `type`. Never throws.
   * @param {string} type
   * @returns {Array<Object>}
   */
  function pluginsOf(type) {
    try {
      return ((RED.plugins && RED.plugins.getByType(type)) || []).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  /**
   * Find the provider `id` of `type`: built-ins first (their ids are
   * reserved), then plugins registered with Node-RED.
   *
   * @param {string} type
   * @param {Object<string,Object>} table
   * @param {string} id
   * @returns {{ provider: Object|null, error: string|null }}
   */
  function lookup(type, table, id) {
    const plugins = pluginsOf(type);
    // Scanned before the built-in short-circuit: a plugin shadowing a
    // built-in id must be reported even while the built-in is in use.
    for (const p of plugins) {
      if (p && Object.prototype.hasOwnProperty.call(table, p.id)) {
        logOnce(`${type} plugin "${p.id}" ignored: id is reserved for a built-in`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(table, id)) {
      return { provider: table[id], error: null };
    }
    const found = plugins.find((p) => p && p.id === id);
    if (!found) {
      return { provider: null, error: `${type} provider "${id}" is not registered` };
    }
    if (found.apiVersion !== API_VERSION) {
      return {
        provider: null,
        error: `${type} provider "${id}" has apiVersion ${JSON.stringify(found.apiVersion)}, expected ${API_VERSION}`,
      };
    }
    return { provider: found, error: null };
  }

  /** @returns {string} */
  function identityId() {
    return current("identity").id;
  }

  /** @returns {string} */
  function cssEngineId() {
    return current("css").id;
  }

  /**
   * Everything the editor's settings pane needs: per kind, what is in force,
   * where it came from, whether it can be changed, and every provider that
   * could be chosen. A selected id that is no longer registered stays in
   * the list, flagged `missing`, so the editor can say so instead of
   * silently showing nothing selected.
   *
   * @returns {Object<string, {selected: string, source: string, locked: boolean, missing: boolean,
   *   options: Array<{id: string, label: string, module: string, builtin: boolean, missing?: boolean, problem?: string}>}>}
   */
  function describe() {
    const out = {};
    for (const [kind, k] of Object.entries(KINDS)) {
      const table = tables[kind];
      const options = Object.values(table).map((p) => ({
        id: p.id,
        label: p.label || "",
        module: "built-in",
        builtin: true,
      }));
      const seen = new Set(options.map((o) => o.id));
      for (const p of pluginsOf(k.type)) {
        if (typeof p.id !== "string" || seen.has(p.id)) continue;
        seen.add(p.id);
        const opt = {
          id: p.id,
          label: typeof p.label === "string" ? p.label : "",
          module: typeof p.module === "string" ? p.module : "",
          builtin: false,
        };
        if (p.apiVersion !== API_VERSION) {
          opt.problem = `apiVersion ${JSON.stringify(p.apiVersion)}, expected ${API_VERSION}`;
        } else if (!PROVIDER_ID_RE.test(p.id)) {
          opt.problem = "id cannot be selected (letters, digits, . _ - only)";
        }
        options.push(opt);
      }
      const { id, source } = current(kind);
      const missing = !seen.has(id);
      if (missing) {
        options.push({ id, label: "", module: "", builtin: false, missing: true });
      }
      out[kind] = { selected: id, source, locked: source === "settings", missing, options };
    }
    return out;
  }

  /**
   * Choose the provider for `kind` from the editor and persist it. Only a
   * provider that is registered and usable right now can be chosen.
   *
   * @param {string} kind  "identity" | "css"
   * @param {string} id
   * @returns {boolean}    true when the provider in force changed.
   * @throws {ProviderSelectError}
   */
  function select(kind, id) {
    if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) {
      throw new ProviderSelectError("bad-kind", `unknown provider kind "${kind}"`);
    }
    if (typeof id !== "string" || !PROVIDER_ID_RE.test(id)) {
      throw new ProviderSelectError("bad-id", "invalid provider id");
    }
    const before = current(kind);
    if (before.source === "settings") {
      throw new ProviderSelectError(
        "locked",
        `${kind} provider is set in settings.js (portalReact.${KINDS[kind].setting})`,
      );
    }
    const { provider, error } = lookup(KINDS[kind].type, tables[kind], id);
    if (!provider) throw new ProviderSelectError("unknown", error);
    const prev = chosen[kind];
    chosen[kind] = id;
    try {
      saveChoice();
    } catch (e) {
      if (prev === undefined) delete chosen[kind];
      else chosen[kind] = prev;
      throw e;
    }
    return before.id !== id;
  }

  /**
   * Who is behind this request. Never rejects: every failure is anonymous.
   *
   * @param {Object} req  HTTP request or WS upgrade request (Node IncomingMessage).
   * @returns {Promise<Object|null>}
   */
  async function resolveUser(req) {
    const id = identityId();
    const { provider, error } = lookup(IDENTITY_TYPE, builtins.identity, id);
    if (!provider) {
      logOnce(error + " — every session is anonymous");
      return null;
    }
    if (typeof provider.resolveUser !== "function") {
      logOnce(`${IDENTITY_TYPE} provider "${id}" has no resolveUser() — every session is anonymous`);
      return null;
    }
    let timer = null;
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => provider.resolveUser(req)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${identityTimeoutMs} ms`)),
            identityTimeoutMs,
          );
        }),
      ]);
      return sanitizeUser(raw);
    } catch (e) {
      RED.log.warn(`[portal-react] identity provider "${id}" failed: ${e.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Generate the stylesheet for a portal's source. Rejects on failure — the
   * caller owns the `css-fail` status.
   *
   * @param {string} source
   * @returns {Promise<{css: string}>}
   */
  async function generateCss(source) {
    const id = cssEngineId();
    const { provider, error } = lookup(CSS_TYPE, builtins.css, id);
    if (!provider) throw new Error(error);
    if (typeof provider.generate !== "function") {
      throw new Error(`${CSS_TYPE} provider "${id}" has no generate()`);
    }
    const out = await provider.generate(source);
    if (!out || typeof out.css !== "string") {
      throw new Error(`${CSS_TYPE} provider "${id}" returned no css string`);
    }
    return { css: out.css };
  }

  /**
   * Class names the editor offers inside `className="…"` for the engine in
   * force. Optional for plugins (`editor.classes()`); an engine without it,
   * an unusable engine, or one that fails yields an empty list — completion
   * just stays quiet, nothing else depends on it.
   *
   * @returns {Promise<{engine: string, classes: Array<string>}>}
   */
  async function editorClasses() {
    const engine = cssEngineId();
    const { provider } = lookup(CSS_TYPE, builtins.css, engine);
    const fn = provider && provider.editor && provider.editor.classes;
    if (typeof fn !== "function") return { engine, classes: [] };
    if (classCache.has(provider)) return { engine, classes: classCache.get(provider) };
    let raw;
    try {
      raw = await fn.call(provider.editor);
    } catch (e) {
      RED.log.warn(`[portal-react] css engine "${engine}" editor.classes() failed: ${e.message}`);
      return { engine, classes: [] };
    }
    const classes = [];
    if (Array.isArray(raw)) {
      const seen = new Set();
      for (const c of raw) {
        if (classes.length >= MAX_EDITOR_CLASSES) break;
        if (typeof c !== "string" || !c || c.length > MAX_EDITOR_CLASS_LEN || /\s/.test(c)) continue;
        if (seen.has(c)) continue;
        seen.add(c);
        classes.push(c);
      }
    } else {
      RED.log.warn(`[portal-react] css engine "${engine}" editor.classes() did not return an array`);
    }
    classCache.set(provider, classes);
    return { engine, classes };
  }

  return { resolveUser, generateCss, identityId, cssEngineId, describe, select, editorClasses };
}

module.exports = {
  createProviders,
  sanitizeUser,
  ProviderSelectError,
  PROVIDER_ID_RE,
  IDENTITY_TYPE,
  CSS_TYPE,
  API_VERSION,
  DEFAULT_IDENTITY,
  DEFAULT_CSS,
  MAX_USER_STRING,
  MAX_GROUPS,
  MAX_EDITOR_CLASSES,
};
