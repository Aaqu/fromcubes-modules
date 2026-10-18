const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerAdminApi } = require("../nodes/lib/admin-api");

// ── Harness ───────────────────────────────────────────────────

let tmpDir;
let app;
let pageState;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "editor-test-")));
  pageState = {};
  const mockRED = {
    httpAdmin: express.Router(),
    httpNode: express.Router(),
    log: { error: () => {}, warn: () => {}, info: () => {} },
    settings: {},
  };
  registerAdminApi(mockRED, {
    express,
    permRead: (_req, _res, next) => next(),
    permWrite: (_req, _res, next) => next(),
    csrfGuard: (_req, _res, next) => next(),
    rateLimit: (_req, _res, next) => next(),
    userDir: tmpDir,
    pageState,
    registry: {},
    utilities: {},
    extractUtilitySymbols: () => new Set(),
  });
  app = express();
  app.use(mockRED.httpNode);
  app.use(mockRED.httpAdmin);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Static editor assets ──────────────────────────────────────

test("serves generated portal CSS only from the public runtime route", async () => {
  pageState["/fromcubes/demo"] = {
    cssHash: "abc123",
    css: ".text-red-500{color:red}",
  };

  const publicCss = await request(app).get("/fromcubes/css/abc123.css");
  expect(publicCss.status).toBe(200);
  expect(publicCss.headers["content-type"]).toMatch(/text\/css/);
  expect(publicCss.headers["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(publicCss.text).toBe(".text-red-500{color:red}");

  const adminCss = await request(app).get("/fromcubes-react/css/abc123.css");
  expect(adminCss.status).toBe(404);
});

test("serves the workspace plugin script", async () => {
  const res = await request(app).get("/fromcubes-react/editor/workspace.js");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toMatch(/javascript/);
  expect(res.text).toContain("fromcubes-react-editor");
});

test("serves the class-completion helper", async () => {
  const res = await request(app).get("/fromcubes-react/editor/class-completion.js");
  expect(res.status).toBe(200);
  expect(res.text).toContain("completionsFromClassList");
});

test("className completion, resolve and hover run on the class-completion helper", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "nodes", "portal-react.html"), "utf8");
  expect(html).toContain("registerHoverProvider(\"javascript\"");
  expect(html).toContain("resolveCompletionItem");
  expect(html).toContain('url: "fromcubes-react/css-describe"');
  expect(html).toContain("window.__fcClassCompletion.TRIGGER_CHARACTERS");
  // no second, hand-rolled matcher beside it
  expect(html).not.toContain("cls.indexOf(word) === 0");
  // diagnostics with quick fixes, and colour squares with the picker
  expect(html).toContain('const CSS_MARKER_OWNER = "tailwindcss"');
  expect(html).toContain("monaco.editor.setModelMarkers(");
  expect(html).toContain('registerCodeActionProvider("javascript"');
  expect(html).toContain('registerColorProvider("javascript"');
  expect(html).toContain("monaco.editor.onDidCreateModel(watchCssModel)");
  // a refetch of the engine data re-checks open models
  expect(html).toContain("if (window.__fcRevalidateCss) window.__fcRevalidateCss();");
});

test("serves the file-tree helper and the stylesheet", async () => {
  const js = await request(app).get("/fromcubes-react/editor/file-tree.js");
  expect(js.status).toBe(200);
  expect(js.text).toContain("collectPortalFiles");

  const css = await request(app).get("/fromcubes-react/editor/workspace.css");
  expect(css.status).toBe(200);
  expect(css.headers["content-type"]).toMatch(/css/);
});

test("serves the bare mark used in the overlay header", async () => {
  const res = await request(app).get("/fromcubes-react/editor/mark.svg");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toMatch(/svg/);
  expect(res.body.toString()).toContain('fill="currentColor"');
});

test("serves the node icon to the editor without hardcoding the package name", async () => {
  const res = await request(app).get("/fromcubes-react/icons/fromcubes-react.svg");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toMatch(/svg/);
});

