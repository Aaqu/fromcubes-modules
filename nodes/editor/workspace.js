/**
 * React Editor — Node-RED editor plugin.
 *
 * Adds a button to Node-RED's bottom status bar that opens a full-screen
 * overlay presenting every portal-react source field as a file: tree on the
 * left, one Monaco instance on the right, tabs across the top. Each fromcubes
 * node's edit dialog hands off to the same overlay.
 *
 * Source of truth is the editor's own node objects (`RED.nodes`), exactly like
 * a node's `oneditsave` — edits are written straight onto the node, which arms
 * the Deploy button. Nothing here talks to the server for writes: the registry
 * REST endpoints are deprecated (410) and `RED.settings.portalReact*` is
 * rebuilt from node config on every deploy anyway.
 */
(function () {
  "use strict";

  const PREFIX = "[FC-Workspace]";
  const EDITOR_NAME = "React Editor";
  const FLUSH_DEBOUNCE_MS = 400;
  const MIN_TREE_WIDTH = 150;

  // ── Module state ────────────────────────────────────────────

  /** @type {Object} pure tree helpers from file-tree.js */
  let FT = null;

  let overlay = null;
  let treeEl = null;
  let tabsEl = null;
  let monacoHost = null;
  let fallbackEl = null;
  let placeholderEl = null;
  let statusEl = null;
  let openPortalBtn = null;
  let deployBtn = null;
  let filterEl = null;
  let settingsPanel = null;
  let gearEl = null;

  let editor = null;
  let monacoReady = false;
  let monacoFailed = false;

  /** key → { file, model, viewState, lastSynced } */
  const entries = {};
  /** ordered list of open file keys */
  const openKeys = [];
  let activeKey = null;

  /** dir path → true when collapsed */
  const collapsed = {};
  /** current flat file listing */
  let files = [];
  /** registryName → error string, from the read-only admin API */
  let compErrors = {};
  let utilErrors = {};

  /**
   * Everything the settings panel owns, persisted as one object so adding a
   * setting later doesn't mean another localStorage key to migrate.
   * `groupBy`: "flow" mirrors the canvas (each tab holds its own three kinds,
   * alphabetical); "kind" hoists Portals/Components/Utilities to the top.
   */
  const DEFAULT_SETTINGS = { groupBy: "flow", showHead: true, showJs: true };
  const SETTINGS_KEY = "fcWorkspaceSettings";
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let filterText = "";
  let flushTimers = {};
  /** guards our own RED.events emissions from bouncing back in */
  let selfEmitting = false;
  let treeWidth = 260;
  let resyncTimer = null;
  /** true once the Lucide sprite is in the DOM; false means Font Awesome */
  let spriteReady = false;
  /** flow-tab label → how many tabs carry it */
  let labelCounts = {};

  // ── Data collection ─────────────────────────────────────────

  /**
   * Human label for a flow tab (or subflow) id.
   * @param {string} id
   * @returns {string}
   */
  function flowLabel(id) {
    const ws = RED.nodes.workspace(id);
    let label;
    if (ws) {
      label = ws.label || id;
    } else {
      const sf = RED.nodes.subflow ? RED.nodes.subflow(id) : null;
      label = sf ? "Subflow: " + (sf.name || id) : id;
    }
    // Two tabs may carry the same label — without a suffix their folders would
    // merge into one and look like duplicated files.
    if (labelCounts[label] > 1) label += " #" + String(id).slice(0, 6);
    return label;
  }

  /**
   * Count flow-tab labels so {@link flowLabel} can disambiguate collisions.
   * @returns {void}
   */
  function countFlowLabels() {
    labelCounts = {};
    RED.nodes.eachWorkspace(function (ws) {
      const label = ws.label || ws.id;
      labelCounts[label] = (labelCounts[label] || 0) + 1;
    });
  }

  /**
   * Rebuild the flat file listing from the current flows.
   * @returns {void}
   */
  function collect() {
    countFlowLabels();
    const nodes = [];
    RED.nodes.eachNode(function (n) {
      if (FT.isPortalNodeType(n.type)) nodes.push(n);
    });
    files = FT.collectPortalFiles(nodes, {
      flowLabel: flowLabel,
      showHead: settings.showHead,
      groupBy: settings.groupBy,
      flowDisabled: function (id) {
        const ws = RED.nodes.workspace(id);
        return !!(ws && ws.disabled);
      },
    });
    if (!settings.showJs) {
      files = files.filter(function (f) {
        return !/\.js$/.test(f.name);
      });
    }
    // Open tabs track renames/subPath changes; drop tabs whose node is gone.
    const byKey = {};
    files.forEach(function (f) {
      byKey[f.key] = f;
    });
    openKeys.slice().forEach(function (key) {
      if (byKey[key]) {
        if (entries[key]) entries[key].file = byKey[key];
      } else if (!RED.nodes.node(key.split(":")[0])) {
        closeTab(key, true);
      }
    });
  }

  /**
   * Refresh syntax-error markers from the read-only admin endpoints.
   * @param {Function} [done]
   * @returns {void}
   */
  function refreshErrors(done) {
    let pending = 2;
    const settle = function () {
      if (--pending === 0 && done) done();
    };
    $.getJSON("portal-react/registry", function (reg) {
      compErrors = {};
      Object.keys(reg || {}).forEach(function (n) {
        if (reg[n] && reg[n].error) compErrors[n] = reg[n].error;
      });
    })
      .fail(function () {
        compErrors = {};
      })
      .always(settle);
    $.getJSON("portal-react/utilities", function (reg) {
      utilErrors = {};
      Object.keys(reg || {}).forEach(function (n) {
        if (reg[n] && reg[n].error) utilErrors[n] = reg[n].error;
      });
    })
      .fail(function () {
        utilErrors = {};
      })
      .always(settle);
  }

  /**
   * Error text for a file, or "" when the file's node built cleanly.
   * @param {Object} file
   * @returns {string}
   */
  function errorFor(file) {
    if (!file.registryName) return "";
    if (file.type === "fc-portal-component") return compErrors[file.registryName] || "";
    if (file.type === "fc-portal-utility") return utilErrors[file.registryName] || "";
    return "";
  }

  /**
   * True when the file has edits that are not deployed yet — either written to
   * the node but not deployed (`node.changed`), or still sitting in the model.
   * @param {Object} file
   * @returns {boolean}
   */
  function isDirty(file) {
    const node = RED.nodes.node(file.nodeId);
    if (!node) return false;
    if (node.changed) return true;
    const entry = entries[file.key];
    return !!(entry && currentValue(entry) !== (node[file.field] || ""));
  }

  /**
   * Current editor-side text for an open file (Monaco model or textarea).
   * @param {Object} entry
   * @returns {string}
   */
  function currentValue(entry) {
    if (entry.model && !entry.model.isDisposed()) return entry.model.getValue();
    if (monacoFailed && activeKey === entry.file.key && fallbackEl) {
      return fallbackEl.value;
    }
    return entry.lastSynced;
  }

  // ── Write-back into the flow ────────────────────────────────

  /**
   * Push the editor content of one open file onto its node, arming Deploy.
   * Mirrors what a node dialog's `oneditsave` does, plus a history entry so
   * Node-RED's Ctrl+Z undoes workspace edits too.
   *
   * @param {string} key
   * @returns {boolean} true when the node was actually modified
   */
  function flush(key) {
    const entry = entries[key];
    if (!entry) return false;
    clearTimeout(flushTimers[key]);
    delete flushTimers[key];

    const file = entry.file;
    const node = RED.nodes.node(file.nodeId);
    if (!node) return false;

    const value = currentValue(entry);
    const oldValue = node[file.field] || "";
    entry.lastSynced = value;
    if (oldValue === value) return false;

    const wasDirty = RED.nodes.dirty();
    const wasChanged = node.changed;
    node[file.field] = value;
    node.changed = true;
    node.dirty = true;
    RED.nodes.dirty(true);

    try {
      RED.history.push({
        t: "edit",
        node: node,
        changes: (function () {
          const c = {};
          c[file.field] = oldValue;
          return c;
        })(),
        dirty: wasDirty,
        changed: wasChanged,
      });
    } catch (err) {
      console.warn(PREFIX, "history push failed", err);
    }

    selfEmitting = true;
    try {
      RED.events.emit("nodes:change", node);
      if (RED.view && RED.view.redraw) RED.view.redraw();
    } finally {
      selfEmitting = false;
    }
    return true;
  }

  /**
   * Flush every open file.
   * @returns {void}
   */
  function flushAll() {
    openKeys.slice().forEach(flush);
    renderAll();
  }

  /**
   * Debounced flush triggered by model edits.
   * @param {string} key
   * @returns {void}
   */
  function scheduleFlush(key) {
    clearTimeout(flushTimers[key]);
    flushTimers[key] = setTimeout(function () {
      flush(key);
      renderAll();
    }, FLUSH_DEBOUNCE_MS);
    markTabDirty(key);
  }

  // ── Monaco models ───────────────────────────────────────────

  /**
   * File extension → Monaco URI suffix.
   * @param {Object} file
   * @returns {string}
   */
  function extOf(file) {
    const dot = file.name.lastIndexOf(".");
    return dot === -1 ? "txt" : file.name.slice(dot + 1);
  }

  /**
   * True when a model is gone — either never created or disposed under us.
   * Node-RED disposes every leftover Monaco model on its `editor:close` event
   * ("Cleaning up monaco models left behind"), so closing any node dialog kills
   * the workspace models too. They are rebuilt on demand from the node.
   *
   * @param {Object} entry
   * @returns {boolean}
   */
  function modelGone(entry) {
    return !entry.model || entry.model.isDisposed();
  }

  /**
   * Create the Monaco model backing one file. Workspace models live in their
   * own `fc-ws-` URI namespace so they never collide with — or dispose — the
   * models a node's edit dialog creates.
   *
   * @param {Object} file
   * @param {string} value
   * @returns {Object} Monaco model
   */
  function createModel(file, value) {
    const uri = monaco.Uri.parse(
      "file:///fc-ws-" + file.nodeId + "-" + file.field + "." + extOf(file),
    );
    const stale = monaco.editor.getModel(uri);
    if (stale) stale.dispose();
    const model = monaco.editor.createModel(value, file.lang, uri);
    model.onDidChangeContent(function () {
      scheduleFlush(file.key);
    });
    return model;
  }

  /**
   * Get (or lazily create) the model entry for a file, re-creating a model that
   * was disposed while the overlay was closed.
   *
   * @param {Object} file
   * @returns {Object} entry
   */
  function ensureEntry(file) {
    let entry = entries[file.key];
    const node = RED.nodes.node(file.nodeId);
    const value = node ? node[file.field] || "" : "";

    if (!entry) {
      entry = { file: file, model: null, viewState: null, lastSynced: value };
      entries[file.key] = entry;
    }
    entry.file = file;

    if (monacoReady && modelGone(entry)) {
      // The node is authoritative here: edits are flushed before the overlay
      // closes, so a disposed model can never hold newer text.
      entry.lastSynced = value;
      entry.viewState = null;
      entry.model = createModel(file, value);
    }
    return entry;
  }

  // ── Go to definition ────────────────────────────────────────

  /**
   * Where a top-level `name` is declared in `code`.
   *
   * Deliberately a scan, not a parse: the editor has to answer while the user
   * is still typing, against code that may not even be valid yet. A missed
   * declaration costs one failed jump; a parser would cost every jump in a
   * half-written file.
   *
   * @param {string} code
   * @param {string} name
   * @returns {{lineNumber: number, column: number}|null}
   */
  function findDeclaration(code, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      // `function Foo(`, `const Foo =`, `class Foo`, with export/async prefixes
      new RegExp(
        "(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?" +
          "(?:function\\*?|const|let|var|class)\\s+" +
          escaped +
          "(?![\\w$])",
      ),
      // second and later declarators: `const a = 1, Foo = 2`
      new RegExp("(?:^|[,({\\s])" + escaped + "\\s*[=:]"),
      // last resort: the first mention at all
      new RegExp("(?<![\\w$])" + escaped + "(?![\\w$])"),
    ];
    for (const re of patterns) {
      const m = re.exec(code);
      if (!m) continue;
      const at = m.index + m[0].indexOf(name);
      const before = code.slice(0, at);
      const line = before.split("\n").length;
      return { lineNumber: line, column: at - before.lastIndexOf("\n") };
    }
    return null;
  }

  /**
   * Resolve an identifier to the fromcubes node that declares it: a component
   * by its JSX tag, or a utility by any symbol declared at its top level.
   *
   * Resolution runs off `RED.nodes`, not the server registry, so a component
   * renamed or a helper added since the last deploy is already navigable.
   *
   * @param {string} name
   * @returns {{key: string, position: Object}|null}
   */
  function resolveDefinition(name) {
    if (!name) return null;
    let hit = null;
    RED.nodes.eachNode(function (n) {
      if (hit) return;
      if (n.type === "fc-portal-component") {
        if ((n.compName || "").trim() !== name) return;
        hit = {
          key: n.id + ":compCode",
          position: findDeclaration(n.compCode || "", name) || { lineNumber: 1, column: 1 },
        };
      } else if (n.type === "fc-portal-utility") {
        const code = n.utilCode || "";
        if (!FT.declaresSymbol(code, name)) return;
        hit = {
          key: n.id + ":utilCode",
          position: findDeclaration(code, name) || { lineNumber: 1, column: 1 },
        };
      }
    });
    return hit;
  }

  /**
   * Jump to the definition of the identifier at `position`, falling back to
   * Monaco's own in-file navigation when the name belongs to neither a
   * component nor a utility.
   *
   * @param {Object} position Monaco position
   * @returns {boolean} true when a fromcubes definition was opened
   */
  function gotoDefinition(position) {
    if (!editor || !position) return false;
    const model = editor.getModel();
    if (!model) return false;
    const word = model.getWordAtPosition(position);
    const target = word && resolveDefinition(word.word);
    if (!target) {
      const action = editor.getAction("editor.action.revealDefinition");
      if (action) action.run();
      return false;
    }
    if (target.key === activeKey) {
      editor.setPosition(target.position);
      editor.revealPositionInCenter(target.position);
      return true;
    }
    openFile(target.key, target.position);
    return true;
  }

  // ── Tabs ────────────────────────────────────────────────────

  /**
   * Open a file in the editor pane, creating its tab if needed.
   * @param {string} key
   * @returns {void}
   */
  function openFile(key, position) {
    const file = files.filter(function (f) {
      return f.key === key;
    })[0];
    if (!file) return;
    ensureEntry(file);
    if (openKeys.indexOf(key) === -1) openKeys.push(key);
    setActive(key);
    if (position && editor) {
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      editor.focus();
    }
  }

  /**
   * Make one open file the visible one, preserving per-file cursor/scroll.
   * @param {string} key
   * @returns {void}
   */
  function setActive(key) {
    if (activeKey && activeKey !== key) {
      const prev = entries[activeKey];
      if (prev) {
        if (editor && !modelGone(prev)) prev.viewState = editor.saveViewState();
        flush(activeKey);
      }
    }
    activeKey = key;
    let entry = entries[key];
    if (!entry) return;
    // Re-create the model if a node dialog's close disposed it.
    entry = ensureEntry(entry.file);

    if (editor && !modelGone(entry)) {
      editor.setModel(entry.model);
      if (entry.viewState) editor.restoreViewState(entry.viewState);
      editor.focus();
    } else if (monacoFailed && fallbackEl) {
      fallbackEl.value = entry.lastSynced;
    }
    updatePaneVisibility();
    renderAll();
    revealActiveInTree();
  }

  /**
   * Close a tab (flushing first unless the node disappeared).
   * @param {string} key
   * @param {boolean} [gone] node no longer exists — skip the flush
   * @returns {void}
   */
  function closeTab(key, gone) {
    if (!gone) flush(key);
    const i = openKeys.indexOf(key);
    if (i !== -1) openKeys.splice(i, 1);
    const entry = entries[key];
    if (entry && !modelGone(entry)) entry.model.dispose();
    delete entries[key];
    if (activeKey === key) {
      activeKey = null;
      if (editor) editor.setModel(null);
      const next = openKeys[Math.max(0, i - 1)];
      if (next) setActive(next);
    }
    updatePaneVisibility();
    renderTabs();
    renderTree();
  }

  /**
   * Toggle the dirty dot on a tab without a full re-render (fires per keystroke).
   * @param {string} key
   * @returns {void}
   */
  function markTabDirty(key) {
    if (!tabsEl) return;
    tabsEl.find('[data-key="' + cssEscape(key) + '"]').addClass("fc-ws-tab-dirty");
    updateStatus();
  }

  // ── Rendering ───────────────────────────────────────────────

  /**
   * Escape a key for use inside an attribute selector.
   * @param {string} s
   * @returns {string}
   */
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  /** @see FT.isParentFile */
  function isParentFile(n) {
    return FT.isParentFile(n);
  }

  /**
   * Is this node showing its children? Which way round the default runs is
   * `startsCollapsed`'s call; the stored state is always the exception to it.
   *
   * @param {Object} n
   * @returns {boolean}
   */
  function isExpanded(n) {
    const state = collapsed[n.path];
    return FT.startsCollapsed(n) ? state === false : state !== true;
  }

  /**
   * Flip one node's expansion, recording it explicitly so the stored state
   * reads the same for folders and for files holding files.
   * @param {Object} n
   * @returns {void}
   */
  function toggleExpanded(n) {
    collapsed[n.path] = isExpanded(n);
  }

  /** Sprite symbol per file kind — the same shapes the node badges wear. */
  const KIND_ICON = {
    portal: "atom",
    component: "component",
    utility: "wrench",
    head: "code-xml",
    file: "code-xml",
  };

  /**
   * What each sprite symbol degrades to when the sprite could not be loaded.
   * Font Awesome 4 is always there — Node-RED loads it for its own editor.
   */
  const FA_FALLBACK = {
    atom: "fa fa-file-code-o",
    component: "fa fa-file-code-o",
    wrench: "fa fa-file-code-o",
    "code-xml": "fa fa-file-text-o",
    folder: "fa fa-folder-o",
    "folder-open": "fa fa-folder-open-o",
    "chevron-right": "fa fa-caret-right",
    "chevron-down": "fa fa-caret-down",
    ban: "fa fa-ban",
  };

  /**
   * Fetch the Lucide sprite once and park it in the document, so rows can
   * reference its symbols locally. Local `<use>` is what makes `currentColor`
   * and a CSS `stroke-width` override reliable — through an external file both
   * are inconsistent across engines.
   *
   * @returns {void}
   */
  function injectIconSprite() {
    $.ajax({ url: "portal-react/editor/icons.svg", dataType: "text" })
      .done(function (markup) {
        $("<div>")
          .attr("id", "fc-ws-icon-sprite")
          .css("display", "none")
          .html(markup)
          .appendTo(document.body);
        spriteReady = true;
        if (overlayVisible()) renderTree();
      })
      .fail(function () {
        console.warn(PREFIX, "icon sprite unavailable — falling back to Font Awesome");
      });
  }

  /**
   * One icon element: a sprite reference, or the Font Awesome equivalent when
   * the sprite never arrived.
   *
   * @param {string} name Sprite symbol name (Lucide's own).
   * @param {string} [kind] File kind, for the colour class.
   * @returns {Object} jQuery element
   */
  function iconEl(name, kind) {
    if (!spriteReady) {
      return $("<i>").addClass(FA_FALLBACK[name] || "fa fa-file-o");
    }
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "fc-ws-icon" + (kind ? " fc-ws-icon--" + kind : ""));
    const use = document.createElementNS(NS, "use");
    use.setAttribute("href", "#fc-icon-" + name);
    svg.appendChild(use);
    return $(svg);
  }

  /**
   * Icon for a tree entry — folder state for directories, node kind for files.
   * @param {Object} n
   * @returns {Object} jQuery element
   */
  function iconElFor(n) {
    if (n.type === "dir") {
      // A flow tab is not a folder — it is the thing the canvas shows as a tab.
      if (n.kind === "flow") return iconEl("workflow");
      return iconEl(isExpanded(n) ? "folder-open" : "folder");
    }
    const kind = FT.iconKindFor(n.file);
    return iconEl(KIND_ICON[kind] || KIND_ICON.file, kind);
  }

  /**
   * Read persisted settings, falling back to the defaults for anything absent
   * or malformed — a stale key must never leave the tree empty.
   * @returns {void}
   */
  function loadSettings() {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object") {
        if (saved.groupBy === "kind" || saved.groupBy === "flow") {
          settings.groupBy = saved.groupBy;
        }
        if (typeof saved.showHead === "boolean") settings.showHead = saved.showHead;
        if (typeof saved.showJs === "boolean") settings.showJs = saved.showJs;
      }
    } catch (err) {
      console.warn(PREFIX, "settings unreadable, using defaults", err);
    }
  }

  /**
   * Persist settings and re-render. Storage can throw (private mode, blocked
   * site data) — the setting still applies for this session.
   * @returns {void}
   */
  function saveSettings() {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (err) {
      console.warn(PREFIX, "settings not persisted", err);
    }
    collect();
    renderAll();
  }

  /**
   * Dim a row whose code is not running, and say why. Node-RED can switch off
   * a single node or a whole flow tab; the editor would otherwise show both
   * exactly like live code.
   *
   * @param {Object} row jQuery row element
   * @param {"node"|"flow"} reason
   * @returns {void}
   */
  function markDisabled(row, reason) {
    row.addClass("fc-ws-off");
    iconEl("ban").addClass("fc-ws-off-mark").appendTo(row);
    row.attr(
      "title",
      (row.attr("title") ? row.attr("title") + " — " : "") +
        (reason === "flow" ? "flow disabled in Node-RED" : "node disabled in Node-RED"),
    );
  }

  /**
   * Render the overlay tree from the current listing + filter.
   * @returns {void}
   */
  function renderTree() {
    if (!treeEl) return;
    treeEl.empty();
    const visible = FT.filterFiles(files, filterText);
    if (!visible.length) {
      $("<div>")
        .addClass("fc-ws-empty")
        .text(
          files.length
            ? "No file matches the filter."
            : "No portal-react, component or utility nodes in this flow yet.",
        )
        .appendTo(treeEl);
      return;
    }
    const tree = FT.buildTree(visible);
    // A filter query implies "show me everything that matched".
    renderChildren(tree, treeEl, 0, !!filterText);
  }

  /**
   * Recursively render tree rows.
   * @param {Object} dir
   * @param {Object} target jQuery container
   * @param {number} depth
   * @param {boolean} forceOpen ignore collapse state (filter active)
   * @returns {void}
   */
  function renderChildren(dir, target, depth, forceOpen) {
    dir.children.forEach(function (child) {
      const row = $("<div>")
        .addClass("fc-ws-row")
        .css("padding-left", 8 + depth * 14 + "px");
      const expandable = child.type === "dir" || isParentFile(child);
      const open = forceOpen || isExpanded(child);

      if (isParentFile(child)) {
        // Its own twisty, so the row can be clicked to open the file without
        // that click also folding the thing away.
        iconEl(open ? "chevron-down" : "chevron-right")
          .addClass("fc-ws-twisty")
          .on("click", function (ev) {
            ev.stopPropagation();
            toggleExpanded(child);
            renderTree();
          })
          .appendTo(row);
      }
      iconElFor(child).appendTo(row);
      $("<span>").addClass("fc-ws-name").text(child.name).appendTo(row);

      if (child.disabled) markDisabled(row, child.disabled);

      if (child.type === "dir") {
        row.addClass("fc-ws-dir");
        row.on("click", function () {
          toggleExpanded(child);
          renderTree();
        });
        row.appendTo(target);
        if (open) renderChildren(child, target, depth + 1, forceOpen);
        return;
      }

      const file = child.file;
      if (file.disabled) markDisabled(row, file.disabled);
      const err = errorFor(file);
      if (err) {
        $("<span>")
          .addClass("fc-ws-mark fc-ws-error")
          .attr("title", err)
          .text("\u25CF")
          .appendTo(row);
      } else if (isDirty(file)) {
        $("<span>")
          .addClass("fc-ws-mark fc-ws-dirty")
          .attr("title", "Changed since last deploy")
          .text("\u25CF")
          .appendTo(row);
      }
      if (file.key === activeKey) row.addClass("fc-ws-active");
      row.attr("title", file.path);
      row.on("click", function () {
        openFile(file.key);
      });
      row.on("contextmenu", function (ev) {
        ev.preventDefault();
        revealOnCanvas(file.nodeId);
      });
      row.appendTo(target);
      if (expandable && open) renderChildren(child, target, depth + 1, forceOpen);
    });
  }

  /**
   * Scroll the tree to the file being edited, expanding any collapsed folder
   * on the way — switching tabs should never leave you hunting for where the
   * open file lives.
   *
   * Only scrolls when the row is actually out of view, so it never yanks the
   * tree away from where the user just scrolled it.
   *
   * @returns {void}
   */
  function revealActiveInTree() {
    if (!treeEl || !activeKey) return;
    const entry = entries[activeKey];
    if (!entry) return;

    // Expand ancestors first — a collapsed folder means no row to scroll to.
    const dirs = entry.file.segments.slice(0, -1);
    let expanded = false;
    dirs.forEach(function (_seg, i) {
      const path = entry.file.segments.slice(0, i + 1).join("/");
      if (collapsed[path] !== false) {
        collapsed[path] = false;
        expanded = true;
      }
    });
    if (expanded) renderTree();

    const row = treeEl.find(".fc-ws-row.fc-ws-active")[0];
    if (!row) return;
    const view = treeEl[0];
    const r = row.getBoundingClientRect();
    const c = view.getBoundingClientRect();
    const margin = 8;
    if (r.top < c.top) {
      view.scrollTop -= c.top - r.top + margin;
    } else if (r.bottom > c.bottom) {
      view.scrollTop += r.bottom - c.bottom + margin;
    }
  }

  /**
   * Render the open-file tab strip.
   * @returns {void}
   */
  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.empty();
    openKeys.forEach(function (key) {
      const entry = entries[key];
      if (!entry) return;
      const file = entry.file;
      const tab = $("<div>").addClass("fc-ws-tab").attr("data-key", key).attr("title", file.path);
      if (key === activeKey) tab.addClass("fc-ws-active");
      if (isDirty(file)) tab.addClass("fc-ws-tab-dirty");
      $("<span>").text(file.name).appendTo(tab);
      $("<span>")
        .addClass("fc-ws-close")
        .html("&times;")
        .on("click", function (ev) {
          ev.stopPropagation();
          closeTab(key);
        })
        .appendTo(tab);
      tab.on("click", function () {
        setActive(key);
      });
      tab.on("mousedown", function (ev) {
        if (ev.which === 2) {
          ev.preventDefault();
          closeTab(key);
        }
      });
      tab.appendTo(tabsEl);
    });
  }

  /**
   * Update the header status line + Deploy button state.
   * @returns {void}
   */
  function updateStatus() {
    if (!statusEl) return;
    const dirtyCount = files.filter(isDirty).length;
    statusEl.text(
      dirtyCount ? dirtyCount + " file(s) changed — not deployed" : "All changes deployed",
    );
    statusEl.toggleClass("fc-ws-has-changes", dirtyCount > 0);
    if (deployBtn) deployBtn.toggleClass("disabled", !RED.nodes.dirty());
  }

  /**
   * The served URL of the portal an open file belongs to, or "" for files that
   * are not part of one. `/fromcubes/` is hardcoded server-side; only the
   * sub-path is per node, and `httpNodeRoot` may prefix the lot.
   *
   * @param {string} key
   * @returns {string}
   */
  function portalUrlFor(key) {
    const entry = key && entries[key];
    if (!entry || entry.file.type !== "portal-react") return "";
    const node = RED.nodes.node(entry.file.nodeId);
    const subPath = node && (node.subPath || "").trim();
    if (!subPath) return "";
    const root = (RED.settings.httpNodeRoot || "/").replace(/\/$/, "");
    return root + "/fromcubes/" + subPath;
  }

  /**
   * Offer the "open in browser" button only while a portal file is on screen —
   * a component or a utility has no address of its own.
   * @returns {void}
   */
  function updateOpenPortalButton() {
    if (!openPortalBtn) return;
    const url = portalUrlFor(activeKey);
    openPortalBtn.toggle(!!url);
    if (url) {
      openPortalBtn.attr("title", "Open " + url + " in a new tab");
    }
  }

  /**
   * Show the editor, the textarea fallback, or the empty-state placeholder.
   * @returns {void}
   */
  function updatePaneVisibility() {
    if (!placeholderEl) return;
    const hasFile = !!activeKey;
    placeholderEl.toggle(!hasFile);
    if (monacoFailed) {
      monacoHost.hide();
      fallbackEl.toggle(hasFile);
    } else {
      fallbackEl.hide();
      monacoHost.toggle(hasFile);
      if (hasFile && editor) editor.layout();
    }
  }

  /** True while the full-screen overlay is on screen. @returns {boolean} */
  function overlayVisible() {
    return !!overlay && !overlay.attr("hidden");
  }

  /** Re-render tree, tabs and status together. @returns {void} */
  function renderAll() {
    if (!overlayVisible()) return;
    renderTree();
    renderTabs();
    updateStatus();
    updateOpenPortalButton();
  }

  // ── Actions ─────────────────────────────────────────────────

  /**
   * Jump to a node on the canvas and close the overlay.
   * @param {string} nodeId
   * @returns {void}
   */
  function revealOnCanvas(nodeId) {
    close();
    try {
      RED.view.reveal(nodeId);
    } catch (err) {
      console.warn(PREFIX, "reveal failed", err);
    }
  }

  /**
   * Flush pending edits, then trigger Node-RED's own deploy.
   * @returns {void}
   */
  function deploy() {
    flushAll();
    if (!RED.nodes.dirty()) {
      RED.notify("Nothing to deploy", "info");
      return;
    }
    try {
      RED.actions.invoke("core:deploy-flows");
    } catch (err) {
      $("#red-ui-header-button-deploy").trigger("click");
    }
  }

  /**
   * True while a node edit tray is open — editing the same node from two
   * places would let the tray's `oneditsave` clobber workspace edits.
   * @returns {boolean}
   */
  function trayOpen() {
    return $("#red-ui-tray").length > 0 || $(".red-ui-tray").length > 0;
  }

  // ── Overlay lifecycle ───────────────────────────────────────

  /**
   * The settings panel that hangs off the gear beside the filter: how the tree
   * is grouped, and which generated files are worth showing.
   * @returns {Object} jQuery element
   */
  function buildSettingsPanel() {
    const panel = $("<div>").addClass("fc-ws-settings").hide();

    $("<div>").addClass("fc-ws-settings-title").text("Group by").appendTo(panel);
    [
      ["flow", "Flow tab", "Each flow holds its own Components / Portals / Utilities"],
      ["kind", "Kind", "Portals / Components / Utilities at the top level"],
    ].forEach(function (opt) {
      const row = $("<label>").addClass("fc-ws-settings-row").attr("title", opt[2]);
      $("<input>")
        .attr({ type: "radio", name: "fc-ws-groupby" })
        .prop("checked", settings.groupBy === opt[0])
        .on("change", function () {
          settings.groupBy = opt[0];
          saveSettings();
        })
        .appendTo(row);
      $("<span>").text(opt[1]).appendTo(row);
      row.appendTo(panel);
    });

    $("<div>").addClass("fc-ws-settings-title").text("Show").appendTo(panel);
    [
      ["showHead", "head.html files", "Custom <head> markup of each portal, empty ones included"],
      ["showJs", "Utility .js files", "Code from fc-portal-utility nodes"],
    ].forEach(function (opt) {
      const row = $("<label>").addClass("fc-ws-settings-row").attr("title", opt[2]);
      $("<input>")
        .attr("type", "checkbox")
        .prop("checked", !!settings[opt[0]])
        .on("change", function () {
          settings[opt[0]] = this.checked;
          saveSettings();
        })
        .appendTo(row);
      $("<span>").text(opt[1]).appendTo(row);
      row.appendTo(panel);
    });
    return panel;
  }

  /**
   * Show or hide the settings panel.
   * @returns {void}
   */
  function toggleSettingsPanel() {
    if (!settingsPanel) return;
    const showing = !settingsPanel.is(":visible");
    settingsPanel.toggle(showing);
    if (gearEl) gearEl.toggleClass("fc-ws-on", showing);
  }

  /**
   * Build the overlay DOM once.
   * @returns {void}
   */
  function buildOverlay() {
    if (overlay) return;
    overlay = $("<div>").attr("id", "fc-ws-overlay").attr("hidden", true);

    const header = $("<div>").addClass("fc-ws-header").appendTo(overlay);
    const brand = $("<div>").addClass("fc-ws-brand").appendTo(header);
    $("<img>")
      .addClass("fc-ws-mark-logo")
      .attr("src", "portal-react/editor/mark.svg")
      .attr("alt", "fromcubes")
      .appendTo(brand);
    // One word split by colour — wrapped so the lockup's gap sits between the
    // mark and the name, not inside the name.
    const brandText = $("<span>").addClass("fc-ws-brand-text").appendTo(brand);
    $("<span>").addClass("fc-ws-brand-name").text("fromcubes-").appendTo(brandText);
    $("<span>").addClass("fc-ws-brand-accent").text("react").appendTo(brandText);
    statusEl = $("<div>").addClass("fc-ws-status").appendTo(header);
    $("<div>").addClass("fc-ws-spacer").appendTo(header);
    openPortalBtn = $(
      '<button type="button" class="red-ui-button red-ui-button-small fc-ws-open-portal">' +
        '<i class="fa fa-external-link"></i>' +
        "</button>",
    )
      .hide()
      .on("click", function () {
        const url = portalUrlFor(activeKey);
        if (url) window.open(url, "_blank", "noopener");
      })
      .appendTo(header);
    // Node-RED's own deploy button markup, so it matches the header toolbar.
    deployBtn = $(
      '<a class="red-ui-deploy-button" href="#">' +
        '<span class="red-ui-deploy-button-content">' +
        '<img src="red/images/deploy-full-o.svg" alt="" /> <span>Deploy</span>' +
        "</span>" +
        "</a>",
    )
      .on("click", function (ev) {
        ev.preventDefault();
        deploy();
      })
      .appendTo(header);
    $(
      '<button type="button" class="red-ui-button red-ui-button-small fc-ws-close">' +
        '<i class="fa fa-times"></i> Close <span class="fc-ws-kbd">Esc</span>' +
        "</button>",
    )
      .on("click", function () {
        close();
      })
      .appendTo(header);

    const body = $("<div>").addClass("fc-ws-body").appendTo(overlay);

    const treePane = $("<div>").addClass("fc-ws-tree-pane").appendTo(body);
    const filterRow = $("<div>").addClass("fc-ws-filter-row").appendTo(treePane);
    filterEl = $("<input>")
      .addClass("fc-ws-filter")
      .attr("type", "text")
      .attr("placeholder", "Filter files…")
      .on("input", function () {
        filterText = this.value;
        renderTree();
      })
      .appendTo(filterRow);
    const gear = $(
      '<span class="fc-ws-toggle fc-ws-gear" title="Tree settings"><i class="fa fa-cog"></i></span>',
    )
      .on("click", function (ev) {
        ev.stopPropagation();
        toggleSettingsPanel();
      })
      .appendTo(filterRow);
    settingsPanel = buildSettingsPanel().appendTo(treePane);
    // Any click outside closes it — the panel is a menu, not a mode.
    overlay.on("mousedown.fc-ws-settings", function (ev) {
      if (!settingsPanel.is(":visible")) return;
      if ($(ev.target).closest(".fc-ws-settings, .fc-ws-gear").length) return;
      settingsPanel.hide();
      gear.removeClass("fc-ws-on");
    });
    gearEl = gear;

    treeEl = $("<div>").addClass("fc-ws-tree").appendTo(treePane);

    const splitter = $("<div>").addClass("fc-ws-splitter").appendTo(body);
    splitter.on("mousedown", function (ev) {
      ev.preventDefault();
      const startX = ev.pageX;
      const startW = treePane.width();
      const onMove = function (e) {
        treeWidth = Math.max(MIN_TREE_WIDTH, startW + (e.pageX - startX));
        treePane.css("width", treeWidth + "px");
        if (editor) editor.layout();
      };
      const onUp = function () {
        $(document).off("mousemove", onMove).off("mouseup", onUp);
      };
      $(document).on("mousemove", onMove).on("mouseup", onUp);
    });

    const editorPane = $("<div>").addClass("fc-ws-editor-pane").appendTo(body);
    tabsEl = $("<div>").addClass("fc-ws-tabs").appendTo(editorPane);
    placeholderEl = $("<div>")
      .addClass("fc-ws-placeholder")
      .html("Pick a file on the left.<br /><kbd>Esc</kbd> closes · <kbd>Ctrl/Cmd+S</kbd> deploys")
      .appendTo(editorPane);
    monacoHost = $("<div>").addClass("fc-ws-monaco").hide().appendTo(editorPane);
    fallbackEl = $("<textarea>")
      .addClass("fc-ws-fallback")
      .attr("spellcheck", "false")
      .hide()
      .on("input", function () {
        if (activeKey) scheduleFlush(activeKey);
      })
      .appendTo(editorPane);

    $(document.body).append(overlay);
  }

  /**
   * Create the single Monaco instance, reusing the loader, JSX defaults,
   * keybindings and completion providers already set up by portal-react.html.
   * @param {Function} [done]
   * @returns {void}
   */
  function ensureMonaco(done) {
    if (monacoFailed) {
      if (done) done();
      return;
    }
    if (monacoReady && editor && editor.getDomNode()) {
      if (done) done();
      return;
    }
    // Node-RED's `editor:close` cleanup disposes editors it doesn't know about
    // — if ours went with it, build a fresh one.
    monacoReady = false;
    editor = null;
    window.__fcLoadMonaco(function (failed) {
      if (failed) {
        monacoFailed = true;
        console.warn(PREFIX, "Monaco unavailable — falling back to textarea");
        if (done) done();
        return;
      }
      window.__fcApplyJsxDefaults();
      monacoHost.empty();
      editor = monaco.editor.create(
        monacoHost[0],
        Object.assign({ model: null }, window.__fcEditorOpts),
      );
      // Same JSX affordances as the node dialogs. Self-close collapse is JSX
      // shaped; head.html files are the rare exception where it can fire.
      if (window.__fcAttachSelfClose) window.__fcAttachSelfClose(editor);
      if (window.__fcAttachKeybindings) window.__fcAttachKeybindings(editor);
      editor.addAction({
        id: "fc-ws-save",
        label: "Save & Deploy",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: function () {
          deploy();
        },
      });
      editor.addAction({
        id: "fc-ws-goto-definition",
        label: "Go to Definition (fromcubes)",
        keybindings: [monaco.KeyCode.F12],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1,
        run: function (ed) {
          gotoDefinition(ed.getPosition());
        },
      });
      // Ctrl/Cmd+click, the way every other editor does it. Monaco's own
      // go-to-definition can't cross models in the standalone build, so the
      // jump is ours; anything we can't resolve falls through to Monaco's.
      editor.onMouseDown(function (e) {
        const mouse = e.event;
        if (!mouse || !(mouse.ctrlKey || mouse.metaKey) || mouse.rightButton) return;
        if (!e.target || !e.target.position) return;
        if (gotoDefinition(e.target.position)) {
          mouse.preventDefault();
          mouse.stopPropagation();
        }
      });
      editor.addAction({
        id: "fc-ws-filter",
        label: "Filter files",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP],
        run: function () {
          if (filterEl) filterEl.trigger("focus").trigger("select");
        },
      });
      monacoReady = true;
      if (done) done();
    });
  }

  /**
   * Load CSS class candidates + component/utility names so completion inside
   * the overlay is as rich as inside a node dialog.
   * @returns {void}
   */
  function warmCompletionCaches() {
    if (window.__fcRefreshCssClasses) window.__fcRefreshCssClasses();
    if (window.__fcRefreshComponentNames) window.__fcRefreshComponentNames();
    if (window.__fcRefreshUtilities) window.__fcRefreshUtilities();
  }

  /**
   * Open the overlay, optionally focused on one file.
   * @param {string} [key]
   * @returns {void}
   */
  function open(key) {
    if (trayOpen()) {
      RED.notify("Close the node edit dialog first", "warning");
      return;
    }
    buildOverlay();
    warmCompletionCaches();
    collect();
    overlay.removeAttr("hidden");
    // Node-RED's toasts live at z-index 100 and would sit under this overlay —
    // including the ones this editor raises. workspace.css lifts them while the
    // class is on, and only while it is on.
    $(document.body).addClass("fc-ws-open");
    $(document).on("keydown.fc-ws", onKeyDown);

    ensureMonaco(function () {
      // Models can only be created once Monaco is up — build them for tabs
      // that were opened while it was still loading.
      openKeys.forEach(function (k) {
        if (entries[k]) ensureEntry(entries[k].file);
      });
      if (key) openFile(key);
      else openDefaultFile();
      updatePaneVisibility();
      refreshErrors(renderAll);
      renderAll();
      if (editor) editor.layout();
    });
  }

  /**
   * Open one node's file straight from that node's edit dialog. The dialog is
   * saved and closed first (its `oneditsave` owns the same field), then the
   * overlay opens once the tray is gone.
   *
   * @param {string} nodeId
   * @param {string} field config property holding the code
   * @returns {void}
   */
  function openNodeFile(nodeId, field) {
    const key = nodeId + ":" + field;
    if (trayOpen()) $("#node-dialog-ok").trigger("click");
    let waited = 0;
    const tick = function () {
      if (!trayOpen()) {
        open(key);
        return;
      }
      waited += 100;
      if (waited > 3000) {
        RED.notify("Close the node edit dialog first", "warning");
        return;
      }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  }

  /**
   * Which file to show when the editor is opened with nothing in mind.
   *
   * The canvas tab you are looking at is the best guess at what you came to
   * edit, and inside it the portal outranks the parts it is built from. Only
   * one file opens — the rest of the flow is a click away in the tree.
   *
   * Order: keep your place if it is already in this flow → this flow's portal,
   * then its components and utilities → anything that is actually running →
   * whatever is first.
   *
   * @returns {void}
   */
  function openDefaultFile() {
    if (!files.length) return;
    const flowId = RED.workspaces.active ? RED.workspaces.active() : null;

    if (activeKey && entries[activeKey] && entries[activeKey].file.flowId === flowId) {
      setActive(activeKey);
      return;
    }
    // `files` is already ordered portal → component → utility within a flow,
    // so the first match here is the portal when there is one.
    const inFlow = files.filter(function (f) {
      return flowId && f.flowId === flowId;
    })[0];
    if (inFlow) {
      openFile(inFlow.key);
      return;
    }
    if (activeKey) {
      setActive(activeKey);
      return;
    }
    // Opening a file expands its flow, and a disabled flow was collapsed for
    // a reason — so prefer one that is running.
    const live = files.filter(function (f) {
      return !f.disabled;
    })[0];
    openFile((live || files[0]).key);
  }

  /**
   * Flush edits and hide the overlay. Models are kept so reopening is instant.
   * @returns {void}
   */
  function close() {
    if (!overlay) return;
    if (editor && activeKey && entries[activeKey] && !modelGone(entries[activeKey])) {
      entries[activeKey].viewState = editor.saveViewState();
    }
    flushAll();
    overlay.attr("hidden", true);
    $(document.body).removeClass("fc-ws-open");
    $(document).off("keydown.fc-ws");
  }

  /**
   * Overlay-level keyboard handling.
   * @param {Object} ev
   * @returns {void}
   */
  function onKeyDown(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "s" || ev.key === "S")) {
      ev.preventDefault();
      // Monaco owns Ctrl+S while the editor has focus (fc-ws-save action) —
      // handling it here as well would fire deploy twice.
      if (monacoHost && $.contains(monacoHost[0], ev.target)) return;
      deploy();
    }
  }

  // ── Status bar ──────────────────────────────────────────────

  /**
   * The editor's only entry point outside a node dialog: a button in Node-RED's
   * bottom status bar, styled with Node-RED's own `red-ui-footer-button` so it
   * sits level with its neighbours, carrying the node icon and the editor name.
   * @returns {void}
   */
  function registerStatusBar() {
    if (!RED.statusBar || !RED.statusBar.add) {
      console.warn(PREFIX, "no RED.statusBar — status bar button skipped");
      return;
    }
    const el = $('<button type="button" class="red-ui-footer-button fc-ws-statusbar-btn"></button>')
      .attr("title", "fromcubes-react — open " + EDITOR_NAME)
      .on("click", function (ev) {
        ev.preventDefault();
        open();
      });
    $("<img>")
      .addClass("fc-ws-statusbar-icon")
      .attr("src", "portal-react/icons/fromcubes-react.svg")
      .attr("alt", "")
      .appendTo(el);
    $("<span>").text(EDITOR_NAME).appendTo(el);
    RED.statusBar.add({ id: "fromcubes-react-editor", align: "right", element: el });
    RED.actions.add("fromcubes:open-react-editor", function () {
      open();
    });
  }

  // ── Flow events ─────────────────────────────────────────────

  /**
   * Re-sync after the flows changed underneath us (deploy, undo, node edited
   * through its own dialog, node deleted).
   * @returns {void}
   */
  function onFlowsChanged() {
    if (selfEmitting) return;
    // Flow-wide operations (import, deploy, undo) fire one event per node —
    // coalesce them into a single re-sync.
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(resync, 100);
  }

  /**
   * Reconcile open models with the node objects after an external change.
   * @returns {void}
   */
  function resync() {
    collect();
    openKeys.forEach(function (key) {
      const entry = entries[key];
      if (!entry || modelGone(entry)) return;
      const node = RED.nodes.node(entry.file.nodeId);
      if (!node) return;
      const nodeValue = node[entry.file.field] || "";
      const editorValue = entry.model.getValue();
      if (nodeValue === editorValue) return;
      if (editorValue === entry.lastSynced) {
        // No unflushed edits here — the node is newer, take it.
        entry.lastSynced = nodeValue;
        entry.model.setValue(nodeValue);
      } else {
        RED.notify(
          entry.file.path + " changed outside the editor — keeping your version.",
          { type: "warning", timeout: 6000 },
        );
      }
    });
    renderAll();
  }

  // ── Bootstrap ───────────────────────────────────────────────

  /**
   * Wire everything up once the editor and file-tree helper are available.
   * @returns {void}
   */
  function init() {
    if (typeof RED === "undefined" || !RED.sidebar || !window.__fcFileTree) {
      setTimeout(init, 200);
      return;
    }
    FT = window.__fcFileTree;
    injectIconSprite();
    loadSettings();
    registerStatusBar();
    collect();
    refreshErrors(renderAll);

    ["nodes:add", "nodes:remove", "nodes:change", "flows:change", "workspace:change"].forEach(
      function (evt) {
        RED.events.on(evt, onFlowsChanged);
      },
    );
    RED.events.on("deploy", function () {
      refreshErrors(renderAll);
      renderAll();
    });

    window.__fcPortalWorkspace = {
      open: open,
      openNodeFile: openNodeFile,
      close: close,
      refresh: resync,
    };
    console.log(PREFIX, "ready");
  }

  init();
})();
