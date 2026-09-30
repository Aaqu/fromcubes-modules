/**
 * Security-focused tests for the identity pipeline:
 *   - extractPortalUser() header parsing (whitelist, groups limits, pollution)
 *   - router trust-model consequences when x-portal-user-* headers are forged
 *
 * These tests document the trust boundary from docs/SECURITY.md: identity
 * headers are trusted unconditionally, so anything a client can put in them
 * lands in ws._portalUser verbatim. The reverse proxy MUST strip inbound
 * x-portal-user-* headers — the assertions below show exactly what breaks
 * when it does not.
 */

const { extractPortalUser } = require("../nodes/lib/helpers");
const { route } = require("../nodes/lib/router");

const MAX_GROUPS_HEADER_BYTES = 8 * 1024;

describe("extractPortalUser — header contract", () => {
  it("returns null when no identity header is present", () => {
    expect(extractPortalUser({})).toBeNull();
    expect(extractPortalUser({ host: "red:1880", cookie: "a=1" })).toBeNull();
  });

  it("maps the six contract headers", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-login": "jan",
      "x-portal-user-display-name": "Jan%20Kowalski",
      "x-portal-user-email": "jan%40example.com",
      "x-portal-user-role": "editor",
      "x-portal-user-groups": "ops,dev",
    });
    expect(user).toEqual({
      userId: "u1",
      login: "jan",
      displayName: "Jan Kowalski",
      email: "jan@example.com",
      role: "editor",
      groups: ["ops", "dev"],
    });
  });

  it("percent-decodes UTF-8 values", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-display-name": "%C5%81ukasz%20%C5%BB%C3%B3%C5%82%C4%87",
    });
    expect(user.displayName).toBe("Łukasz Żółć");
  });

  it("missing x-portal-user-id means anonymous, whatever else is present", () => {
    expect(
      extractPortalUser({
        "x-portal-user-login": "jan",
        "x-portal-user-display-name": "Jan",
        "x-portal-user-email": "jan%40example.com",
        "x-portal-user-role": "editor",
        "x-portal-user-groups": "ops",
      }),
    ).toBeNull();
  });

  it("empty or undecodable x-portal-user-id means anonymous", () => {
    expect(extractPortalUser({ "x-portal-user-id": "" })).toBeNull();
    expect(extractPortalUser({ "x-portal-user-id": "%E0%A4%A" })).toBeNull();
  });

  it("drops a single-value field with a malformed escape, keeps the rest", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-display-name": "%E0%A4%A",
      "x-portal-user-login": "jan",
    });
    expect(user).toEqual({ userId: "u1", login: "jan", groups: [] });
  });

  it("ignores the pre-contract -username / -name headers", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-username": "jan",
      "x-portal-user-name": "Jan Kowalski",
    });
    expect(user).toEqual({ userId: "u1", groups: [] });
  });

  it("ignores non-contract x-portal-user-* headers (no arbitrary key injection)", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-isadmin": "true",
      "x-portal-user-__proto__": "x",
      "x-portal-user-constructor": "x",
    });
    expect(Object.keys(user)).toEqual(["userId", "groups"]);
  });
});

describe("extractPortalUser — groups header", () => {
  const groupsOf = (raw) =>
    extractPortalUser({ "x-portal-user-id": "u1", "x-portal-user-groups": raw })
      .groups;

  it("splits on raw commas before decoding, so %2C stays inside a name", () => {
    expect(
      groupsOf("Utrzymanie%20ruchu%20%E2%80%93%20hala%202,a%2Cb,hala-2"),
    ).toEqual(["Utrzymanie ruchu – hala 2", "a,b", "hala-2"]);
  });

  it("empty or missing header yields []", () => {
    expect(groupsOf("")).toEqual([]);
    expect(extractPortalUser({ "x-portal-user-id": "u1" }).groups).toEqual([]);
  });

  it("drops empty elements", () => {
    expect(groupsOf(",,x,")).toEqual(["x"]);
  });

  it("drops only the element with a malformed escape", () => {
    expect(groupsOf("ok,%E0%A4%A,hala-2")).toEqual(["ok", "hala-2"]);
  });

  it("trims around raw commas (Node joins a repeated header with ', ')", () => {
    expect(groupsOf("ops, dev")).toEqual(["ops", "dev"]);
  });

  it("does not parse JSON any more", () => {
    expect(groupsOf('["a","b"]')).toEqual(['["a"', '"b"]']);
  });

  it("drops an oversized header whole instead of truncating a name", () => {
    const big = "a,".repeat(MAX_GROUPS_HEADER_BYTES);
    expect(groupsOf(big)).toEqual([]);
  });

  it("userId '__proto__' cannot poison a Map-based userIndex", () => {
    const userIndex = new Map();
    const user = extractPortalUser({ "x-portal-user-id": "__proto__" });
    userIndex.set(user.userId, new Set());
    expect(userIndex.get("__proto__")).toBeInstanceOf(Set);
    expect({}.size).toBeUndefined();
  });
});

// ── Multi-tenancy: what header forgery buys an attacker ──────────────

