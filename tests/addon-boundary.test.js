/**
 * The line between the core (@aaqu/fromcubes-react) and the add-on packages.
 *
 * An add-on is installed on its own, next to whatever core version the user
 * has, so it may depend on the core only through the core's published `api`
 * export — never a deep path, never a relative path into another package,
 * never another add-on. The core never requires an add-on: it finds them
 * through RED.plugins. And each package must publish every file it loads.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { builtinModules } = require("module");

const ROOT = path.join(__dirname, "..");
const PACKAGES = path.join(ROOT, "packages");
const CORE_DIR = path.join(PACKAGES, "fromcubes-react");
const CORE = "@aaqu/fromcubes-react";
const CORE_API = CORE + "/api";

const readPkg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));

const addonDirs = fs
  .readdirSync(PACKAGES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "fromcubes-react")
  .map((e) => path.join(PACKAGES, e.name));

// Shipped source files of a package (tests and node_modules excluded).
function sourceFiles(dir, exts = [".js"]) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "tests" || e.name === "tools") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
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

const pkgNameOf = (spec) => {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  return bare.startsWith("@") ? bare.split("/").slice(0, 2).join("/") : bare.split("/")[0];
};

test("the expected packages are there", () => {
  expect(addonDirs.map((d) => path.basename(d)).sort()).toEqual([
    "fromcubes-assets",
    "fromcubes-auth-headers",
    "fromcubes-tailwind",
  ]);
  for (const dir of [CORE_DIR, ...addonDirs]) {
    expect(readPkg(dir).name).toBe("@aaqu/" + path.basename(dir));
  }
});

test("the core's api export resolves to the add-on surface", () => {
  const core = readPkg(CORE_DIR);
  expect(core.exports["./api"]).toBe("./nodes/lib/api.js");
  const api = require(CORE_API);
  for (const key of ["IDENTITY_TYPE", "CSS_TYPE", "API_VERSION", "createAdminSecurity", "loadExpress"]) {
    expect(api[key], key).toBeDefined();
  }
});

describe.each(addonDirs.map((d) => [path.basename(d), d]))("add-on %s", (_name, dir) => {
  const pkg = readPkg(dir);

  test("requires only its own files, Node built-ins, its dependencies, or the core api", () => {
    const deps = new Set(Object.keys(pkg.dependencies || {}));
    for (const file of sourceFiles(dir)) {
      for (const spec of requires(file)) {
        const where = `${path.relative(ROOT, file)} requires "${spec}"`;
        if (spec.startsWith(".")) {
          expect(path.resolve(path.dirname(file), spec).startsWith(dir + path.sep), where).toBe(true);
        } else if (pkgNameOf(spec) === CORE) {
          expect(spec, where).toBe(CORE_API);
        } else {
          const name = pkgNameOf(spec);
          expect(builtinModules.includes(name) || deps.has(name), where).toBe(true);
        }
      }
    }
  });

  test("declares the core as a peer, not a dependency", () => {
    expect(pkg.peerDependencies?.[CORE]).toBeTruthy();
    expect(pkg.dependencies?.[CORE]).toBeUndefined();
  });

  test("is a Node-RED plugin whose entry exists", () => {
    const entries = Object.values(pkg["node-red"].plugins || {});
    expect(entries).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, entries[0]))).toBe(true);
    expect(pkg["node-red"].nodes).toBeUndefined();
  });

  test("publishes every file it ships", () => {
    const files = new Set(pkg.files);
    for (const file of sourceFiles(dir, [".js", ".html"])) {
      expect(files.has(path.relative(dir, file)), path.relative(ROOT, file)).toBe(true);
    }
    expect(files.has("README.md") && fs.existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(files.has("LICENSE") && fs.existsSync(path.join(dir, "LICENSE"))).toBe(true);
  });

  test("registers exactly one plugin with RED.plugins", () => {
    const registered = [];
    const RED = {
      plugins: { registerPlugin: (id, def) => registered.push({ id, def }) },
      settings: { userDir: fs.mkdtempSync(path.join(os.tmpdir(), "addon-")) },
      // Assets mounts routes; give it inert routers.
      httpAdmin: { use() {}, get() {}, post() {}, put() {}, delete() {} },
      httpNode: { use() {}, get() {} },
      log: { error() {}, warn() {}, info() {} },
    };
    require(path.join(dir, Object.values(pkg["node-red"].plugins)[0]))(RED);
    expect(registered).toHaveLength(1);
    if (RED.settings.portalReactRateBucketPruneIv) clearInterval(RED.settings.portalReactRateBucketPruneIv);
  });
});

test("the core never requires an add-on or reaches outside its package", () => {
  const addonNames = new Set(addonDirs.map((d) => readPkg(d).name));
  for (const file of sourceFiles(path.join(CORE_DIR, "nodes"))) {
    for (const spec of requires(file)) {
      const where = `${path.relative(ROOT, file)} requires "${spec}"`;
      if (spec.startsWith(".")) {
        expect(path.resolve(path.dirname(file), spec).startsWith(CORE_DIR + path.sep), where).toBe(true);
      } else {
        expect(addonNames.has(pkgNameOf(spec)), where).toBe(false);
      }
    }
  }
});

test("core editor HTML carries no add-on UI", () => {
  const html = fs.readFileSync(path.join(CORE_DIR, "nodes", "portal-react.html"), "utf8");
  expect(html).not.toContain("fromcubes-public");
  expect(html).not.toContain("fromcubes-react/assets");
});
