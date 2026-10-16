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
 *   })
 *
 * The built-in providers (`headers`, `tailwind`, `none`) are defined with the
 * same shape and pass through the same validation, so the API is exercised by
 * our own code on every request and every build.
 *
 * Selection is explicit: `RED.settings.portalReact.identityProvider` and
 * `RED.settings.portalReact.cssEngine` name a provider by id, defaulting to
 * `headers` and `tailwind`. Installing a plugin never switches anything on its
 * own — for identity that would let a package change who counts as logged in.
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

const USER_STRING_FIELDS = ["login", "displayName", "email", "role"];

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
 * @param {{ extractPortalUser: Function, generateCSS: Function }} helpers
 * @returns {{ identity: Object<string,Object>, css: Object<string,Object> }}
 */
function builtinProviders(helpers) {
  return {
    identity: {
      headers: {
        id: "headers",
        type: IDENTITY_TYPE,
        apiVersion: API_VERSION,
        resolveUser: (req) => helpers.extractPortalUser(req.headers || {}),
      },
    },
    css: {
      tailwind: {
        id: "tailwind",
        type: CSS_TYPE,
        apiVersion: API_VERSION,
        generate: async (source) => {
          const { css } = await helpers.generateCSS(source);
          return { css };
        },
      },
      none: {
        id: "none",
        type: CSS_TYPE,
        apiVersion: API_VERSION,
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
 * @param {{ identityTimeoutMs?: number }} [opts]
 * @returns {{
 *   resolveUser: function(Object): Promise<Object|null>,
 *   generateCss: function(string): Promise<{css: string}>,
 *   identityId: function(): string,
 *   cssEngineId: function(): string,
 * }}
 */
function createProviders(RED, helpers, opts = {}) {
  const builtins = builtinProviders(helpers);
  const identityTimeoutMs = opts.identityTimeoutMs ?? IDENTITY_TIMEOUT_MS;
  const logged = new Set();

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
   * Find the provider `id` of `type`: built-ins first (their ids are
   * reserved), then plugins registered with Node-RED.
   *
   * @param {string} type
   * @param {Object<string,Object>} table
   * @param {string} id
   * @returns {{ provider: Object|null, error: string|null }}
   */
  function lookup(type, table, id) {
    let plugins = [];
    try {
      plugins = (RED.plugins && RED.plugins.getByType(type)) || [];
    } catch (_) {
      plugins = [];
    }
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
    const id = cfg().identityProvider;
    return typeof id === "string" && id ? id : DEFAULT_IDENTITY;
  }

  /** @returns {string} */
  function cssEngineId() {
    const id = cfg().cssEngine;
    return typeof id === "string" && id ? id : DEFAULT_CSS;
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

  return { resolveUser, generateCss, identityId, cssEngineId };
}

module.exports = {
  createProviders,
  sanitizeUser,
  IDENTITY_TYPE,
  CSS_TYPE,
  API_VERSION,
  DEFAULT_IDENTITY,
  DEFAULT_CSS,
  MAX_USER_STRING,
  MAX_GROUPS,
};
