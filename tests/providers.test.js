/**
 * Provider registry (lib/providers.js): identity providers and CSS engines.
 *
 * The built-ins go through the same lookup and validation as third-party
 * plugins, so these tests pin down both the public plugin contract and the
 * guarantee that, with no configuration, nothing changes for existing flows.
 */

const {
  createProviders,
  sanitizeUser,
  IDENTITY_TYPE,
  CSS_TYPE,
  API_VERSION,
  MAX_USER_STRING,
  MAX_GROUPS,
} = require("../nodes/lib/providers");
const { extractPortalUser } = require("../nodes/lib/helpers");

function fakeRED({ plugins = [], settings = {} } = {}) {
  const logs = { error: [], warn: [] };
  return {
    settings: { portalReact: settings },
    plugins: {
      getByType: (type) => plugins.filter((p) => p.type === type),
    },
    log: {
      error: (m) => logs.error.push(m),
      warn: (m) => logs.warn.push(m),
    },
    _logs: logs,
  };
}

// generateCSS stub: the real one is covered in helpers.test.js, and booting
// tailwind here would only slow these tests down.
const fakeHelpers = {
  extractPortalUser,
  generateCSS: async (source) => ({ css: "/*tw*/" + source, cssHash: "x" }),
};

function make(opts, providerOpts) {
  const RED = fakeRED(opts);
  return { RED, p: createProviders(RED, fakeHelpers, providerOpts) };
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
    const p = createProviders(RED, fakeHelpers);
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

  it("built-in header provider returns exactly what extractPortalUser returns", async () => {
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

  it("built-in tailwind engine passes the source to generateCSS", async () => {
    const { p } = make();
    expect(await p.generateCss("p-4")).toEqual({ css: "/*tw*/p-4" });
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

  it("built-in ids are reserved: a plugin cannot shadow them", async () => {
    const shadow = identityPlugin("headers", () => ({ userId: "admin" }));
    const { p, RED } = make({ plugins: [shadow] });
    expect(await p.resolveUser(req())).toBeNull();
    expect(await p.resolveUser(req({ "x-portal-user-id": "u1" }))).toEqual({
      userId: "u1",
      groups: [],
    });
    expect(RED._logs.error.join("\n")).toMatch(/"headers" ignored: id is reserved/);
  });

  it("survives RED.plugins being absent or throwing", async () => {
    const RED = fakeRED({ settings: { identityProvider: "sso" } });
    RED.plugins = { getByType: () => { throw new Error("boom"); } };
    const p = createProviders(RED, fakeHelpers);
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
