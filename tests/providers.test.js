/**
 * Provider registry (lib/providers.js): identity providers and CSS engines.
 *
 * The core builds in only `none`; `headers` and `tailwind` are add-on packages
 * (@aaqu/fromcubes-auth-headers, @aaqu/fromcubes-tailwind) found through
 * RED.plugins like any third-party one. By default the fake
 * RED below has both add-ons installed, as the package ships them, so these
 * tests pin down the plugin contract AND that nothing changes for existing
 * flows. `addons: false` is a core installed without them.
 */

const {
  createProviders,
  sanitizeUser,
  IDENTITY_TYPE,
  CSS_TYPE,
  API_VERSION,
  MAX_USER_STRING,
  MAX_GROUPS,
} = require("../packages/fromcubes-react/nodes/lib/providers");
const { extractPortalUser } = require("../packages/fromcubes-auth-headers/headers");

// The add-ons as Node-RED registers them: registerPlugin(id, def) adds id
// and module to the definition.
const HEADERS_PKG = "@aaqu/fromcubes-auth-headers";
const TAILWIND_PKG = "@aaqu/fromcubes-tailwind";
const ADDONS = [
  { ...require("../packages/fromcubes-auth-headers/auth-headers").provider, id: "headers", module: HEADERS_PKG },
  { ...require("../packages/fromcubes-tailwind/tailwind").provider, id: "tailwind", module: TAILWIND_PKG },
];

function fakeRED({ plugins = [], settings = {}, addons = true } = {}) {
  const logs = { error: [], warn: [] };
  return {
    settings: { portalReact: settings },
    plugins: {
      // Read `plugins` on every call so tests can install/uninstall live.
      getByType: (type) => [...(addons ? ADDONS : []), ...plugins].filter((p) => p.type === type),
    },
    log: {
      error: (m) => logs.error.push(m),
      warn: (m) => logs.warn.push(m),
    },
    _logs: logs,
  };
}

function make(opts, providerOpts) {
  const RED = fakeRED(opts);
  return { RED, p: createProviders(RED, providerOpts) };
}

const identityPlugin = (id, resolveUser, extra = {}) => ({
  id,
  type: IDENTITY_TYPE,
  apiVersion: API_VERSION,
  resolveUser,
  ...extra,
});

const cssPlugin = (id, generate, extra = {}) => ({
  id,
  type: CSS_TYPE,
  apiVersion: API_VERSION,
  generate,
  ...extra,
});

const req = (headers = {}) => ({ headers });

// ── Defaults: nothing configured = behaviour of the previous release ──

