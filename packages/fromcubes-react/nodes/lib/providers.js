/** @module nodes/lib/providers */

/**
 * Pluggable providers for @aaqu/fromcubes-react.
 *
 * Two extension points, each a Node-RED plugin type:
 *
 *   RED.plugins.registerPlugin("my-sso", {
 *     type: "fromcubes-identity",
 *     apiVersion: 1,
 *     resolveUser(req) { return { userId, login, displayName, email, role, groups } | null },
 *   })
 *
 *   RED.plugins.registerPlugin("my-css", {
 *     type: "fromcubes-css",
 *     apiVersion: 1,
 *     generate(source) { return { css } },
 *     editor: {                                      // optional, all three
 *       classes() { return ["p-4", …] },             // names only
 *       completions() { return { classes: [{ name, modifiers, color }], variants } },
 *       describe(candidates) { return [{ hover, documentation, detail, color, rules } | null, …] },
 *       canonical(candidates) { return ["w-4" | null, …] },
 *     },
 *   })
 *
 * `completions`, `describe` and `canonical` are what Tailwind CSS
 * IntelliSense works from (modifiers, swatches, variants, CSS previews, colour squares in the
 * code, conflict and canonical-class diagnostics); an engine with only
 * `classes` still gets plain completion.
 *
 * The core builds in only `none` for each kind. Everything that does real
 * work — `headers` (@aaqu/fromcubes-auth-headers) and
 * `tailwind` (@aaqu/fromcubes-tailwind) — is a Node-RED plugin like any third-party one,
 * found through RED.plugins and held to the same apiVersion and validation.
 * Two plugins registering the same provider id of one type are ambiguous and
 * neither is used.
 *
 * Selection is explicit, exactly one provider per kind, first match wins:
 *   1. `RED.settings.portalReact.identityProvider` / `.cssEngine` (settings.js)
 *      — the administrator's word; the editor shows it locked.
 *   2. The choice made in the editor (Settings → Fromcubes), persisted in
 *      `<userDir>/fromcubes/providers.json`.
 *   3. The default: the official add-on when it is installed — `headers`
 *      from @aaqu/fromcubes-auth-headers, `tailwind` from
 *      @aaqu/fromcubes-tailwind — and `none` when it is not. The core works
 *      on its own; installing the add-on is what turns the feature on. Only
 *      the official package counts here: another package registering a
 *      plugin called `headers` never becomes the default identity provider
 *      (it can still be chosen explicitly, in 1 or 2).
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

const IDENTITY_TYPE = "fromcubes-identity";
const CSS_TYPE = "fromcubes-css";
const API_VERSION = 1;

const DEFAULT_IDENTITY = "headers";
const DEFAULT_CSS = "tailwind";
const NONE = "none";

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
const MAX_EDITOR_MODIFIERS = 1000;
const MAX_EDITOR_VARIANTS = 1000;
const MAX_EDITOR_DETAIL_LEN = 2000;
// One describe request: what a completion's detail pane, a hover or a
// modifier list needs at once, for candidates that may carry an arbitrary
// value — `w-[calc(100%-2rem)]` is longer than any listed class.
const MAX_DESCRIBE = 64;
const MAX_DESCRIBE_LEN = 1000;
const MAX_DESCRIBE_TEXT = 100000;
// Conflict-check entries per class: Tailwind's largest (shadows, with their
// @property registrations) hold about twenty.
const MAX_DESCRIBE_RULES = 200;
// Swatch colours: the forms Monaco draws (hex, rgb()/rgba() with commas)
// and the two keywords IntelliSense marks as colours without one.
const EDITOR_COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]{1,60}\)|transparent|currentColor)$/;

const USER_STRING_FIELDS = ["login", "displayName", "email", "role"];

const KINDS = {
  identity: {
    type: IDENTITY_TYPE,
    setting: "identityProvider",
    fallback: DEFAULT_IDENTITY,
    fallbackModule: "@aaqu/fromcubes-auth-headers",
  },
  css: {
    type: CSS_TYPE,
    setting: "cssEngine",
    fallback: DEFAULT_CSS,
    fallbackModule: "@aaqu/fromcubes-tailwind",
  },
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
 * @param {*} c
 * @param {number} max
 * @returns {boolean}  a non-empty string without whitespace, at most `max` long
 */
function isToken(c, max) {
  return typeof c === "string" && c.length > 0 && c.length <= max && !/\s/.test(c);
}

/**
 * @param {*} v
 * @param {number} max
 * @returns {string|null}
 */
function boundedOrNull(v, max) {
  return typeof v === "string" && v.length <= max ? v : null;
}

/**
 * @param {*} c
 * @returns {string|null}
 */
function editorColor(c) {
  return typeof c === "string" && EDITOR_COLOR_RE.test(c) ? c : null;
}

