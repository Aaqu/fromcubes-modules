/**
 * The shipped example flows (examples/*.json) must coexist: users import
 * several of them into one Node-RED, so anything that is global there —
 * component names, utility symbols, portal sub-paths, node ids — has to be
 * unique across ALL examples, not just inside one file. Two examples once
 * both defined `StatusBar`; importing both left one red with "Component name
 * already used by another node".
 */

const fs = require("fs");
const path = require("path");
const { validateSubPath, isSafeName } = require("../nodes/lib/helpers");
const { extractUtilitySymbols } = require("../nodes/lib/registry-nodes");

const DIR = path.join(__dirname, "..", "examples");
const examples = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((file) => ({ file, nodes: JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) }));

const all = examples.flatMap(({ file, nodes }) => nodes.map((node) => ({ file, node })));
const ofType = (t) => all.filter(({ node }) => node.type === t);

function duplicates(entries) {
  const seen = new Map();
  for (const [key, file] of entries) {
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(file);
  }
  return [...seen].filter(([, files]) => files.length > 1).map(([k, files]) => `${k}: ${files.join(", ")}`);
}

test("there are examples", () => {
  expect(examples.length).toBeGreaterThan(5);
});

test("node ids are unique across all examples", () => {
  expect(duplicates(all.map(({ file, node }) => [node.id, file]))).toEqual([]);
});

test("component and utility names are unique and never collide with each other", () => {
  const names = [
    ...ofType("fc-portal-component").map(({ file, node }) => [node.compName, file]),
    ...ofType("fc-portal-utility").flatMap(({ file, node }) => [
      [node.utilName, file],
      ...[...extractUtilitySymbols(node.utilCode || "")].map((s) => [s, file]),
    ]),
  ];
  for (const [name] of names) expect(isSafeName(name), name).toBe(true);
  expect(duplicates(names)).toEqual([]);
});

test("portal sub-paths are valid and unique across all examples", () => {
  const portals = ofType("portal-react");
  for (const { file, node } of portals) {
    expect(validateSubPath(node.subPath).ok, `${file}: ${node.subPath}`).toBe(true);
    expect(node.endpoint, `${file}: legacy endpoint field`).toBeUndefined();
  }
  expect(duplicates(portals.map(({ file, node }) => [node.subPath, file]))).toEqual([]);
});

test("every component a portal uses is defined in the examples", () => {
  const defined = new Set(ofType("fc-portal-component").map(({ node }) => node.compName));
  const missing = [];
  for (const { file, node } of [...ofType("portal-react"), ...ofType("fc-portal-component")]) {
    const code = node.componentCode || node.compCode || "";
    const own = new Set([...code.matchAll(/function\s+([A-Z]\w*)|const\s+([A-Z]\w*)\s*=/g)].map((m) => m[1] || m[2]));
    for (const [, tag] of code.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)) {
      if (!defined.has(tag) && !own.has(tag) && !/^(Fragment|Suspense|StrictMode)$/.test(tag)) {
        // Library components (Canvas, OrbitControls, …) come from `import`.
        if (!new RegExp(`import[^;]*\\b${tag}\\b`).test(code)) missing.push(`${file}: <${tag}>`);
      }
    }
  }
  expect(missing).toEqual([]);
});