function fakeWs(portalClient, portalUser) {
  return { _portalClient: portalClient, _portalUser: portalUser || null, sent: [] };
}

function setupCtx() {
  const clients = new Map();
  const userIndex = new Map();
  const sendTo = (ws, frame, msg) => {
    if (!ws) return false;
    ws.sent.push({ frame: JSON.parse(frame), msg });
    return true;
  };
  function addClient(portalClient, headers) {
    // Mirrors the WS connection handler: identity comes exclusively from
    // extractPortalUser(request.headers), never from client frames.
    const ws = fakeWs(portalClient, extractPortalUser(headers || {}));
    clients.set(portalClient, ws);
    const userId = ws._portalUser && ws._portalUser.userId;
    if (userId) {
      let set = userIndex.get(userId);
      if (!set) userIndex.set(userId, (set = new Set()));
      set.add(ws);
    }
    return ws;
  }
  return { clients, userIndex, sendTo, addClient };
}

describe("multi-tenancy — honest proxy (headers set per authenticated user)", () => {
  it("user-cast reaches only that user's sessions", () => {
    const ctx = setupCtx();
    const alice1 = ctx.addClient("A1", { "x-portal-user-id": "alice" });
    const alice2 = ctx.addClient("A2", { "x-portal-user-id": "alice" });
    const bob = ctx.addClient("B1", { "x-portal-user-id": "bob" });

    const r = route({ payload: "secret", _client: { userId: "alice" } }, ctx);
    expect(r).toEqual({ mode: "user-cast", delivered: 2 });
    expect(alice1.sent).toHaveLength(1);
    expect(alice2.sent).toHaveLength(1);
    expect(bob.sent).toHaveLength(0);
  });

  it("anonymous client (no headers) never receives user-cast traffic", () => {
    const ctx = setupCtx();
    const anon = ctx.addClient("X1");
    ctx.addClient("A1", { "x-portal-user-id": "alice" });

    route({ payload: "secret", _client: { userId: "alice" } }, ctx);
    expect(anon.sent).toHaveLength(0);
  });

  it("login-cast fallback does not match anonymous clients", () => {
    const ctx = setupCtx();
    const anon = ctx.addClient("X1");
    const alice = ctx.addClient("A1", {
      "x-portal-user-id": "u-alice",
      "x-portal-user-login": "alice",
    });

    const r = route({ payload: "s", _client: { login: "alice" } }, ctx);
    expect(r.delivered).toBe(1);
    expect(alice.sent).toHaveLength(1);
    expect(anon.sent).toHaveLength(0);
  });
});

describe("multi-tenancy — forged headers (proxy bypassed / not stripping)", () => {
  // These are the documented consequences of the unconditional header trust:
  // if an attacker can speak to Node-RED directly, forging x-portal-user-id
  // makes them a full member of the victim's user-cast set. The package is
  // NOT resistant to this by itself — the proxy is the enforcement point.

  it("forged x-portal-user-id receives the victim's user-cast messages", () => {
    const ctx = setupCtx();
    const victim = ctx.addClient("V1", { "x-portal-user-id": "alice" });
    const attacker = ctx.addClient("E1", { "x-portal-user-id": "alice" });

    route({ payload: "secret", _client: { userId: "alice" } }, ctx);
    expect(victim.sent).toHaveLength(1);
    expect(attacker.sent).toHaveLength(1); // interception — proxy must prevent
  });

  it("forged x-portal-user-login intercepts login-cast fallback", () => {
    const ctx = setupCtx();
    const attacker = ctx.addClient("E1", {
      "x-portal-user-id": "mallory",
      "x-portal-user-login": "alice",
    });
    route({ payload: "secret", _client: { login: "alice" } }, ctx);
    expect(attacker.sent).toHaveLength(1);
  });

  it("forged x-portal-user-* headers count as 'authenticated' for auth-cast (proxy must strip)", () => {
    const ctx = setupCtx();
    const real = ctx.addClient("R1", { "x-portal-user-id": "alice" });
    const attacker = ctx.addClient("E1", { "x-portal-user-id": "mallory" });
    const anon = ctx.addClient("X1");

    route({ payload: "members-only", _client: { authenticated: true } }, ctx);
    expect(real.sent).toHaveLength(1);
    expect(attacker.sent).toHaveLength(1); // any identity headers pass — proxy is the gate
    expect(anon.sent).toHaveLength(0);
  });

  it("forged headers do NOT grant access to unicast (portalClient is server-assigned)", () => {
    const ctx = setupCtx();
    const victim = ctx.addClient("V1", { "x-portal-user-id": "alice" });
    const attacker = ctx.addClient("E1", {
      "x-portal-user-id": "alice",
      // portalClient is a server-side crypto.randomUUID(); a client cannot
      // choose it, so pretending in headers changes nothing:
      "x-portal-user-portalclient": "V1",
    });

    route({ payload: "secret", _client: { portalClient: "V1" } }, ctx);
    expect(victim.sent).toHaveLength(1);
    expect(attacker.sent).toHaveLength(0);
  });
});
