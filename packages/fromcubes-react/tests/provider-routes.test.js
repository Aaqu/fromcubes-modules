/**
 * /fromcubes-react/providers — the admin API behind Settings → Fromcubes.
 * Real provider registry and real admin-api wiring; only RED is faked.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerAdminApi } = require("../nodes/lib/admin-api");
const { createProviders, IDENTITY_TYPE, CSS_TYPE, API_VERSION } = require("../nodes/lib/providers");

// Stand-in for the tailwind add-on, so the default CSS engine exists.
const TAILWIND = { id: "tailwind", type: CSS_TYPE, apiVersion: API_VERSION, module: "@aaqu/fromcubes-tailwind", generate: () => ({ css: "" }) };

let tmpDir;
let app;
let logs;
let changes;
let gate;
let settings;

function build({ plugins = [] } = {}) {
  logs = [];
  changes = [];
  gate = { read: [], write: [], csrf: [], rate: [] };
  const RED = {
    httpAdmin: express.Router(),
    httpNode: express.Router(),
    settings: { portalReact: settings },
    plugins: { getByType: (t) => [TAILWIND, ...plugins].filter((p) => p.type === t) },
    log: {
      error: (m) => logs.push(["error", m]),
      warn: (m) => logs.push(["warn", m]),
      info: () => {},
    },
  };
  const providers = createProviders(RED, {
    storeFile: path.join(tmpDir, "fromcubes", "providers.json"),
  });
  const mark = (list) => (req, _res, next) => {
    list.push(req.method + " " + req.path);
    next();
  };
  registerAdminApi(RED, {
    express,
    permRead: mark(gate.read),
    permWrite: mark(gate.write),
    // Same contract as portal-react.js: the editor's XHRs carry this header.
    csrfGuard: (req, res, next) => {
      gate.csrf.push(req.method + " " + req.path);
      if (!req.get("Node-RED-API-Version")) return res.status(403).json({ error: "csrf" });
      next();
    },
    rateLimit: mark(gate.rate),
    userDir: tmpDir,
    pageState: {},
    registry: {},
    utilities: {},
    extractUtilitySymbols: () => new Set(),
    providers,
    onProviderChange: (kind) => changes.push(kind),
  });
  app = express();
  // Stand-in for Node-RED's auth: the editor user making the request.
  app.use((req, _res, next) => {
    req.user = { username: "alice" };
    next();
  });
  app.use(RED.httpAdmin);
  return providers;
}

const put = (body) =>
  request(app).put("/fromcubes-react/providers").set("Node-RED-API-Version", "v2").send(body);

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-routes-")));
  settings = {};
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("GET describes both kinds behind the read permission", async () => {
  build();
  const res = await request(app).get("/fromcubes-react/providers");
  expect(res.status).toBe(200);
  // No identity add-on in this harness: the default is the core's own `none`.
  expect(res.body.identity.selected).toBe("none");
  expect(res.body.css.selected).toBe("tailwind");
  expect(gate.read).toContain("GET /fromcubes-react/providers");
});

test("PUT changes the provider, persists, notifies and logs who did it", async () => {
  build({
    plugins: [
      { id: "sso", type: IDENTITY_TYPE, apiVersion: API_VERSION, module: "sso-pkg", resolveUser: () => null },
    ],
  });
  const res = await put({ kind: "identity", id: "sso" });
  expect(res.status).toBe(200);
  expect(res.body.identity).toMatchObject({ selected: "sso", source: "editor" });
  expect(changes).toEqual(["identity"]);
  expect(logs).toContainEqual(["warn", '[portal-react] identity provider set to "sso" by alice']);
  expect(
    JSON.parse(fs.readFileSync(path.join(tmpDir, "fromcubes", "providers.json"), "utf8")),
  ).toEqual({ identity: "sso" });
  for (const list of [gate.write, gate.csrf, gate.rate]) {
    expect(list).toContain("PUT /fromcubes-react/providers");
  }
});

test("PUT of the provider already in force does not notify", async () => {
  build();
  const res = await put({ kind: "css", id: "tailwind" });
  expect(res.status).toBe(200);
  expect(changes).toEqual([]);
  expect(logs).toEqual([]);
});

test("PUT without the CSRF header is refused before anything changes", async () => {
  build();
  const res = await request(app).put("/fromcubes-react/providers").send({ kind: "css", id: "none" });
  expect(res.status).toBe(403);
  expect(changes).toEqual([]);
  expect(fs.existsSync(path.join(tmpDir, "fromcubes", "providers.json"))).toBe(false);
});

test.each([
  [{ kind: "theme", id: "x" }, 400, "bad-kind"],
  [{ kind: "identity", id: "../x" }, 400, "bad-id"],
  [{ kind: "identity" }, 400, "bad-id"],
  [{}, 400, "bad-kind"],
  [{ kind: "identity", id: "ghost" }, 400, "unknown"],
])("PUT %j → %i %s", async (body, status, code) => {
  build();
  const res = await put(body);
  expect(res.status).toBe(status);
  expect(res.body.code).toBe(code);
  expect(changes).toEqual([]);
});

test("PUT on a kind set in settings.js is 409", async () => {
  settings = { cssEngine: "tailwind" };
  build();
  const res = await put({ kind: "css", id: "none" });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("locked");
  expect(changes).toEqual([]);
});

test("a write failure is a generic 500, details only in the log", async () => {
  build();
  fs.mkdirSync(path.join(tmpDir, "fromcubes", "providers.json.tmp"), { recursive: true });
  const res = await put({ kind: "css", id: "none" });
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ error: "could not save the provider choice" });
  expect(logs.some(([lvl, m]) => lvl === "error" && /saving provider choice failed/.test(m))).toBe(true);
  expect(changes).toEqual([]);
});

test("no providers dependency, no routes", async () => {
  const RED = {
    httpAdmin: express.Router(),
    httpNode: express.Router(),
    settings: {},
    log: { error: () => {}, warn: () => {}, info: () => {} },
  };
  const noop = (_q, _s, n) => n();
  registerAdminApi(RED, {
    express,
    permRead: noop,
    permWrite: noop,
    csrfGuard: noop,
    rateLimit: noop,
    userDir: tmpDir,
    pageState: {},
    registry: {},
    utilities: {},
    extractUtilitySymbols: () => new Set(),
  });
  const a = express().use(RED.httpAdmin);
  expect((await request(a).get("/fromcubes-react/providers")).status).toBe(404);
});

test("GET /fromcubes-react/css-classes lists the engine in force, behind read permission", async () => {
  const providers = build();
  const empty = (engine) => ({ engine, classes: [], colors: [], modifiers: [], classModifiers: [], variants: [], describe: false, canonical: false });
  let res = await request(app).get("/fromcubes-react/css-classes");
  expect(res.status).toBe(200);
  // The TAILWIND stand-in has no editor data, so the list is empty here;
  // the real add-on's list is covered in providers.test.js.
  expect(res.body).toEqual(empty("tailwind"));
  expect(gate.read).toContain("GET /fromcubes-react/css-classes");

  providers.select("css", "none");
  res = await request(app).get("/fromcubes-react/css-classes");
  expect(res.body).toEqual(empty("none"));
});

test("GET /fromcubes-react/css-describe explains newline-separated candidates, behind read permission", async () => {
  const seen = [];
  const uno = {
    id: "uno",
    type: CSS_TYPE,
    apiVersion: API_VERSION,
    generate: () => ({ css: "" }),
    editor: {
      describe: (list) => {
        seen.push(list);
        return list.map((c) => (c === "p-4" ? { hover: ".p-4 {}", documentation: ".p-4 {}", detail: "padding: 1rem;", color: null } : null));
      },
    },
  };
  const providers = build({ plugins: [uno] });
  providers.select("css", "uno");
  const res = await request(app).get("/fromcubes-react/css-describe").query({ c: "p-4\nhover:[color:red]" });
  expect(res.status).toBe(200);
  expect(seen).toEqual([["p-4", "hover:[color:red]"]]);
  expect(res.body).toEqual({
    engine: "uno",
    results: [{ hover: ".p-4 {}", documentation: ".p-4 {}", detail: "padding: 1rem;", color: null, rules: [] }, null],
  });
  expect(gate.read).toContain("GET /fromcubes-react/css-describe");
  expect(gate.rate).not.toContain("GET /fromcubes-react/css-describe");
});

test("GET /fromcubes-react/css-canonical: canonical spellings, behind read permission", async () => {
  const uno = {
    id: "uno",
    type: CSS_TYPE,
    apiVersion: API_VERSION,
    generate: () => ({ css: "" }),
    editor: { canonical: (list) => list.map((c) => (c === "w-[16px]" ? "w-4" : c)) },
  };
  const providers = build({ plugins: [uno] });
  providers.select("css", "uno");
  const res = await request(app).get("/fromcubes-react/css-canonical").query({ c: "w-[16px]\np-4" });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ engine: "uno", results: ["w-4", null] });
  expect(gate.read).toContain("GET /fromcubes-react/css-canonical");
  expect((await request(app).get("/fromcubes-react/css-canonical")).status).toBe(400);
  expect((await request(app).get("/fromcubes-react/css-canonical").query({ c: "a b" })).status).toBe(400);
});

test("GET /fromcubes-react/css-describe: 400 for a missing or malformed list", async () => {
  build();
  expect((await request(app).get("/fromcubes-react/css-describe")).status).toBe(400);
  expect((await request(app).get("/fromcubes-react/css-describe?c=a&c=b")).status).toBe(400);
  expect((await request(app).get("/fromcubes-react/css-describe").query({ c: "a b" })).status).toBe(400);
  const many = Array.from({ length: 65 }, (_, i) => "c" + i).join("\n");
  expect((await request(app).get("/fromcubes-react/css-describe").query({ c: many })).status).toBe(400);
});

test("the old /fromcubes-react/tw-classes route is gone", async () => {
  build();
  expect((await request(app).get("/fromcubes-react/tw-classes")).status).toBe(404);
});