test("does not expose files above the editor directory", async () => {
  const res = await request(app).get("/fromcubes-react/editor/../portal-react.js");
  expect(res.status).toBe(404);
});

// ── Editor template wiring ────────────────────────────────────

test("workspace registers a status bar button and a per-node entry point", () => {
  const js = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "workspace.js"),
    "utf8",
  );
  expect(js).toContain("RED.statusBar.add(");
  expect(js).toContain("fromcubes-react-editor");
  expect(js).toContain("openNodeFile");
  // The dialog must save itself before the overlay takes over the field.
  expect(js).toContain('$("#node-dialog-ok").trigger("click")');
});

test("the icon sprite ships every symbol the tree asks for", async () => {
  const res = await request(app).get("/fromcubes-react/editor/icons.svg");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toMatch(/svg/);
  const svg = res.body.toString();
  [
    "atom",
    "component",
    "wrench",
    "code-xml",
    "folder",
    "folder-open",
    "workflow",
    "ban",
    "chevron-right",
    "chevron-down",
  ].forEach((name) => expect(svg).toContain('id="fc-icon-' + name + '"'));
  // currentColor is what lets one sprite serve four file colours.
  expect(svg).toContain('stroke="currentColor"');
});

test("the tree degrades to Font Awesome when the sprite never arrives", () => {
  const js = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "workspace.js"),
    "utf8",
  );
  expect(js).toContain("injectIconSprite");
  expect(js).toContain("FA_FALLBACK");
  expect(js).toContain("if (!spriteReady)");
});

test("file colours never reuse the ones that mean changed or broken", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "workspace.css"),
    "utf8",
  );
  ["--portal", "--component", "--utility", "--head"].forEach((k) =>
    expect(css).toContain(".fc-ws-icon" + k),
  );
  // #e2c08d is "changed, not deployed" and #f14c4c is "syntax error"; a file
  // type wearing either would make state unreadable.
  const kindColours = (css.match(/\.fc-ws-icon--\w+ \{\s*color: (#[0-9a-f]{6})/g) || []).join(" ");
  expect(kindColours).not.toContain("#e2c08d");
  expect(kindColours).not.toContain("#f14c4c");
});

test("disabled nodes and flows are shown as such", () => {
  const js = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "workspace.js"),
    "utf8",
  );
  expect(js).toContain("markDisabled");
  expect(js).toContain("flow disabled in Node-RED");
  expect(js).toContain("node disabled in Node-RED");
  // The flow's own disabled flag comes from the workspace, not the node.
  expect(js).toContain("ws.disabled");
});

test("the brand font ships with its licence and is wired up", async () => {
  const res = await request(app).get("/fromcubes-react/editor/ark-pixel.woff2");
  expect(res.status).toBe(200);
  // wOF2 magic — a truncated or LFS-pointer file would still 200.
  expect(res.body.slice(0, 4).toString("latin1")).toBe("wOF2");

  const css = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "workspace.css"),
    "utf8",
  );
  expect(css).toContain('font-family: "Ark Pixel"');
  expect(css).toContain('url("ark-pixel.woff2") format("woff2")');

  // SIL OFL requires the licence to travel with the font.
  const licence = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "ark-pixel.LICENSE.txt"),
    "utf8",
  );
  expect(licence).toContain("SIL OPEN FONT LICENSE");
  const notices = fs.readFileSync(
    path.join(__dirname, "..", "THIRD-PARTY-NOTICES.md"),
    "utf8",
  );
  expect(notices).toContain("Ark Pixel");
  expect(notices).toContain("ark-pixel.LICENSE.txt");
});

test("opening with nothing in mind follows the canvas, portal first", () => {
  const js = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "workspace.js"),
    "utf8",
  );
  expect(js).toContain("openDefaultFile");
  expect(js).toContain("RED.workspaces.active()");
  // Exactly one file opens — the flow's other files stay in the tree.
  // "function close" alone would match closeTab, which sits earlier.
  const body = js.slice(js.indexOf("function openDefaultFile"), js.indexOf("function close()"));
  expect(body.match(/openFile\(/g).length).toBe(2); // the flow's file, or the fallback
  expect(body).toContain("f.flowId === flowId");
});

