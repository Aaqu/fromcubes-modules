/**
 * Identity end-to-end: the headers add-on (@aaqu/fromcubes-auth-headers)
 * feeding the core's router. These tests document the trust boundary from
 * docs/SECURITY.md: identity headers are trusted unconditionally, so anything
 * a client can put in them lands in ws._portalUser verbatim. The reverse
 * proxy MUST strip inbound x-portal-user-* headers — the assertions below
 * show exactly what breaks when it does not.
 *
 * The header parsing itself is tested in packages/fromcubes-auth-headers.
 */

const { extractPortalUser } = require("../packages/fromcubes-auth-headers/headers");
const { route } = require("../packages/fromcubes-react/nodes/lib/router");

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
