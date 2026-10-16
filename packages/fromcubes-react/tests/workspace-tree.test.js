const {
  GROUP_ORDER,
  iconKindFor,
  isParentFile,
  startsCollapsed,
  topLevelSymbols,
  declaresSymbol,
  isPortalNodeType,
  displayName,
  collectPortalFiles,
  buildTree,
  filterFiles,
} = require("../nodes/editor/file-tree");

// ── Fixtures ──────────────────────────────────────────────────

/** @returns {Array<Object>} nodes spread over a single flow tab */
function singleFlowNodes() {
  return [
    {
      id: "p1",
      type: "portal-react",
      z: "flowA",
      subPath: "sensors",
      componentCode: "function App(){return null}",
      customHead: "",
    },
    {
      id: "c1",
      type: "fc-portal-component",
      z: "flowA",
      compName: "Stat",
      compCode: "const Stat = () => null;",
    },
    {
      id: "c2",
      type: "fc-portal-component",
      z: "flowA",
      compName: "Button",
      compCode: "const Button = () => null;",
    },
    {
      id: "u1",
      type: "fc-portal-utility",
      z: "flowA",
      utilName: "helpers",
      utilCode: "function clamp(){}",
    },
    { id: "x1", type: "inject", z: "flowA" },
  ];
}

// ── isPortalNodeType / displayName ────────────────────────────

test("isPortalNodeType only accepts the three portal-react node types", () => {
  expect(isPortalNodeType("portal-react")).toBe(true);
  expect(isPortalNodeType("fc-portal-component")).toBe(true);
  expect(isPortalNodeType("fc-portal-utility")).toBe(true);
  expect(isPortalNodeType("inject")).toBe(false);
  expect(isPortalNodeType("constructor")).toBe(false);
});

test("displayName falls back registered name → canvas label → node id", () => {
  expect(displayName({ id: "n1", compName: "Card", name: "label" }, "compName")).toBe("Card");
  expect(displayName({ id: "n1", compName: "  ", name: "label" }, "compName")).toBe("label");
  expect(displayName({ id: "n1", compName: "", name: "" }, "compName")).toBe("n1");
});

// ── collectPortalFiles ────────────────────────────────────────

test("collects one file per code field, ignoring unrelated nodes", () => {
  const files = collectPortalFiles(singleFlowNodes());
  expect(files.map((f) => f.path)).toEqual([
    "Portals/sensors.jsx",
    "Components/Button.jsx",
    "Components/Stat.jsx",
    "Utilities/helpers.js",
  ]);
  expect(files.every((f) => f.nodeId !== "x1")).toBe(true);
});

test("groups are ordered Portals → Components → Utilities", () => {
  const files = collectPortalFiles(singleFlowNodes());
  const seen = [];
  files.forEach((f) => {
    if (seen[seen.length - 1] !== f.group) seen.push(f.group);
  });
  expect(seen).toEqual(GROUP_ORDER);
});

test("file descriptors carry the node id, field and language", () => {
  const files = collectPortalFiles(singleFlowNodes());
  const stat = files.find((f) => f.path === "Components/Stat.jsx");
  expect(stat).toMatchObject({
    key: "c1:compCode",
    nodeId: "c1",
    field: "compCode",
    lang: "javascript",
    registryName: "Stat",
    flowId: "flowA",
  });
  const util = files.find((f) => f.path === "Utilities/helpers.js");
  expect(util).toMatchObject({ field: "utilCode", registryName: "helpers" });
});

test("empty customHead is hidden unless showHead is set", () => {
  const nodes = singleFlowNodes();
  expect(collectPortalFiles(nodes).some((f) => f.name === "head.html")).toBe(false);

  const shown = collectPortalFiles(nodes, { showHead: true });
  const head = shown.find((f) => f.name === "head.html");
  expect(head).toMatchObject({
    // The head hangs off the portal's own file, not off a folder.
    path: "Portals/sensors.jsx/head.html",
    field: "customHead",
    lang: "html",
    registryName: null,
  });
});

test("non-empty customHead always shows", () => {
  const nodes = singleFlowNodes();
  nodes[0].customHead = "<meta charset='utf-8'>";
  const files = collectPortalFiles(nodes);
  expect(files.map((f) => f.path)).toContain("Portals/sensors.jsx/head.html");
});

test("unnamed nodes fall back to label then id in the path", () => {
  const files = collectPortalFiles([
    { id: "p9", type: "portal-react", z: "f", subPath: "", name: "Draft", componentCode: "x" },
    { id: "c9", type: "fc-portal-component", z: "f", compName: "", name: "", compCode: "x" },
  ]);
  expect(files.map((f) => f.path).sort()).toEqual([
    "Components/c9.jsx",
    "Portals/Draft.jsx",
  ]);
});