test("the tree follows the active tab", () => {
  const js = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "workspace.js"),
    "utf8",
  );
  expect(js).toContain("revealActiveInTree");
  // Collapsed ancestors are expanded first — otherwise there is no row to
  // scroll to. Expansion is explicit, because a portal's default is closed.
  expect(js).toContain("collapsed[path] = false");
  // Scrolls only when the row is off-screen, so it never fights the user.
  expect(js).toContain("view.scrollTop -=");
  expect(js).toContain("view.scrollTop +=");
});

test("portal files offer an open-in-browser button, other files do not", () => {
  const js = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "workspace.js"),
    "utf8",
  );
  expect(js).toContain("fc-ws-open-portal");
  // The URL is built from httpNodeRoot + the hardcoded /fromcubes/ prefix.
  expect(js).toContain("RED.settings.httpNodeRoot");
  expect(js).toContain('"/fromcubes/" + subPath');
  // Only portal nodes have an address.
  expect(js).toContain('entry.file.type !== "portal-react"');
  expect(js).toContain('window.open(url, "_blank", "noopener")');
});

test("tree settings live in one localStorage object and default to flow grouping", () => {
  const js = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "workspace.js"),
    "utf8",
  );
  expect(js).toContain('const SETTINGS_KEY = "fcWorkspaceSettings"');
  expect(js).toContain('DEFAULT_SETTINGS = { groupBy: "flow", showHead: true, showJs: true }');
  // One key, read and written in one place.
  expect(js.match(/localStorage\.(getItem|setItem)/g)).toHaveLength(2);
  expect(js).toContain("buildSettingsPanel");
});

test("JSX tag suggestions carry a filterText that includes the bracket", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "nodes", "portal-react.html"), "utf8");
  // Monaco filters each suggestion against the text its range replaces. These
  // ranges swallow the "<", so a bare label is dropped the moment a letter is
  // typed — every item in that provider needs filterText.
  expect(html).toContain("const filterFor = function (label)");
  ["filterFor(tag)", "filterFor(name)", "filterFor(compTyped)"].forEach((call) =>
    expect(html).toContain(call),
  );
  // The Tailwind provider replaces a bare word and must stay untouched.
  const twProvider = html.slice(
    html.indexOf("Tailwind className completion provider"),
    html.indexOf('registerCompletionItemProvider("javascript", {\n        triggerCharacters: ["<"]'),
  );
  expect(twProvider).not.toContain("filterFor(");
});

test("every fromcubes node dialog offers a React Editor button", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "nodes", "portal-react.html"), "utf8");
  ["fc-btn-react-editor", "fcc-btn-react-editor", "fcu-btn-react-editor"].forEach((id) => {
    expect(html).toContain('id="' + id + '"');
    expect(html).toContain('$("#' + id + '").on("click"');
  });
  expect(html).toContain("openNodeFile(node.id, \"compCode\")");
  expect(html).toContain("openNodeFile(node.id, \"utilCode\")");
});

test("Node-RED's toasts are lifted over the overlay, and only while it is open", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "workspace.css"),
    "utf8",
  );
  expect(css).toContain("body.fc-ws-open #red-ui-notifications");
  // An unscoped rule would raise Node-RED's toasts over every other plugin's
  // overlay too — not our call to make.
  const rules = css.match(/^[^{}\n]*#red-ui-notifications[^{}\n]*\{/gm) || [];
  expect(rules).toHaveLength(1);
  expect(rules[0]).toContain("body.fc-ws-open");

  const js = fs.readFileSync(
    path.join(__dirname, "..", "nodes", "editor", "workspace.js"),
    "utf8",
  );
  // The class rides with the overlay's own hidden attribute — one source of
  // truth for "the editor is open".
  const open = js.slice(js.indexOf("function open("), js.indexOf("function close()"));
  const close = js.slice(js.indexOf("function close()"), js.indexOf("function onKeyDown"));
  expect(open).toContain('addClass("fc-ws-open")');
  expect(close).toContain('removeClass("fc-ws-open")');
});