/**
 * Validate a CSS engine's `editor.completions()` (or plain `classes()`)
 * answer into what the editor is sent. Modifier lists are shared — Tailwind
 * gives ~15 000 classes the same 21 opacity steps — so each distinct list
 * travels once and classes point at it by index, as colours do by position.
 *
 * @param {*} rawClasses  Array of names, or of `{name, modifiers?, color?}`.
 * @param {*} [rawVariants]
 * @returns {{classes: Array<string>, colors: Array<string>, modifiers: Array<Array<string>>, classModifiers: Array<number>, variants: Array<Object>}}
 */
function normalizeCompletions(rawClasses, rawVariants) {
  const classes = [];
  const colors = [];
  const modifiers = [];
  const classModifiers = [];
  const modifierIndex = new Map();
  const seen = new Set();
  for (const entry of Array.isArray(rawClasses) ? rawClasses : []) {
    if (classes.length >= MAX_EDITOR_CLASSES) break;
    const isObject = entry !== null && typeof entry === "object";
    const name = isObject ? entry.name : entry;
    if (!isToken(name, MAX_EDITOR_CLASS_LEN) || seen.has(name)) continue;
    seen.add(name);
    classes.push(name);
    colors.push((isObject && editorColor(entry.color)) || "");
    let mods = isObject && Array.isArray(entry.modifiers) ? entry.modifiers : [];
    mods = mods.length <= MAX_EDITOR_MODIFIERS ? mods.filter((m) => isToken(m, MAX_EDITOR_CLASS_LEN)) : [];
    if (mods.length === 0) {
      classModifiers.push(-1);
      continue;
    }
    const key = mods.join("\n");
    let idx = modifierIndex.get(key);
    if (idx === undefined) {
      idx = modifiers.length;
      modifiers.push(mods);
      modifierIndex.set(key, idx);
    }
    classModifiers.push(idx);
  }

  const variants = [];
  for (const v of Array.isArray(rawVariants) ? rawVariants : []) {
    if (variants.length >= MAX_EDITOR_VARIANTS) break;
    if (!v || typeof v !== "object" || !isToken(v.name, MAX_EDITOR_CLASS_LEN)) continue;
    const values = Array.isArray(v.values) && v.values.length <= MAX_EDITOR_MODIFIERS ? v.values : [];
    const valueDetails = Array.isArray(v.valueDetails) ? v.valueDetails : [];
    const kept = [];
    const details = [];
    values.forEach((value, i) => {
      if (!isToken(value, MAX_EDITOR_CLASS_LEN)) return;
      kept.push(value);
      details.push(boundedOrNull(valueDetails[i], MAX_EDITOR_DETAIL_LEN));
    });
    variants.push({
      name: v.name,
      values: kept,
      hasDash: v.hasDash !== false,
      isArbitrary: v.isArbitrary === true,
      detail: boundedOrNull(v.detail, MAX_EDITOR_DETAIL_LEN),
      valueDetails: details,
      failed: v.failed === true,
    });
  }

  return { classes, colors, modifiers, classModifiers, variants };
}

/**
 * @param {*} list
 * @param {number} maxItems
 * @param {number} maxLen
 * @returns {Array<string>|null}  the list when it is short strings only
 */
function boundedStrings(list, maxItems, maxLen) {
  if (!Array.isArray(list) || list.length > maxItems) return null;
  return list.every((v) => typeof v === "string" && v.length <= maxLen) ? list.slice() : null;
}

/**
 * Validate one entry of a CSS engine's `editor.describe()` answer. `rules`
 * (what the CSS-conflict diagnostic compares) is optional for an engine.
 *
 * @param {*} d
 * @returns {{hover: string|null, documentation: string|null, detail: string|null, color: string|null, rules: Array<{properties: Array<string>, context: Array<string>}>}|null}
 */
function sanitizeDescription(d) {
  if (!d || typeof d !== "object") return null;
  const rules = [];
  if (Array.isArray(d.rules) && d.rules.length <= MAX_DESCRIBE_RULES) {
    for (const r of d.rules) {
      const properties = r && boundedStrings(r.properties, MAX_DESCRIBE_RULES, MAX_EDITOR_CLASS_LEN);
      const context = r && boundedStrings(r.context, MAX_DESCRIBE_RULES, MAX_EDITOR_DETAIL_LEN);
      if (properties && context) rules.push({ properties, context });
    }
  }
  return {
    hover: boundedOrNull(d.hover, MAX_DESCRIBE_TEXT),
    documentation: boundedOrNull(d.documentation, MAX_DESCRIBE_TEXT),
    detail: boundedOrNull(d.detail, MAX_DESCRIBE_TEXT),
    color: editorColor(d.color),
    rules,
  };
}