test("a single flow gets no flow level, several flows do", () => {
  const nodes = singleFlowNodes();
  expect(collectPortalFiles(nodes)[0].segments[0]).toBe("Portals");

  nodes.push({
    id: "c3",
    type: "fc-portal-component",
    z: "flowB",
    compName: "Gauge",
    compCode: "x",
  });
  const files = collectPortalFiles(nodes, {
    flowLabel: (id) => ({ flowA: "Main", flowB: "Lab" })[id],
  });
  // Components now span two flows, portals still one.
  expect(files.map((f) => f.path)).toContain("Components/Lab/Gauge.jsx");
  expect(files.map((f) => f.path)).toContain("Components/Main/Stat.jsx");
  expect(files.map((f) => f.path)).toContain("Portals/sensors.jsx");
});

test("kind-first grouping is the default and keeps utilities in one folder", () => {
  const nodes = singleFlowNodes();
  nodes.push({
    id: "u2",
    type: "fc-portal-utility",
    z: "flowB",
    utilName: "anim",
    utilCode: "function ease(){}",
  });
  const files = collectPortalFiles(nodes, {
    flowLabel: (id) => ({ flowA: "Main", flowB: "Lab" })[id],
  });
  expect(files.filter((f) => f.group === "Utilities").map((f) => f.path)).toEqual([
    "Utilities/Lab/anim.js",
    "Utilities/Main/helpers.js",
  ]);
  // Components live in one flow only, so they get no flow level at all.
  expect(files.map((f) => f.path)).toContain("Components/Stat.jsx");
  expect(files.map((f) => f.path)).toContain("Portals/sensors.jsx");
});