describe("defaults", () => {
  it("uses the header provider and tailwind", () => {
    const { p } = make();
    expect(p.identityId()).toBe("headers");
    expect(p.cssEngineId()).toBe("tailwind");
  });

  it("falls back to defaults when RED.settings.portalReact is absent", async () => {
    const RED = fakeRED();
    delete RED.settings.portalReact;
    const p = createProviders(RED);
    expect(p.identityId()).toBe("headers");
    expect(await p.resolveUser(req({ "x-portal-user-id": "u1" }))).toEqual({
      userId: "u1",
      groups: [],
    });
  });

  it("ignores non-string setting values", () => {
    const { p } = make({ settings: { identityProvider: 42, cssEngine: "" } });
    expect(p.identityId()).toBe("headers");
    expect(p.cssEngineId()).toBe("tailwind");
  });

  it("headers add-on returns exactly what extractPortalUser returns", async () => {
    const { p } = make();
    const cases = [
      {},
      { "x-portal-user-id": "u1" },
      {
        "x-portal-user-id": "u1",
        "x-portal-user-login": "jan",
        "x-portal-user-display-name": "%C5%81ukasz",
        "x-portal-user-email": "jan%40example.com",
        "x-portal-user-role": "editor",
        "x-portal-user-groups": "ops, dev,%2C",
      },
      { "x-portal-user-login": "jan" },
      { "x-portal-user-id": "%E0%A4%A" },
      // ~4096 one-char groups: the most the 8 KB header can carry must
      // survive the provider bounds untouched.
      { "x-portal-user-id": "u1", "x-portal-user-groups": Array(4096).fill("a").join(",") },
    ];
    for (const headers of cases) {
      expect(await p.resolveUser(req(headers))).toEqual(extractPortalUser(headers));
    }
  });

  it("tailwind add-on builds the utilities used in the source", async () => {
    const { p } = make();
    const { css } = await p.generateCss('<div className="p-4">');
    expect(css).toMatch(/\.p-4\s*\{/);
  });

  it("core alone: both default to none, quietly, with one hint each", async () => {
    const { p, RED } = make({ addons: false });
    RED.log.info = vi.fn();
    expect(p.identityId()).toBe("none");
    expect(p.cssEngineId()).toBe("none");
    expect(await p.resolveUser(req({ "x-portal-user-id": "u1" }))).toBeNull();
    expect(await p.resolveUser(req({ "x-portal-user-id": "u1" }))).toBeNull();
    expect(await p.generateCss("p-4")).toEqual({ css: "" });
    // Nothing is broken, so nothing is an error…
    expect(RED._logs.error).toEqual([]);
    expect(RED._logs.warn).toEqual([]);
    // …but each kind says once what to install.
    const hints = RED.log.info.mock.calls.map(([m]) => m);
    expect(hints).toHaveLength(2);
    expect(hints.join("\n")).toMatch(/@aaqu\/fromcubes-auth-headers/);
    expect(hints.join("\n")).toMatch(/@aaqu\/fromcubes-tailwind/);
    const d = p.describe();
    expect(d.identity).toMatchObject({ selected: "none", source: "default", missing: false });
    expect(d.css).toMatchObject({ selected: "none", source: "default", missing: false });
  });

  it("installing the official add-on later turns it on", async () => {
    const plugins = [];
    const { p } = make({ addons: false, plugins });
    expect(p.cssEngineId()).toBe("none");
    plugins.push(ADDONS[1]);
    expect(p.cssEngineId()).toBe("tailwind");
  });

  it("only the official package is a default — a look-alike is not", async () => {
    const lookalike = identityPlugin("headers", () => ({ userId: "admin" }), { module: "evil-pkg" });
    const { p } = make({ addons: false, plugins: [lookalike] });
    expect(p.identityId()).toBe("none");
    expect(await p.resolveUser(req())).toBeNull();
    // Chosen explicitly it is used, like any third-party provider.
    expect(p.select("identity", "headers")).toBe(true);
    expect(await p.resolveUser(req())).toEqual({ userId: "admin", groups: [] });
  });

  it("built-in none engine emits empty css", async () => {
    const { p } = make({ settings: { cssEngine: "none" } });
    expect(await p.generateCss("p-4")).toEqual({ css: "" });
  });
});

// ── Selection ──

describe("selection", () => {
  it("installing a plugin does not switch to it", async () => {
    const evil = identityPlugin("evil", () => ({ userId: "admin" }));
    const { p } = make({ plugins: [evil] });
    expect(p.identityId()).toBe("headers");
    expect(await p.resolveUser(req())).toBeNull();
  });

  it("uses the identity plugin named in settings", async () => {
    const sso = identityPlugin("sso", (r) => ({
      userId: r.headers["x-sso-sub"],
      login: "jan",
    }));
    const { p } = make({ plugins: [sso], settings: { identityProvider: "sso" } });
    expect(await p.resolveUser(req({ "x-sso-sub": "s1" }))).toEqual({
      userId: "s1",
      login: "jan",
      groups: [],
    });
  });

  it("selected plugin replaces the header provider entirely", async () => {
    const sso = identityPlugin("sso", () => null);
    const { p } = make({ plugins: [sso], settings: { identityProvider: "sso" } });
    expect(await p.resolveUser(req({ "x-portal-user-id": "u1" }))).toBeNull();
  });

  it("uses the css plugin named in settings", async () => {
    const uno = cssPlugin("uno", (src) => ({ css: "uno:" + src.length }));
    const { p } = make({ plugins: [uno], settings: { cssEngine: "uno" } });
    expect(await p.generateCss("abc")).toEqual({ css: "uno:3" });
  });

  it("does not pick a plugin of the other type with the same id", async () => {
    const wrong = cssPlugin("sso", () => ({ css: "" }));
    const { p } = make({ plugins: [wrong], settings: { identityProvider: "sso" } });
    expect(await p.resolveUser(req({ "x-portal-user-id": "u1" }))).toBeNull();
  });

  it("re-reads plugins on each call (plugin installed at runtime)", async () => {
    const plugins = [];
    const { p } = make({ plugins, settings: { identityProvider: "late" } });
    expect(await p.resolveUser(req())).toBeNull();
    plugins.push(identityPlugin("late", () => ({ userId: "u9" })));
    expect(await p.resolveUser(req())).toEqual({ userId: "u9", groups: [] });
  });

  it("built-in ids are reserved: a plugin cannot shadow `none`", async () => {
    const shadow = identityPlugin("none", () => ({ userId: "admin" }));
    const { p, RED } = make({ plugins: [shadow], settings: { identityProvider: "none" } });
    expect(await p.resolveUser(req())).toBeNull();
    expect(RED._logs.error.join("\n")).toMatch(/"none" ignored: id is reserved/);
  });

  it("an id registered by two packages is used by neither (fail closed)", async () => {
    const second = identityPlugin("headers", () => ({ userId: "admin" }), { module: "evil-pkg" });
    const { p, RED } = make({ plugins: [second] });
    expect(await p.resolveUser(req({ "x-portal-user-id": "u1" }))).toBeNull();
    expect(RED._logs.error[0]).toMatch(
      /"headers" is registered by more than one package \(@aaqu\/fromcubes-auth-headers, evil-pkg\)/,
    );
    expect(() => p.select("identity", "headers")).toThrow(/more than one package/);
  });

  it("survives RED.plugins being absent or throwing", async () => {
    const RED = fakeRED({ settings: { identityProvider: "sso" } });
    RED.plugins = { getByType: () => { throw new Error("boom"); } };
    const p = createProviders(RED);
    expect(await p.resolveUser(req())).toBeNull();
    delete RED.plugins;
    expect(await p.resolveUser(req())).toBeNull();
  });
});

// ── Identity failures: always anonymous, never a rejection ──

describe("identity failure is anonymous", () => {
  it("unknown provider ⇒ null, logged once", async () => {
    const { p, RED } = make({ settings: { identityProvider: "nope" } });
    expect(await p.resolveUser(req({ "x-portal-user-id": "u1" }))).toBeNull();
    expect(await p.resolveUser(req({ "x-portal-user-id": "u1" }))).toBeNull();
    expect(RED._logs.error).toHaveLength(1);
    expect(RED._logs.error[0]).toMatch(/"nope" is not registered.*anonymous/);
  });

  it("wrong apiVersion ⇒ null with the reason logged", async () => {
    for (const apiVersion of [undefined, 2, "1"]) {
      const sso = identityPlugin("sso", () => ({ userId: "u1" }), { apiVersion });
      const { p, RED } = make({ plugins: [sso], settings: { identityProvider: "sso" } });
      expect(await p.resolveUser(req())).toBeNull();
      expect(RED._logs.error[0]).toMatch(/apiVersion .* expected 1/);
    }
  });

  it("missing resolveUser ⇒ null", async () => {
    const sso = identityPlugin("sso", undefined);
    const { p, RED } = make({ plugins: [sso], settings: { identityProvider: "sso" } });
    expect(await p.resolveUser(req())).toBeNull();
    expect(RED._logs.error[0]).toMatch(/no resolveUser/);
  });

  it("sync throw ⇒ null + warn", async () => {
    const sso = identityPlugin("sso", () => { throw new Error("bad token"); });
    const { p, RED } = make({ plugins: [sso], settings: { identityProvider: "sso" } });
    expect(await p.resolveUser(req())).toBeNull();
    expect(RED._logs.warn[0]).toMatch(/"sso" failed: bad token/);
  });

  it("async rejection ⇒ null", async () => {
    const sso = identityPlugin("sso", async () => { throw new Error("jwks down"); });
    const { p } = make({ plugins: [sso], settings: { identityProvider: "sso" } });
    expect(await p.resolveUser(req())).toBeNull();
  });

  it("async provider is awaited", async () => {
    const sso = identityPlugin("sso", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { userId: "u1", role: "admin" };
    });
    const { p } = make({ plugins: [sso], settings: { identityProvider: "sso" } });
    expect(await p.resolveUser(req())).toEqual({ userId: "u1", role: "admin", groups: [] });
  });

  it("provider that never answers ⇒ null after the timeout", async () => {
    const sso = identityPlugin("sso", () => new Promise(() => {}));
    const { p, RED } = make(
      { plugins: [sso], settings: { identityProvider: "sso" } },
      { identityTimeoutMs: 20 },
    );
    expect(await p.resolveUser(req())).toBeNull();
    expect(RED._logs.warn[0]).toMatch(/timed out after 20 ms/);
  });
});