// ── Formatting ────────────────────────────────────────────────

test("serves Prettier's browser builds from node_modules", async () => {
  for (const file of [
    "standalone.js",
    "plugins/babel.js",
    "plugins/estree.js",
    "plugins/html.js",
  ]) {
    const res = await request(app).get("/fromcubes-react/prettier/" + file);
    expect(res.status, file).toBe(200);
    expect(res.headers["content-type"], file).toMatch(/javascript/);
  }
});

test("prettier is a runtime dependency, not a dev one", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  // Users install the node; the editor serves Prettier from their node_modules.
  expect(pkg.dependencies).toHaveProperty("prettier");
  expect(pkg.devDependencies || {}).not.toHaveProperty("prettier");
});

test("formatting stands the TS formatter down only after Prettier loads", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "nodes", "editor", "format.js"), "utf8");
  expect(js).toContain("registerDocumentFormattingEditProvider");
  expect(js).toContain("registerDocumentRangeFormattingEditProvider");
  expect(js).toContain('parser: parser');

  // Monaco already has a TS formatter on `javascript`; two providers means one
  // loses silently. TS steps aside — but inside the success branch, so a failed
  // load leaves the built-in formatter working.
  const success = js.slice(js.indexOf('.then(function () {'), js.indexOf('.catch(function (err) {'));
  expect(success).toContain("documentFormattingEdits: false");
  expect(success).toContain("documentRangeFormattingEdits: false");
  expect(js.slice(js.indexOf(".catch(function (err) {"))).not.toContain("documentFormattingEdits");

  // Half-written code is normal in an editor: say why, do not silently no-op.
  expect(js).toContain("reportParseError");
  expect(js).toContain("Cannot format");
});

test("the editor template loads the formatting plugin", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "nodes", "portal-react.html"), "utf8");
  expect(html).toContain('"format.js"');
});

// ── Node icon ─────────────────────────────────────────────────

test.each([
  ["fromcubes-react.svg", "atom", "M20.2 20.2c"],
  ["fromcubes-component.svg", "component", "M15.536 11.293a"],
  ["fromcubes-utility.svg", "wrench", "M14.7 6.3a"],
])("%s is the masked fromcubes mark plus the Lucide %s badge", (file, lucide, marker) => {
  const svg = fs.readFileSync(path.join(__dirname, "..", "nodes", "icons", file), "utf8");
  expect(svg).toMatch(/<svg[^>]*viewBox="0 0 44 60"/);
  // The badge is knocked out of the mark, not painted over it — so it appears
  // twice: once as the mask's thick stroke, once as the visible badge.
  expect(svg).toContain('mask="url(#fc-cut)"');
  expect(svg).toContain('<mask id="fc-cut"');
  expect(svg.split(marker)).toHaveLength(3);
  expect(svg).toContain('"' + lucide + '" icon from Lucide');
});

test("each node type wears its own badge", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "nodes", "portal-react.html"), "utf8");
  const iconOf = (type) => {
    const at = html.indexOf('registerType("' + type + '"');
    expect(at).toBeGreaterThan(-1);
    return (html.slice(at).match(/icon: "([^"]+)"/) || [])[1];
  };
  expect(iconOf("portal-react")).toBe("fromcubes-react.svg");
  expect(iconOf("fc-portal-component")).toBe("fromcubes-component.svg");
  expect(iconOf("fc-portal-utility")).toBe("fromcubes-utility.svg");
  expect(html).not.toContain("font-awesome/fa-");
});

test("the Lucide notice ships with the package", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  expect(pkg.files).toContain("THIRD-PARTY-NOTICES.md");
  const notices = fs.readFileSync(
    path.join(__dirname, "..", "THIRD-PARTY-NOTICES.md"),
    "utf8",
  );
  expect(notices).toContain("ISC License");
  expect(notices).toContain("nodes/icons/");
  ["atom", "component", "wrench"].forEach((n) => expect(notices).toContain(n));
});

