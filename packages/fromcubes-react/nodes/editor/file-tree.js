/**
 * Portal Code Workspace — pure file-tree layer.
 *
 * Maps Node-RED editor node objects (`portal-react`, `fc-portal-component`,
 * `fc-portal-utility`) onto a virtual file listing, then folds that flat
 * listing into a nested tree. No DOM, no jQuery, no `RED` access — the whole
 * module is a pair of pure functions so it can be unit-tested under vitest and
 * still be loaded as a plain browser script by the Node-RED editor.
 *
 * Loaded in the browser by the asset loader in portal-react.html (`<base>/editor/file-tree.js`)
 * (exposes `window.__fcFileTree`) and in tests via `require()`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.__fcFileTree = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Matches lib/registry-nodes.js — oversized code is not scanned. */
  const MAX_UTIL_CODE_BYTES = 1000000;

  const GROUP_PORTALS = "Portals";
  const GROUP_COMPONENTS = "Components";
  const GROUP_UTILITIES = "Utilities";

  /** Fixed group ordering — mirrors bundle order (utilities → components → portal). */
  const GROUP_ORDER = [GROUP_PORTALS, GROUP_COMPONENTS, GROUP_UTILITIES];

  /**
   * Per-node-type description of which config fields are editable "files".
   *
   * `file` is a fixed name; without it the file is named after the node's
   * registered name plus `ext`. `optional: true` fields are hidden while empty
   * unless `showHead` is set. `under: true` nests the file beneath the node's
   * primary file instead of beside it.
   */
  const FIELD_MAP = {
    "portal-react": {
      group: GROUP_PORTALS,
      nameField: "subPath",
      files: [
        // The portal reads as one file named after its sub-path; its custom
        // <head> hangs off that file rather than forcing a folder around a
        // pair, so a portal costs one row until you ask for the second.
        { field: "componentCode", ext: "jsx", lang: "javascript" },
        {
          field: "customHead",
          file: "head.html",
          lang: "html",
          optional: true,
          under: true,
        },
      ],
    },
    "fc-portal-component": {
      group: GROUP_COMPONENTS,
      nameField: "compName",
      files: [{ field: "compCode", ext: "jsx", lang: "javascript" }],
    },
    "fc-portal-utility": {
      group: GROUP_UTILITIES,
      nameField: "utilName",
      files: [{ field: "utilCode", ext: "js", lang: "javascript" }],
    },
  };

  /**
   * True when the node type owns portal-react source code.
   * @param {string} type
   * @returns {boolean}
   */
  function isPortalNodeType(type) {
    return Object.prototype.hasOwnProperty.call(FIELD_MAP, type);
  }

  /**
   * Display name for a node: its registered name (subPath / compName /
   * utilName), falling back to the canvas label and finally the node id, so a
   * half-configured node still shows up in the tree instead of vanishing.
   *
   * @param {Object} node
   * @param {string} nameField
   * @returns {string}
   */
  function displayName(node, nameField) {
    const registered = (node[nameField] || "").trim();
    if (registered) return registered;
    const label = (node.name || "").trim();
    if (label) return label;
    return node.id;
  }

  /**
   * Flatten editor nodes into virtual files.
   *
   * Two layouts, both keeping the flow level only where it disambiguates:
   *   - `groupBy: "kind"` → `Utilities/<flow>/<name>.js`. Kind first, so all
   *     utilities sit in one folder however many flow tabs there are.
   *   - `groupBy: "flow"` → `<flow>/<name>.js`, mirroring the canvas: one flat
   *     alphabetical list per tab. No kind level — inside a flow the extension
   *     already says what a file is, and a folder per kind holding one file is
   *     noise. Portals keep their own folder, since a portal owns two files.
   *
   * @param {Array<Object>} nodes Plain node objects from `RED.nodes.eachNode`.
   * @param {Object} [opts]
   * @param {(flowId: string) => string} [opts.flowLabel] Resolves a flow tab id
   *   to its label. Only consulted when a level actually spans several flows.
   * @param {boolean} [opts.showHead] Include empty `head.html` files.
   * @param {"kind"|"flow"} [opts.groupBy] Layout, default `"kind"`.
   * @param {(flowId: string) => boolean} [opts.flowDisabled] Is that flow tab
   *   disabled? Files inherit it, since a disabled tab takes its nodes with it.
   * @returns {Array<Object>} File descriptors, sorted by group then path.
   */
  function collectPortalFiles(nodes, opts) {
    const options = opts || {};
    const byFlow = options.groupBy === "flow";
    const list = [];
    const allFlows = new Set();
    const flowsPerGroup = {};

    (nodes || []).forEach(function (node) {
      if (!node || !isPortalNodeType(node.type)) return;
      const flowId = node.z || "";
      allFlows.add(flowId);
      const group = FIELD_MAP[node.type].group;
      (flowsPerGroup[group] = flowsPerGroup[group] || new Set()).add(flowId);
    });

    const labelOf =
      options.flowLabel ||
      function (id) {
        return id || "Flow";
      };
    const flowOff = options.flowDisabled || function () {
      return false;
    };

    (nodes || []).forEach(function (node) {
      if (!node || !isPortalNodeType(node.type)) return;
      const spec = FIELD_MAP[node.type];
      const name = displayName(node, spec.nameField);
      // Only pay for a flow level when it separates something: the whole tree
      // for flow-first, this one group for kind-first.
      const scope = byFlow ? allFlows : flowsPerGroup[spec.group];
      const flowLevel = scope.size > 1 ? labelOf(node.z || "") || "Flow" : null;
      // A node can be disabled on its own, or ride a disabled flow tab down
      // with it. Both mean "this code is not running"; the tree says which.
      const flowIsOff = flowOff(node.z || "");
      const disabled = node.d ? "node" : flowIsOff ? "flow" : "";

      const primaryName = name + "." + (spec.files[0].ext || "jsx");

      spec.files.forEach(function (f) {
        const value = node[f.field];
        if (f.optional && !options.showHead && !(value || "").trim()) return;

        const fileName = f.file || name + "." + f.ext;
        const segments = [];
        if (byFlow) {
          if (flowLevel) segments.push(flowLevel);
        } else {
          segments.push(spec.group);
          if (flowLevel) segments.push(flowLevel);
        }
        if (f.under) segments.push(primaryName);
        segments.push(fileName);

        list.push({
          key: node.id + ":" + f.field,
          nodeId: node.id,
          type: node.type,
          field: f.field,
          lang: f.lang,
          name: fileName,
          registryName: node.type === "portal-react" ? null : name,
          group: spec.group,
          groupIndex: GROUP_ORDER.indexOf(spec.group),
          flowId: node.z || "",
          flowDisabled: flowIsOff,
          disabled: disabled,
          // Which segment is the flow tab, so the tree can badge that folder
          // as a flow rather than a plain directory.
          flowSegment: flowLevel ? (byFlow ? 0 : 1) : -1,
          segments: segments,
          path: segments.join("/"),
        });
      });
    });

    list.sort(function (a, b) {
      // Kind leads — portals, then components, then utilities: how the bundle
      // is assembled, and how you read a portal (the page first, then what it
      // is built from). Which level the kind sits at differs per layout, so the
      // comparison follows the segment order the layout actually produced.
      const dirOf = (f) => f.segments.slice(0, -1).join("/");
      const byName = () => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      const byDir = () => dirOf(a).localeCompare(dirOf(b), undefined, { sensitivity: "base" });
      if (byFlow) {
        if (dirOf(a) !== dirOf(b)) return byDir();
        if (a.groupIndex !== b.groupIndex) return a.groupIndex - b.groupIndex;
        return byName();
      }
      if (a.groupIndex !== b.groupIndex) return a.groupIndex - b.groupIndex;
      if (dirOf(a) !== dirOf(b)) return byDir();
      return byName();
    });
    return list;
  }

  /**
   * Fold a flat file listing into a nested directory tree.
   *
   * @param {Array<Object>} files Output of {@link collectPortalFiles}.
   * @returns {{name: string, path: string, type: string, children: Array}}
   *   Synthetic root node; directories sort before files, both alphabetically.
   */
  function buildTree(files) {
    const root = { name: "", path: "", type: "dir", children: [], index: {} };

    (files || []).forEach(function (file) {
      let cursor = root;
      const dirs = file.segments.slice(0, -1);
      dirs.forEach(function (seg, i) {
        let child = cursor.index[seg];
        if (!child) {
          const isFlowDir = i === file.flowSegment;
          child = {
            name: seg,
            // Group folders sort by kind like their files do; flow folders
            // have no kind of their own and fall back to their name.
            order: isFlowDir ? null : GROUP_ORDER.indexOf(seg),
            path: file.segments.slice(0, i + 1).join("/"),
            type: "dir",
            kind: isFlowDir ? "flow" : "group",
            flowId: isFlowDir ? file.flowId : null,
            disabled: isFlowDir && file.flowDisabled ? "flow" : "",
            children: [],
            index: {},
          };
          cursor.index[seg] = child;
          cursor.children.push(child);
        }
        cursor = child;
      });
      // A path can be both a file and a parent — a portal's own `.jsx` holds
      // its `head.html`. Whichever arrives second merges into the first.
      const existing = cursor.index[file.name];
      if (existing) {
        existing.file = file;
        return;
      }
      const leaf = {
        name: file.name,
        path: file.path,
        order: file.groupIndex,
        type: "file",
        file: file,
        children: [],
        index: {},
      };
      cursor.index[file.name] = leaf;
      cursor.children.push(leaf);
    });

    sortTree(root);
    return root;
  }

  /**
   * In-place recursive sort: directories first, then case-insensitive by name.
   * Also drops the `index` lookup maps used while building.
   *
   * @param {Object} dir
   * @returns {void}
   */
  function sortTree(dir) {
    delete dir.index;
    if (!dir.children) return;
    dir.children.sort(function (a, b) {
      // Kind order first where both siblings have one — that is what puts
      // portals above components above utilities inside a flow.
      const ka = typeof a.order === "number" && a.order >= 0 ? a.order : null;
      const kb = typeof b.order === "number" && b.order >= 0 ? b.order : null;
      if (ka !== null && kb !== null && ka !== kb) return ka - kb;
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    dir.children.forEach(sortTree);
  }

  /**
   * A file that also holds files — a portal's `.jsx` owning its `head.html`.
   * @param {Object} node A tree node from {@link buildTree}.
   * @returns {boolean}
   */
  function isParentFile(node) {
    return !!(node && node.file && node.children && node.children.length);
  }

  /**
   * Does this node start closed?
   *
   * Folders open by default, because that is what a tree is for. Two things
   * earn the opposite: a file holding files (you asked for the portal, not its
   * `head.html`) and a flow Node-RED is not running (it is context, not work).
   *
   * @param {Object} node A tree node from {@link buildTree}.
   * @returns {boolean}
   */
  function startsCollapsed(node) {
    if (!node) return false;
    return isParentFile(node) || node.disabled === "flow";
  }

  /**
   * Which kind of thing a file is, for icon and colour purposes.
   *
   * Decided by node type and field, never by extension: a portal and a
   * component are both `.jsx`, and they are exactly the two the tree most
   * needs to tell apart.
   *
   * @param {Object} file A descriptor from {@link collectPortalFiles}.
   * @returns {"portal"|"component"|"utility"|"head"|"file"}
   */
  function iconKindFor(file) {
    if (!file) return "file";
    if (file.type === "portal-react") {
      return file.field === "customHead" ? "head" : "portal";
    }
    if (file.type === "fc-portal-component") return "component";
    if (file.type === "fc-portal-utility") return "utility";
    return "file";
  }

  /**
   * Top-level `function`/`const`/`let`/`var`/`class` names in utility code.
   *
   * Client mirror of `extractUtilitySymbols` in lib/registry-nodes.js — same
   * anchored regex, so what the editor treats as a utility's exported name
   * matches what the bundler injects. Kept here (pure) so it is testable, and
   * kept as a scan so it still answers for half-written code. Multi-declarator
   * statements are not followed; the caller falls back to a plain reference
   * search, which costs at worst a jump to the wrong line of the right file.
   *
   * @param {string} code
   * @returns {Set<string>}
   */
  function topLevelSymbols(code) {
    const names = new Set();
    if (!code || code.length > MAX_UTIL_CODE_BYTES) return names;
    const re = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(code))) names.add(m[1]);
    return names;
  }

  /**
   * Does this utility code declare `name` at its top level?
   * @param {string} code
   * @param {string} name
   * @returns {boolean}
   */
  function declaresSymbol(code, name) {
    return topLevelSymbols(code).has(name);
  }

  /**
   * Case-insensitive substring filter over full paths.
   *
   * @param {Array<Object>} files
   * @param {string} query
   * @returns {Array<Object>}
   */
  function filterFiles(files, query) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return files || [];
    return (files || []).filter(function (f) {
      return f.path.toLowerCase().indexOf(q) !== -1;
    });
  }

  return {
    GROUP_PORTALS: GROUP_PORTALS,
    GROUP_COMPONENTS: GROUP_COMPONENTS,
    GROUP_UTILITIES: GROUP_UTILITIES,
    GROUP_ORDER: GROUP_ORDER,
    FIELD_MAP: FIELD_MAP,
    isPortalNodeType: isPortalNodeType,
    displayName: displayName,
    isParentFile: isParentFile,
    startsCollapsed: startsCollapsed,
    iconKindFor: iconKindFor,
    topLevelSymbols: topLevelSymbols,
    declaresSymbol: declaresSymbol,
    collectPortalFiles: collectPortalFiles,
    buildTree: buildTree,
    filterFiles: filterFiles,
  };
});