// ── sanitizeUser: the trust boundary for third-party output ──

describe("sanitizeUser", () => {
  it("non-objects and missing userId are anonymous", () => {
    for (const v of [null, undefined, 0, "u1", true, [], ["u1"], {}, { userId: "" }, { userId: 7 }]) {
      expect(sanitizeUser(v)).toBeNull();
    }
  });

  it("copies only known fields", () => {
    const user = sanitizeUser({
      userId: "u1",
      login: "jan",
      displayName: "Jan",
      email: "j@x",
      role: "r",
      groups: ["a"],
      isAdmin: true,
      portalClient: "spoofed",
      authenticated: false,
    });
    expect(user).toEqual({
      userId: "u1",
      login: "jan",
      displayName: "Jan",
      email: "j@x",
      role: "r",
      groups: ["a"],
    });
  });

  it("never returns the provider's object", () => {
    const raw = { userId: "u1", groups: ["a"] };
    const user = sanitizeUser(raw);
    expect(user).not.toBe(raw);
    expect(user.groups).not.toBe(raw.groups);
  });

  it("does not carry prototype keys or a foreign prototype", () => {
    const raw = JSON.parse('{"userId":"u1","__proto__":{"polluted":true},"constructor":{"x":1}}');
    const user = sanitizeUser(raw);
    expect(Object.getPrototypeOf(user)).toBe(Object.prototype);
    expect(Object.keys(user)).toEqual(["userId", "groups"]);
    expect({}.polluted).toBeUndefined();

    const proto = { login: "inherited" };
    const child = Object.create(proto);
    child.userId = "u1";
    // Inherited fields are read like own ones — but only known names, and
    // only as copied strings.
    expect(sanitizeUser(child)).toEqual({ userId: "u1", login: "inherited", groups: [] });
  });

  it("drops non-string and empty fields", () => {
    expect(
      sanitizeUser({ userId: "u1", login: 5, email: "", role: { x: 1 }, displayName: ["a"] }),
    ).toEqual({ userId: "u1", groups: [] });
  });

  it("drops oversized strings instead of cutting them", () => {
    const big = "x".repeat(MAX_USER_STRING + 1);
    expect(sanitizeUser({ userId: big })).toBeNull();
    expect(sanitizeUser({ userId: "u1", login: big })).toEqual({ userId: "u1", groups: [] });
    expect(sanitizeUser({ userId: "x".repeat(MAX_USER_STRING) }).userId).toHaveLength(
      MAX_USER_STRING,
    );
  });

  it("groups: always an array, bad elements dropped, oversized list dropped whole", () => {
    expect(sanitizeUser({ userId: "u1" }).groups).toEqual([]);
    expect(sanitizeUser({ userId: "u1", groups: "ops,dev" }).groups).toEqual([]);
    expect(sanitizeUser({ userId: "u1", groups: ["ops", 1, "", null, "dev"] }).groups).toEqual([
      "ops",
      "dev",
    ]);
    expect(sanitizeUser({ userId: "u1", groups: Array(MAX_GROUPS).fill("g") }).groups).toHaveLength(
      MAX_GROUPS,
    );
    expect(sanitizeUser({ userId: "u1", groups: Array(MAX_GROUPS + 1).fill("g") }).groups).toEqual(
      [],
    );
  });

  it("is applied to plugin output", async () => {
    const sso = identityPlugin("sso", () => ({ userId: "u1", isAdmin: true, groups: "x" }));
    const { p } = make({ plugins: [sso], settings: { identityProvider: "sso" } });
    expect(await p.resolveUser(req())).toEqual({ userId: "u1", groups: [] });
  });
});