test("portal-react.html loads both editor scripts and the stylesheet", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "nodes", "portal-react.html"), "utf8");
  expect(html).toContain('["file-tree.js", "class-completion.js", "workspace.js", "format.js", "provider-settings.js"]');
  expect(html).toContain('base + "editor/workspace.css"');
  // In order: workspace.js needs file-tree.js, and dynamic scripts run as they
  // finish unless told otherwise.
  expect(html).toContain("s.async = false");
  // The overlay reuses the dialog's registry-name cache refresher.
  expect(html).toContain("window.__fcRefreshComponentNames = refreshComponentNames");
});

// ── Versioned asset path ──────────────────────────────────────

test("editor assets are also served under the core's version", async () => {
  const { ASSET_BASE } = require("../nodes/lib/admin-api");
  const { version } = require("../package.json");
  expect(ASSET_BASE).toBe("fromcubes-react/" + version + "/");
  for (const p of [
    "editor/file-tree.js",
    "editor/workspace.js",
    "editor/workspace.css",
    "icons/fromcubes-react.svg",
    "vs/loader.js",
    "prettier/standalone.js",
  ]) {
    const res = await request(app).get("/" + ASSET_BASE + p);
    expect(res.status, p).toBe(200);
  }
});

test("no editor asset is loaded from an unversioned path", () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "nodes", ...p), "utf8");
  // Literal "fromcubes-react/<static dir>" only as the fallback base.
  const hard = /["']fromcubes-react\/(editor|icons|vs|prettier)\b/;
  for (const f of [["portal-react.html"], ["editor", "workspace.js"], ["editor", "format.js"]]) {
    expect(read(...f), f.join("/")).not.toMatch(hard);
  }
  expect(read("portal-react.js")).toContain("portalReactAssetBase: { value: ASSET_BASE, exportable: true }");
});

// ── Settings → Fromcubes (provider choice) ────────────────────

test("serves the provider settings pane and portal-react.html loads it", async () => {
  const res = await request(app).get("/fromcubes-react/editor/provider-settings.js");
  expect(res.status).toBe(200);
  expect(res.text).toContain("RED.userSettings.add");
  // Node-RED shows a settings pane by this exact element id.
  expect(res.text).toContain('"red-ui-settings-tab-" + PANE_ID');
  expect(res.text).toContain('"fromcubes-react/providers"');

  const html = fs.readFileSync(path.join(__dirname, "..", "nodes", "portal-react.html"), "utf8");
  expect(html).toContain('"provider-settings.js"');
});

test("portal page reloads on the server's identity-change frame", () => {
  const { buildPage } = require("../nodes/lib/page-builder");
  const html = buildPage("T", "", "/fromcubes/x/_ws", "", "", null, false, "");
  expect(html).toMatch(/m\.type === 'reload'\)\s*\{\s*(\/\/[^\n]*\n\s*)*location\.reload\(\)/);
});

test("className completion loads from the engine-aware endpoint everywhere", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "nodes", "portal-react.html"), "utf8");
  const ws = fs.readFileSync(path.join(__dirname, "..", "nodes", "editor", "workspace.js"), "utf8");
  const pane = fs.readFileSync(path.join(__dirname, "..", "nodes", "editor", "provider-settings.js"), "utf8");
  for (const src of [html, ws]) {
    expect(src).not.toContain("tw-classes");
    expect(src).not.toContain("__fcTwClasses");
  }
  expect(html).toContain('$.getJSON("fromcubes-react/css-classes"');
  // portal, component and utility dialogs each refresh on open
  expect(html.match(/window\.__fcRefreshCssClasses\(\);/g)).toHaveLength(3);
  expect(ws).toContain("window.__fcRefreshCssClasses()");
  expect(pane).toContain("window.__fcRefreshCssClasses()");
});