test("groupBy flow is one flat list per tab, no kind level", () => {
  const nodes = singleFlowNodes();
  nodes.push({ id: "u2", type: "fc-portal-utility", z: "flowB", utilName: "anim", utilCode: "x" });
  const files = collectPortalFiles(nodes, {
    groupBy: "flow",
    flowLabel: (id) => ({ flowA: "Main", flowB: "Lab" })[id],
  });
  expect(files.map((f) => f.path)).toEqual([
    "Lab/anim.js",
    // Inside Main: the portal, then components, then the utility.
    "Main/sensors.jsx",
    "Main/Button.jsx",
    "Main/Stat.jsx",
    "Main/helpers.js",
  ]);
  expect(files.every((f) => !/\/(Components|Portals|Utilities)\//.test(f.path))).toBe(true);
});

test("a lone flow drops the flow level too, leaving bare file names", () => {
  const files = collectPortalFiles(singleFlowNodes(), { groupBy: "flow" });
  expect(files.map((f) => f.path)).toEqual([
    "sensors.jsx",
    "Button.jsx",
    "Stat.jsx",
    "helpers.js",
  ]);
});

test("missing flow labels degrade to a placeholder instead of undefined", () => {
  const files = collectPortalFiles(
    [
      { id: "c1", type: "fc-portal-component", z: "flowA", compName: "A", compCode: "x" },
      { id: "c2", type: "fc-portal-component", z: "flowB", compName: "B", compCode: "x" },
    ],
    { flowLabel: () => "" },
  );
  expect(files.map((f) => f.path)).toEqual(["Components/Flow/A.jsx", "Components/Flow/B.jsx"]);
});

test("empty and missing input yields no files", () => {
  expect(collectPortalFiles([])).toEqual([]);
  expect(collectPortalFiles(undefined)).toEqual([]);
});

// ── buildTree ─────────────────────────────────────────────────

test("a portal is one file that owns its head, not a folder of two", () => {
  const tree = buildTree(collectPortalFiles(singleFlowNodes(), { showHead: true }));
  const portals = tree.children.find((c) => c.name === "Portals");
  expect(portals.children.map((c) => c.name)).toEqual(["sensors.jsx"]);

  const portal = portals.children[0];
  // Both a file (clicking it opens the JSX) and a parent (holding head.html).
  expect(portal).toMatchObject({ type: "file", path: "Portals/sensors.jsx" });
  expect(portal.file.field).toBe("componentCode");
  expect(portal.children.map((c) => c.name)).toEqual(["head.html"]);
  expect(portal.children[0].file.field).toBe("customHead");
});

test("a portal with no head shown has no children to expand", () => {
  const tree = buildTree(collectPortalFiles(singleFlowNodes()));
  const portal = tree.children.find((c) => c.name === "Portals").children[0];
  expect(portal.name).toBe("sensors.jsx");
  expect(portal.children).toEqual([]);
});

test("buildTree nests segments and sorts dirs before files", () => {
  const tree = buildTree(collectPortalFiles(singleFlowNodes(), { showHead: true }));
  expect(tree.children.map((c) => c.name)).toEqual(["Portals", "Components", "Utilities"]);
  const components = tree.children[1];
  expect(components.children.map((c) => c.name)).toEqual(["Button.jsx", "Stat.jsx"]);
});

test("buildTree keeps directories ahead of same-level files", () => {
  const tree = buildTree(
    collectPortalFiles([
      { id: "p1", type: "portal-react", z: "f", subPath: "a", componentCode: "x" },
      { id: "c1", type: "fc-portal-component", z: "f", compName: "Zeta", compCode: "x" },
    ]),
  );
  const kinds = tree.children.map((c) => c.type);
  expect(kinds).toEqual(["dir", "dir"]);
});

test("buildTree drops the internal index maps", () => {
  const tree = buildTree(collectPortalFiles(singleFlowNodes()));
  expect(tree.index).toBeUndefined();
  expect(tree.children[0].index).toBeUndefined();
});

test("buildTree of nothing is an empty root", () => {
  expect(buildTree([])).toMatchObject({ type: "dir", children: [] });
});

// ── filterFiles ───────────────────────────────────────────────

test("filterFiles matches case-insensitively anywhere in the path", () => {
  const files = collectPortalFiles(singleFlowNodes());
  expect(filterFiles(files, "stat").map((f) => f.name)).toEqual(["Stat.jsx"]);
  expect(filterFiles(files, "PORTALS/").length).toBe(1);
  expect(filterFiles(files, "  ").length).toBe(files.length);
  expect(filterFiles(files, "nope")).toEqual([]);
});

// ── Symbol scanning (go-to-definition) ────────────────────────

test("topLevelSymbols mirrors the bundler's view of a utility node", () => {
  const code = [
    "const BAY_W = 1.4;",
    "let counter = 0;",
    "var legacy = 1;",
    "function slotKey(a, b) { return a + b; }",
    "async function load() {}",
    "class Rack {}",
    "export const shared = 2;",
    "  function nested() {}", // indented — not top level
  ].join("\n");
  expect([...topLevelSymbols(code)].sort()).toEqual([
    "BAY_W",
    "Rack",
    "counter",
    "legacy",
    "load",
    "shared",
    "slotKey",
  ]);
  expect(declaresSymbol(code, "slotKey")).toBe(true);
  expect(declaresSymbol(code, "nested")).toBe(false);
  expect(declaresSymbol(code, "missing")).toBe(false);
});

test("symbol scanning ignores empty and oversized code", () => {
  expect(topLevelSymbols("").size).toBe(0);
  expect(topLevelSymbols(undefined).size).toBe(0);
  expect(topLevelSymbols("const a = 1;".padEnd(1000001, " ")).size).toBe(0);
});

// ── Icon kinds ────────────────────────────────────────────────

test("icon kind follows the node type, not the extension", () => {
  const files = collectPortalFiles(singleFlowNodes(), { showHead: true });
  const kindOf = (name) => iconKindFor(files.find((f) => f.name === name));

  // The two that matter: both are .jsx, and they must not look alike.
  expect(kindOf("sensors.jsx")).toBe("portal");
  expect(kindOf("Stat.jsx")).toBe("component");

  expect(kindOf("helpers.js")).toBe("utility");
  expect(kindOf("head.html")).toBe("head");
});

test("icon kind degrades instead of throwing on unknown input", () => {
  expect(iconKindFor(null)).toBe("file");
  expect(iconKindFor({ type: "inject" })).toBe("file");
});

// ── Disabled state ────────────────────────────────────────────

test("a disabled node and a disabled flow are told apart", () => {
  const nodes = singleFlowNodes();
  nodes.find((n) => n.id === "c1").d = true; // Stat switched off on its own
  nodes.push({
    id: "c3",
    type: "fc-portal-component",
    z: "flowB",
    compName: "Gauge",
    compCode: "x",
  });

  const files = collectPortalFiles(nodes, {
    flowLabel: (id) => ({ flowA: "Main", flowB: "Lab" })[id],
    flowDisabled: (id) => id === "flowB",
  });
  const byName = (n) => files.find((f) => f.name === n);

  expect(byName("Stat.jsx").disabled).toBe("node");
  expect(byName("Gauge.jsx").disabled).toBe("flow");
  expect(byName("sensors.jsx").disabled).toBe("");
  // A node switched off inside a disabled flow reports its own state first.
  expect(byName("Stat.jsx").flowDisabled).toBe(false);
});

test("nothing is disabled when the caller does not say", () => {
  const files = collectPortalFiles(singleFlowNodes());
  expect(files.every((f) => f.disabled === "")).toBe(true);
});

test("flow folders are marked as flows and carry the flow's disabled state", () => {
  const nodes = singleFlowNodes();
  nodes.push({ id: "u2", type: "fc-portal-utility", z: "flowB", utilName: "anim", utilCode: "x" });
  const tree = buildTree(
    collectPortalFiles(nodes, {
      groupBy: "flow",
      flowLabel: (id) => ({ flowA: "Main", flowB: "Lab" })[id],
      flowDisabled: (id) => id === "flowB",
    }),
  );
  const lab = tree.children.find((c) => c.name === "Lab");
  const main = tree.children.find((c) => c.name === "Main");
  expect(lab).toMatchObject({ kind: "flow", flowId: "flowB", disabled: "flow" });
  expect(main).toMatchObject({ kind: "flow", flowId: "flowA", disabled: "" });
});

test("kind-mode group folders are not flows", () => {
  const nodes = singleFlowNodes();
  nodes.push({ id: "u2", type: "fc-portal-utility", z: "flowB", utilName: "anim", utilCode: "x" });
  const tree = buildTree(
    collectPortalFiles(nodes, { flowLabel: (id) => ({ flowA: "Main", flowB: "Lab" })[id] }),
  );
  const utilities = tree.children.find((c) => c.name === "Utilities");
  expect(utilities.kind).toBe("group");
  // …but the flow folders nested inside them still are.
  expect(utilities.children.map((c) => c.kind)).toEqual(["flow", "flow"]);
});

// ── Ordering ──────────────────────────────────────────────────

test("rows read portal, then components, then utilities — names only break ties", () => {
  const nodes = [
    { id: "c1", type: "fc-portal-component", z: "a", compName: "Zeta", compCode: "x" },
    { id: "u1", type: "fc-portal-utility", z: "a", utilName: "aHelpers", utilCode: "x" },
    { id: "p1", type: "portal-react", z: "a", subPath: "zzz", componentCode: "x" },
    { id: "p2", type: "portal-react", z: "a", subPath: "aaa", componentCode: "x" },
    { id: "c2", type: "fc-portal-component", z: "a", compName: "Alpha", compCode: "x" },
  ];
  const tree = buildTree(collectPortalFiles(nodes, { groupBy: "flow" }));
  expect(tree.children.map((c) => c.name)).toEqual([
    "aaa.jsx",
    "zzz.jsx",
    "Alpha.jsx",
    "Zeta.jsx",
    "aHelpers.js",
  ]);
});

test("kind mode puts the groups in the same order, not alphabetical", () => {
  const nodes = [
    { id: "u1", type: "fc-portal-utility", z: "a", utilName: "h", utilCode: "x" },
    { id: "c1", type: "fc-portal-component", z: "a", compName: "C", compCode: "x" },
    { id: "p1", type: "portal-react", z: "a", subPath: "p", componentCode: "x" },
  ];
  const tree = buildTree(collectPortalFiles(nodes));
  // Alphabetical would have been Components, Portals, Utilities.
  expect(tree.children.map((c) => c.name)).toEqual(["Portals", "Components", "Utilities"]);
});

// ── Default expansion ─────────────────────────────────────────

test("a disabled flow and a portal holding a head start collapsed", () => {
  const nodes = [
    { id: "p", type: "portal-react", z: "a", subPath: "live", componentCode: "x", customHead: "<m>" },
    { id: "c", type: "fc-portal-component", z: "b", compName: "C", compCode: "x" },
  ];
  const tree = buildTree(
    collectPortalFiles(nodes, {
      groupBy: "flow",
      flowLabel: (id) => ({ a: "Live", b: "Off" })[id],
      flowDisabled: (id) => id === "b",
    }),
  );
  const live = tree.children.find((c) => c.name === "Live");
  const off = tree.children.find((c) => c.name === "Off");

  expect(startsCollapsed(off)).toBe(true); // not running — context, not work
  expect(startsCollapsed(live)).toBe(false); // an ordinary folder opens

  const portal = live.children[0];
  expect(isParentFile(portal)).toBe(true);
  expect(startsCollapsed(portal)).toBe(true); // you asked for the portal, not its head
});

test("a portal with nothing hanging off it is not a parent", () => {
  const tree = buildTree(
    collectPortalFiles([
      { id: "p", type: "portal-react", z: "a", subPath: "bare", componentCode: "x" },
    ]),
  );
  const portal = tree.children.find((c) => c.name === "Portals").children[0];
  expect(isParentFile(portal)).toBe(false);
  expect(startsCollapsed(portal)).toBe(false);
});

test("expansion helpers survive junk input", () => {
  expect(isParentFile(null)).toBe(false);
  expect(startsCollapsed(null)).toBe(false);
  expect(startsCollapsed({ type: "dir", children: [] })).toBe(false);
});