// ── CSS engine failures: reject, caller shows css-fail ──

describe("css engine failure rejects", () => {
  it("unknown engine", async () => {
    const { p } = make({ settings: { cssEngine: "uno" } });
    await expect(p.generateCss("x")).rejects.toThrow(/"uno" is not registered/);
  });

  it("wrong apiVersion", async () => {
    const uno = cssPlugin("uno", () => ({ css: "" }), { apiVersion: 0 });
    const { p } = make({ plugins: [uno], settings: { cssEngine: "uno" } });
    await expect(p.generateCss("x")).rejects.toThrow(/apiVersion 0, expected 1/);
  });

  it("missing generate", async () => {
    const uno = cssPlugin("uno", undefined);
    const { p } = make({ plugins: [uno], settings: { cssEngine: "uno" } });
    await expect(p.generateCss("x")).rejects.toThrow(/no generate/);
  });

  it("non-string css", async () => {
    for (const out of [undefined, null, {}, { css: 1 }, "body{}"]) {
      const uno = cssPlugin("uno", () => out);
      const { p } = make({ plugins: [uno], settings: { cssEngine: "uno" } });
      await expect(p.generateCss("x")).rejects.toThrow(/no css string/);
    }
  });

  it("engine error propagates", async () => {
    const uno = cssPlugin("uno", async () => { throw new Error("parse fail"); });
    const { p } = make({ plugins: [uno], settings: { cssEngine: "uno" } });
    await expect(p.generateCss("x")).rejects.toThrow("parse fail");
  });

  it("returns only the css field", async () => {
    const uno = cssPlugin("uno", () => ({ css: "a{}", cssHash: "evil", extra: 1 }));
    const { p } = make({ plugins: [uno], settings: { cssEngine: "uno" } });
    expect(await p.generateCss("x")).toEqual({ css: "a{}" });
  });
});

