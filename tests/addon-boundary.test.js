/**
 * The line between the core and its add-ons (nodes/addons/*).
 *
 * Each add-on must be movable into its own npm package by changing one
 * require (`../../lib/api` → the core package's `api` export). That holds
 * only while:
 *   - an add-on reaches the core through lib/api.js and nothing else;
 *   - an add-on never reaches into another add-on;
 *   - the core never requires an add-on (it finds them through RED.plugins);
 *   - every add-on is declared as a Node-RED plugin in package.json.
 */

const fs = require("fs");
const path = require("path");
const { builtinModules } = require("module");

const ROOT = path.join(__dirname, "..");
const NODES = path.join(ROOT, "nodes");
const ADDONS = path.join(NODES, "addons");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// require("…") calls in code, ignoring ones inside comments.
function requires(file) {
  const src = fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
}

const addonNames = fs
  .readdirSync(ADDONS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

test("there are add-ons to check", () => {
  expect(addonNames.sort()).toEqual(["assets", "auth-headers", "tailwind"]);
});

describe.each(addonNames)("add-on %s", (name) => {
  const dir = path.join(ADDONS, name);

  test("reaches the core only through lib/api, never another add-on", () => {
    for (const file of jsFiles(dir)) {
      for (const spec of requires(file)) {
        if (!spec.startsWith(".")) continue;
        const target = path.resolve(path.dirname(file), spec);
        const inside = target.startsWith(dir + path.sep);
        const isApi = target === path.join(NODES, "lib", "api") ||
          target === path.join(NODES, "lib", "api.js");
        expect(
          inside || isApi,
          `${path.relative(ROOT, file)} requires ${spec}`,
        ).toBe(true);
      }
    }
  });

  test("requires only Node built-ins or declared dependencies", () => {
    const declared = new Set(Object.keys(pkg.dependencies || {}));
    for (const file of jsFiles(dir)) {
      for (const spec of requires(file)) {
        if (spec.startsWith(".")) continue;
        const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
        const pkgName = bare.startsWith("@") ? bare.split("/").slice(0, 2).join("/") : bare.split("/")[0];
        expect(
          builtinModules.includes(pkgName) || declared.has(pkgName),
          `${path.relative(ROOT, file)} requires undeclared "${spec}"`,
        ).toBe(true);
      }
    }
  });

  test("is declared as a Node-RED plugin whose entry file exists", () => {
    const entries = Object.values(pkg["node-red"].plugins || {}).filter((f) =>
      f.startsWith(`nodes/addons/${name}/`),
    );
    expect(entries).toHaveLength(1);
    expect(fs.existsSync(path.join(ROOT, entries[0]))).toBe(true);
  });
});

test("the core never requires an add-on", () => {
  const coreFiles = jsFiles(NODES).filter((f) => !f.startsWith(ADDONS + path.sep));
  for (const file of coreFiles) {
    for (const spec of requires(file)) {
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), spec);
      expect(
        target.startsWith(ADDONS + path.sep),
        `${path.relative(ROOT, file)} requires add-on ${spec}`,
      ).toBe(false);
    }
  }
});

test("core editor HTML carries no add-on UI", () => {
  const html = fs.readFileSync(path.join(NODES, "portal-react.html"), "utf8");
  expect(html).not.toContain("fromcubes-public");
  expect(html).not.toContain("portal-react/assets");
});

test("each add-on plugin registers itself with RED.plugins", () => {
  for (const rel of Object.values(pkg["node-red"].plugins)) {
    const registered = [];
    const RED = {
      plugins: { registerPlugin: (id, def) => registered.push({ id, def }) },
      settings: {},
      // portal-assets mounts routes; give it inert routers.
      httpAdmin: { use() {}, get() {}, post() {}, put() {}, delete() {} },
      httpNode: { use() {}, get() {} },
      log: { error() {}, warn() {}, info() {} },
    };
    if (rel.includes("/assets/")) {
      RED.settings.userDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "addon-"));
    }
    require(path.join(ROOT, rel))(RED);
    expect(registered.length, rel).toBe(1);
    if (RED.settings.portalReactRateBucketPruneIv) clearInterval(RED.settings.portalReactRateBucketPruneIv);
  }
});
