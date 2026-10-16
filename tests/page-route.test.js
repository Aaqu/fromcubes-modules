/**
 * Portal page route (lib/portal-page-route.js) against the identity provider:
 * the user embedded in the page comes from `resolveUser`, which may be async,
 * and is only asked for when the portal has Portal Auth on.
 */

const express = require("express");
const request = require("supertest");

const { createPortalPageHandler } = require("../nodes/lib/portal-page-route");
const { buildPage, buildErrorPage } = require("../nodes/lib/page-builder");

const ENDPOINT = "/fromcubes/demo";

function goodState(extra = {}) {
  return {
    compiled: { js: "console.log(1)", error: null },
    cssReady: Promise.resolve({ css: "", cssHash: "" }),
    pageTitle: "Demo",
    wsPath: ENDPOINT + "/_ws",
    customHead: "",
    showWsStatus: false,
    portalAuth: true,
    ...extra,
  };
}

function appWith(state, resolveUser) {
  const pageState = { [ENDPOINT]: state };
  const app = express();
  app.get(
    ENDPOINT,
    createPortalPageHandler({
      endpoint: ENDPOINT,
      pageState,
      wsPath: ENDPOINT + "/_ws",
      pageTitle: "Demo",
      nodeRoot: "",
      buildPage,
      buildErrorPage,
      resolveUser,
    }),
  );
  return app;
}

function embeddedUser(html) {
  const m = html.match(/_user: (.*),\n/);
  return m ? JSON.parse(m[1]) : undefined;
}

test("embeds the user resolved by an async provider", async () => {
  const resolveUser = async (req) => {
    await new Promise((r) => setTimeout(r, 5));
    return { userId: req.headers["x-sso-sub"], groups: ["ops"] };
  };
  const res = await request(appWith(goodState(), resolveUser))
    .get(ENDPOINT)
    .set("x-sso-sub", "s1");
  expect(res.status).toBe(200);
  expect(embeddedUser(res.text)).toEqual({ userId: "s1", groups: ["ops"] });
});

test("anonymous provider answer embeds null", async () => {
  const res = await request(appWith(goodState(), async () => null)).get(ENDPOINT);
  expect(res.status).toBe(200);
  expect(embeddedUser(res.text)).toBeNull();
});

test("Portal Auth off: provider is never called", async () => {
  const resolveUser = vi.fn(async () => ({ userId: "u1", groups: [] }));
  const res = await request(appWith(goodState({ portalAuth: false }), resolveUser)).get(ENDPOINT);
  expect(res.status).toBe(200);
  expect(embeddedUser(res.text)).toBeNull();
  expect(resolveUser).not.toHaveBeenCalled();
});

test("degraded (last good) page also uses the provider", async () => {
  const state = goodState({
    compiled: { js: null, error: "boom" },
    lastGood: {
      compiledJs: "console.log(0)",
      contentHash: "h",
      cssHash: "",
      pageTitle: "Demo",
      customHead: "",
    },
  });
  const res = await request(appWith(state, async () => ({ userId: "u2", groups: [] }))).get(
    ENDPOINT,
  );
  expect(res.status).toBe(200);
  expect(embeddedUser(res.text)).toEqual({ userId: "u2", groups: [] });
});

test("empty cssHash renders no stylesheet link (css engine 'none')", async () => {
  const res = await request(appWith(goodState({ portalAuth: false }), async () => null)).get(
    ENDPOINT,
  );
  expect(res.text).not.toContain("/fromcubes/css/");
});

test("non-empty cssHash renders the stylesheet link", async () => {
  const state = goodState({
    portalAuth: false,
    cssReady: Promise.resolve({ css: "a{}", cssHash: "abc123" }),
  });
  const res = await request(appWith(state, async () => null)).get(ENDPOINT);
  expect(res.text).toContain('href="/fromcubes/css/abc123.css"');
});