// ── Choice: settings.js > editor (providers.json) > default ──

const fs = require("fs");
const os = require("os");
const path = require("path");
const { ProviderSelectError } = require("../packages/fromcubes-react/nodes/lib/providers");

describe("choice made in the editor", () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-test-"));
    file = path.join(dir, "fromcubes", "providers.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const withStore = (opts) => {
    const RED = fakeRED(opts);
    return { RED, p: createProviders(RED, { storeFile: file }) };
  };

  it("select() switches, persists, and survives a restart", async () => {
    const sso = identityPlugin("sso", () => ({ userId: "s1" }));
    const { p } = withStore({ plugins: [sso] });
    expect(p.select("identity", "sso")).toBe(true);
    expect(p.identityId()).toBe("sso");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ identity: "sso" });

    const { p: again } = withStore({ plugins: [sso] });
    expect(again.identityId()).toBe("sso");
    expect(await again.resolveUser(req())).toEqual({ userId: "s1", groups: [] });
  });

  it("select() of the provider already in force reports no change", () => {
    const { p } = withStore();
    expect(p.select("css", "tailwind")).toBe(false);
    expect(p.select("css", "none")).toBe(true);
    expect(p.select("css", "none")).toBe(false);
  });

  it("built-in identity 'none' makes every session anonymous", async () => {
    const { p } = withStore();
    p.select("identity", "none");
    expect(await p.resolveUser(req({ "x-portal-user-id": "u1" }))).toBeNull();
  });

  it("settings.js wins over the editor's choice and locks it", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ css: "none" }));
    const { p } = withStore({ settings: { cssEngine: "tailwind" } });
    expect(p.cssEngineId()).toBe("tailwind");
    expect(() => p.select("css", "none")).toThrow(ProviderSelectError);
    try {
      p.select("css", "none");
    } catch (e) {
      expect(e.code).toBe("locked");
      expect(e.message).toMatch(/portalReact\.cssEngine/);
    }
    // The other kind is not locked.
    expect(p.select("identity", "none")).toBe(true);
  });

  it("rejects what cannot be chosen, leaving the file untouched", () => {
    const old = identityPlugin("old", () => null, { apiVersion: 0 });
    const shadow = identityPlugin("headers", () => ({ userId: "admin" }));
    const { p } = withStore({ plugins: [old, shadow] });
    const codeOf = (kind, id) => {
      try {
        p.select(kind, id);
      } catch (e) {
        return e.code;
      }
      return "ok";
    };
    expect(codeOf("theme", "dark")).toBe("bad-kind");
    expect(codeOf("__proto__", "x")).toBe("bad-kind");
    expect(codeOf("identity", "")).toBe("bad-id");
    expect(codeOf("identity", 5)).toBe("bad-id");
    expect(codeOf("identity", "../etc")).toBe("bad-id");
    expect(codeOf("identity", "<b>")).toBe("bad-id");
    expect(codeOf("identity", "ghost")).toBe("unknown");
    expect(codeOf("identity", "old")).toBe("unknown");
    expect(codeOf("css", "headers")).toBe("unknown");
    expect(fs.existsSync(file)).toBe(false);
    expect(p.identityId()).toBe("headers");
  });

  it("a failed write keeps the previous choice in force", () => {
    const { p } = withStore();
    p.select("css", "none");
    // A directory where the temp file should go makes the write fail.
    fs.mkdirSync(file + ".tmp");
    expect(() => p.select("css", "tailwind")).toThrow();
    expect(p.cssEngineId()).toBe("none");
  });

  it("malformed or hostile file content is ignored", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const content of ["{not json", "null", "[]", '"sso"']) {
      fs.writeFileSync(file, content);
      const { p } = withStore();
      expect(p.identityId()).toBe("headers");
      expect(p.cssEngineId()).toBe("tailwind");
    }
    fs.writeFileSync(file, JSON.stringify({ identity: "../x", css: 5, other: "y" }));
    const { p, RED } = withStore();
    expect(p.identityId()).toBe("headers");
    expect(p.cssEngineId()).toBe("tailwind");
    expect(RED._logs.error).toEqual([]);
  });

  it("without a store file the choice lives in memory", () => {
    const { p } = make();
    expect(p.select("css", "none")).toBe(true);
    expect(p.cssEngineId()).toBe("none");
  });
});