/**
 * The only providers built into the core: one per kind that does nothing, so
 * "no identity" and "no stylesheet" are always choosable. Their ids are
 * reserved.
 *
 * @returns {{ identity: Object<string,Object>, css: Object<string,Object> }}
 */
function builtinProviders() {
  return {
    identity: {
      none: {
        id: "none",
        type: IDENTITY_TYPE,
        apiVersion: API_VERSION,
        label: "Nobody is identified — every session is anonymous",
        resolveUser: () => null,
      },
    },
    css: {
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
 *   editorClasses: function(): Promise<Object>,
 *   describeClasses: function(Array<string>): Promise<{engine: string, results: Array<Object|null>}>,
 *   canonicalClasses: function(Array<string>): Promise<{engine: string, results: Array<string|null>}>,
 * }}
 */
function createProviders(RED, opts = {}) {
  const fs = require("fs");
  const path = require("path");
  const builtins = builtinProviders();
  const tables = { identity: builtins.identity, css: builtins.css };
  const identityTimeoutMs = opts.identityTimeoutMs ?? IDENTITY_TIMEOUT_MS;
  const storeFile = opts.storeFile || null;
  const logged = new Set();
  /** @type {{identity?: string, css?: string}} */
  const chosen = loadChoice();
  // provider object → its validated completion data. Keyed by the object, not
  // the id, so a plugin reinstalled at runtime (a new definition) is asked again.
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
    const official = pluginsOf(k.type).some(
      (p) => p.id === k.fallback && p.module === k.fallbackModule,
    );
    return { id: official ? k.fallback : NONE, source: "default", addonMissing: !official };
  }

  /**
   * Log once, at info level, why a kind runs on `none` by default — so a
   * core installed on its own explains itself instead of failing quietly.
   * @param {string} kind
   * @param {string} msg
   * @returns {void}
   */
  function explainNone(kind, msg) {
    const key = "none:" + kind;
    if (logged.has(key)) return;
    logged.add(key);
    if (RED.log.info) RED.log.info("[portal-react] " + msg);
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
   * reserved), then plugins registered with Node-RED. An id registered by
   * more than one plugin is refused rather than resolved by load order — for
   * identity, "whichever package loaded first" must never decide who is
   * logged in.
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
    const matches = plugins.filter((p) => p && p.id === id);
    if (matches.length === 0) {
      return { provider: null, error: `${type} provider "${id}" is not registered` };
    }
    if (matches.length > 1) {
      const mods = matches.map((p) => p.module || "?").join(", ");
      return {
        provider: null,
        error: `${type} provider "${id}" is registered by more than one package (${mods})`,
      };
    }
    const found = matches[0];
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
      const plugins = pluginsOf(k.type);
      const count = {};
      for (const p of plugins) count[p.id] = (count[p.id] || 0) + 1;
      for (const p of plugins) {
        if (typeof p.id !== "string" || seen.has(p.id)) continue;
        seen.add(p.id);
        const opt = {
          id: p.id,
          label: typeof p.label === "string" ? p.label : "",
          module: typeof p.module === "string" ? p.module : "",
          builtin: false,
        };
        if (count[p.id] > 1) {
          opt.problem = "registered by more than one package — neither is used";
        } else if (p.apiVersion !== API_VERSION) {
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
    const cur = current("identity");
    const id = cur.id;
    // Called only for portals with Portal Auth on — so this is someone who
    // expects users and gets none.
    if (cur.addonMissing) {
      explainNone("identity", "Portal Auth is on but no identity provider is installed, so every " +
        "session is anonymous. For users from x-portal-user-* headers install " +
        "@aaqu/fromcubes-auth-headers, or choose a provider in Settings → Fromcubes.");
    }
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
    const cur = current("css");
    const id = cur.id;
    if (cur.addonMissing) {
      explainNone("css", "No CSS engine is installed, so portals are served without a stylesheet. " +
        "For Tailwind CSS install @aaqu/fromcubes-tailwind.");
    }
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
   * What the editor completes inside `className="…"` for the engine in
   * force: class names in the engine's order, with per class a swatch
   * colour (`colors[i]`, "" for none) and modifier list (`modifiers[
   * classModifiers[i]]`, -1 for none), plus the variants. Taken from the
   * plugin's `editor.completions()`, or `editor.classes()` for names alone.
   * Both are optional; an engine without them, an unusable engine, or one
   * that fails yields an empty list — completion just stays quiet, nothing
   * else depends on it. `describe` / `canonical` say whether
   * `describeClasses` / `canonicalClasses` have anything to ask the engine.
   *
   * @returns {Promise<{engine: string, classes: Array<string>, colors: Array<string>, modifiers: Array<Array<string>>, classModifiers: Array<number>, variants: Array<Object>, describe: boolean, canonical: boolean}>}
   */
  async function editorClasses() {
    const engine = cssEngineId();
    const { provider } = lookup(CSS_TYPE, builtins.css, engine);
    const editor = (provider && provider.editor) || {};
    const describe = typeof editor.describe === "function";
    const canonical = typeof editor.canonical === "function";
    const empty = () => ({ engine, ...normalizeCompletions([]), describe, canonical });
    const fn = typeof editor.completions === "function" ? "completions" : "classes";
    if (typeof editor[fn] !== "function") return empty();
    if (classCache.has(provider)) return { engine, ...classCache.get(provider), describe, canonical };
    let raw;
    try {
      raw = await editor[fn]();
    } catch (e) {
      RED.log.warn(`[portal-react] css engine "${engine}" editor.${fn}() failed: ${e.message}`);
      return empty();
    }
    const rawClasses = fn === "completions" ? raw && raw.classes : raw;
    if (!Array.isArray(rawClasses)) {
      RED.log.warn(`[portal-react] css engine "${engine}" editor.${fn}() did not return ${fn === "completions" ? "a classes array" : "an array"}`);
    }
    const data = normalizeCompletions(rawClasses, fn === "completions" && raw ? raw.variants : []);
    classCache.set(provider, data);
    return { engine, ...data, describe, canonical };
  }

  /**
   * What the editor shows for classes it has in hand — a completion's
   * detail pane, a hover, a modifier's swatch, a colour square, a
   * diagnostic — from the engine's `editor.describe()`: per candidate
   * `{hover, documentation, detail, color, rules}`, or `null`
   * when the engine generates nothing for it (which is
   * also how the editor asks whether `group-hover/x` is a variant). Never
   * rejects for an engine problem: no describe, or a failing one, answers
   * `null` throughout.
   *
   * @param {*} candidates  At most 64 class candidates.
   * @returns {Promise<{engine: string, results: Array<Object|null>}>}
   * @throws {TypeError} for a malformed list — a caller's error, not the engine's.
   */
  async function describeClasses(candidates) {
    checkCandidates(candidates);
    const engine = cssEngineId();
    const { provider } = lookup(CSS_TYPE, builtins.css, engine);
    const fn = provider && provider.editor && provider.editor.describe;
    const nothing = { engine, results: candidates.map(() => null) };
    if (typeof fn !== "function") return nothing;
    let raw;
    try {
      raw = await fn.call(provider.editor, candidates.slice());
    } catch (e) {
      RED.log.warn(`[portal-react] css engine "${engine}" editor.describe() failed: ${e.message}`);
      return nothing;
    }
    if (!Array.isArray(raw)) return nothing;
    return { engine, results: candidates.map((_, i) => sanitizeDescription(raw[i])) };
  }

  /**
   * The canonical spelling the engine suggests per class (`w-[16px]` →
   * `w-4`), or `null` — for the canonical-class diagnostic only. Kept apart
   * from `describeClasses` because an engine may take its time here (the
   * Tailwind add-on asks a worker thread whose first answer waits for an
   * index) and a hover must never wait for that. Never rejects for an
   * engine problem.
   *
   * @param {*} candidates  At most 64 class candidates.
   * @returns {Promise<{engine: string, results: Array<string|null>}>}
   * @throws {TypeError} for a malformed list.
   */
  async function canonicalClasses(candidates) {
    checkCandidates(candidates);
    const engine = cssEngineId();
    const { provider } = lookup(CSS_TYPE, builtins.css, engine);
    const fn = provider && provider.editor && provider.editor.canonical;
    const nothing = { engine, results: candidates.map(() => null) };
    if (typeof fn !== "function") return nothing;
    let raw;
    try {
      raw = await fn.call(provider.editor, candidates.slice());
    } catch (e) {
      RED.log.warn(`[portal-react] css engine "${engine}" editor.canonical() failed: ${e.message}`);
      return nothing;
    }
    if (!Array.isArray(raw)) return nothing;
    return {
      engine,
      results: candidates.map((c, i) => (isToken(raw[i], MAX_DESCRIBE_LEN) && raw[i] !== c ? raw[i] : null)),
    };
  }

  /**
   * @param {*} candidates
   * @returns {void}
   * @throws {TypeError} unless 1–64 class candidates
   */
  function checkCandidates(candidates) {
    if (
      !Array.isArray(candidates) ||
      candidates.length === 0 ||
      candidates.length > MAX_DESCRIBE ||
      !candidates.every((c) => isToken(c, MAX_DESCRIBE_LEN))
    ) {
      throw new TypeError(`expected 1-${MAX_DESCRIBE} class candidates`);
    }
  }

  return { resolveUser, generateCss, identityId, cssEngineId, describe, select, editorClasses, describeClasses, canonicalClasses };
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
  MAX_DESCRIBE,
  normalizeCompletions,
};