describe("describe()", () => {
  it("lists built-ins and plugins, with module and problems", () => {
    const sso = identityPlugin("sso", () => null, { module: "sso-pkg", label: "Company SSO" });
    const old = identityPlugin("old", () => null, { apiVersion: 2, module: "old-pkg" });
    const odd = identityPlugin("has space", () => null, { module: "odd-pkg" });
    const twin = identityPlugin("headers", () => null, { module: "evil-pkg" });
    const shadow = identityPlugin("none", () => null, { module: "evil-pkg" });
    const uno = cssPlugin("uno", () => ({ css: "" }), { module: "uno-pkg" });
    const { p } = make({ plugins: [sso, old, odd, twin, shadow, uno] });
    const d = p.describe();

    expect(d.identity).toMatchObject({ selected: "headers", source: "default", locked: false, missing: false });
    expect(d.identity.options.map((o) => o.id)).toEqual(["none", "headers", "sso", "old", "has space"]);
    expect(d.identity.options[0]).toMatchObject({ module: "built-in", builtin: true });
    expect(d.identity.options[1]).toMatchObject({ module: HEADERS_PKG, builtin: false });
    expect(d.identity.options[1].problem).toMatch(/more than one package/);
    expect(d.identity.options[2]).toEqual({ id: "sso", label: "Company SSO", module: "sso-pkg", builtin: false });
    expect(d.identity.options[3].problem).toMatch(/apiVersion 2/);
    expect(d.identity.options[4].problem).toMatch(/cannot be selected/);
    // A plugin claiming a built-in id is not offered — the core owns `none`.
    expect(d.identity.options.filter((o) => o.id === "none")).toHaveLength(1);

    expect(d.css.options.map((o) => o.id)).toEqual(["none", "tailwind", "uno"]);
    expect(d.css.options[1]).toEqual({
      id: "tailwind",
      label: "Tailwind CSS 4 utility classes",
      module: TAILWIND_PKG,
      builtin: false,
    });
  });

  it("reports source and lock", () => {
    const { p } = make({ settings: { identityProvider: "none" } });
    p.select("css", "none");
    const d = p.describe();
    expect(d.identity).toMatchObject({ selected: "none", source: "settings", locked: true });
    expect(d.css).toMatchObject({ selected: "none", source: "editor", locked: false });
  });

  it("a selected provider that is gone stays listed, flagged missing", () => {
    const plugins = [identityPlugin("sso", () => null, { module: "sso-pkg" })];
    const { p } = make({ plugins });
    p.select("identity", "sso");
    plugins.length = 0; // package uninstalled
    const d = p.describe();
    expect(d.identity.missing).toBe(true);
    expect(d.identity.options.at(-1)).toMatchObject({ id: "sso", missing: true });
  });
});

// ── editorClasses(): completion list for className="…" ──

describe("editorClasses()", () => {
  // Tailwind's real list is big; a stand-in keeps expectations readable.
  const twClasses = vi.fn(() => ["p-4", "m-2"]);
  const tw = cssPlugin("tailwind", () => ({ css: "" }), { module: TAILWIND_PKG, editor: { classes: twClasses } });
  const makeTw = ({ plugins = [], ...opts } = {}) => {
    const RED = fakeRED({ ...opts, plugins: [ADDONS[0], tw, ...plugins], addons: false });
    return { RED, p: createProviders(RED) };
  };

  it("tailwind: the candidate list, computed once", async () => {
    twClasses.mockClear();
    const { p } = makeTw();
    expect(await p.editorClasses()).toEqual({ engine: "tailwind", classes: ["p-4", "m-2"] });
    await p.editorClasses();
    expect(twClasses).toHaveBeenCalledTimes(1);
  });

  it("the real tailwind add-on ships its candidate list", async () => {
    const { p } = make();
    const { classes } = await p.editorClasses();
    expect(classes.length).toBeGreaterThan(1000);
    expect(classes).toContain("bg-red-500");
  });

  it("none, unknown engine, or a plugin without editor: empty list", async () => {
    const plain = cssPlugin("plain", () => ({ css: "" }));
    for (const cssEngine of ["none", "ghost", "plain"]) {
      const { p } = makeTw({ plugins: [plain], settings: { cssEngine } });
      expect(await p.editorClasses()).toEqual({ engine: cssEngine, classes: [] });
    }
  });

  it("follows the engine chosen at runtime", async () => {
    const uno = cssPlugin("uno", () => ({ css: "" }), {
      editor: { classes: async () => ["uno-a"] },
    });
    const { p } = makeTw({ plugins: [uno] });
    expect((await p.editorClasses()).classes).toEqual(["p-4", "m-2"]);
    p.select("css", "uno");
    expect(await p.editorClasses()).toEqual({ engine: "uno", classes: ["uno-a"] });
    p.select("css", "none");
    expect((await p.editorClasses()).classes).toEqual([]);
  });

  it("filters plugin output: strings only, no blanks/whitespace/overlong, de-duplicated", async () => {
    const uno = cssPlugin("uno", () => ({ css: "" }), {
      editor: { classes: () => ["a", "a", "", 5, null, "has space", "x".repeat(201), "y".repeat(200), "b"] },
    });
    const { p } = makeTw({ plugins: [uno], settings: { cssEngine: "uno" } });
    expect((await p.editorClasses()).classes).toEqual(["a", "y".repeat(200), "b"]);
  });

  it("caps the list length", async () => {
    const { MAX_EDITOR_CLASSES } = require("../packages/fromcubes-react/nodes/lib/providers");
    const many = Array.from({ length: MAX_EDITOR_CLASSES + 10 }, (_, i) => "c" + i);
    const uno = cssPlugin("uno", () => ({ css: "" }), { editor: { classes: () => many } });
    const { p } = makeTw({ plugins: [uno], settings: { cssEngine: "uno" } });
    expect((await p.editorClasses()).classes).toHaveLength(MAX_EDITOR_CLASSES);
  });

  it("throw or non-array ⇒ empty list + warn, never a rejection", async () => {
    const boom = cssPlugin("boom", () => ({ css: "" }), {
      editor: { classes: () => { throw new Error("nope"); } },
    });
    const odd = cssPlugin("odd", () => ({ css: "" }), { editor: { classes: () => "p-4 m-2" } });
    for (const id of ["boom", "odd"]) {
      const { p, RED } = makeTw({ plugins: [boom, odd], settings: { cssEngine: id } });
      expect((await p.editorClasses()).classes).toEqual([]);
      expect(RED._logs.warn[0]).toMatch(new RegExp(`"${id}" editor\\.classes\\(\\)`));
    }
  });

  it("a reinstalled plugin (new definition) is asked again", async () => {
    const plugins = [cssPlugin("uno", () => ({ css: "" }), { editor: { classes: () => ["v1"] } })];
    // make(), not makeTw(): fakeRED must see this very array to observe the swap.
    const { p } = make({ plugins, settings: { cssEngine: "uno" } });
    expect((await p.editorClasses()).classes).toEqual(["v1"]);
    plugins[0] = cssPlugin("uno", () => ({ css: "" }), { editor: { classes: () => ["v2"] } });
    expect((await p.editorClasses()).classes).toEqual(["v2"]);
  });
});
