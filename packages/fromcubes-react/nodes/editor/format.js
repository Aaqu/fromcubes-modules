/**
 * Formatting for the fromcubes editors — Prettier, loaded on first use.
 *
 * Registers Monaco formatting providers for `javascript` (portal JSX,
 * components, utilities) and `html` (a portal's custom head). Providers are
 * global per language, so this serves the React Editor overlay and the four
 * Monaco instances inside node dialogs alike.
 *
 * Nothing is fetched until someone actually formats: Prettier's browser builds
 * are ~772 KB, and most sessions never ask for them.
 */
(function () {
  "use strict";

  const PREFIX = "[FC-Format]";
  const BASE = (window.__fcAssetBase || "fromcubes-react/") + "prettier/";
  // UMD builds: each sets window.prettier / window.prettierPlugins.
  const SCRIPTS = [
    "standalone.js",
    "plugins/babel.js",
    "plugins/estree.js",
    "plugins/html.js",
  ];

  /** @type {Promise<boolean>|null} in-flight or settled load */
  let loading = null;
  let registered = false;

  /**
   * Load one script tag.
   * @param {string} src
   * @returns {Promise<void>}
   */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = src;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error("failed to load " + src));
      };
      document.head.appendChild(s);
    });
  }

  /**
   * Fetch Prettier once. Resolves false when it could not be loaded, so the
   * caller can fall back rather than fail.
   * @returns {Promise<boolean>}
   */
  function ensurePrettier() {
    if (loading) return loading;
    loading = SCRIPTS.reduce(function (chain, name) {
      return chain.then(function () {
        return loadScript(BASE + name);
      });
    }, Promise.resolve())
      .then(function () {
        if (!window.prettier || !window.prettierPlugins) {
          throw new Error("prettier globals missing after load");
        }
        // Monaco already ships a TypeScript formatter on `javascript`. With two
        // providers registered it picks one, and a silent loss would read as
        // "formatting is broken" — so TS steps aside, but only once Prettier is
        // definitely here. Until then its formatter stays as the fallback.
        try {
          const ts = monaco.languages.typescript.javascriptDefaults;
          ts.setModeConfiguration(
            Object.assign({}, ts.modeConfiguration, {
              documentFormattingEdits: false,
              documentRangeFormattingEdits: false,
            }),
          );
        } catch (err) {
          console.warn(PREFIX, "could not stand down the TS formatter", err);
        }
        console.log(PREFIX, "prettier", window.prettier.version, "ready");
        return true;
      })
      .catch(function (err) {
        console.warn(PREFIX, "prettier unavailable — Monaco's own formatter stays in charge", err);
        return false;
      });
    return loading;
  }

  /**
   * Run Prettier over a whole model.
   *
   * @param {Object} model Monaco text model
   * @param {string} parser Prettier parser name
   * @returns {Promise<Array>} Monaco text edits — empty when nothing can be done
   */
  function formatModel(model, parser) {
    return ensurePrettier().then(function (ok) {
      if (!ok) return [];
      const text = model.getValue();
      return window.prettier
        .format(text, {
          parser: parser,
          plugins: [
            window.prettierPlugins.babel,
            window.prettierPlugins.estree,
            window.prettierPlugins.html,
          ],
          // Follow the editor rather than impose a second opinion on indent.
          tabWidth: model.getOptions().tabSize || 2,
        })
        .then(function (out) {
          if (out === text) return [];
          return [{ range: model.getFullModelRange(), text: out }];
        })
        .catch(function (err) {
          // Prettier throws on code that does not parse — which is normal for
          // a file still being written. Say so instead of doing nothing.
          reportParseError(err);
          return [];
        });
    });
  }

  /**
   * Surface a parse failure where the user is looking.
   * @param {Error} err
   * @returns {void}
   */
  function reportParseError(err) {
    const loc = err && err.loc && err.loc.start;
    const first = String((err && err.message) || err).split("\n")[0];
    // Prettier usually puts "(line:column)" in the message already; only add
    // one when it did not, so the notification says it once.
    const where = loc && !/\(\d+:\d+\)/.test(first)
        ? " (line " + loc.line + ", column " + loc.column + ")"
        : "";
    console.warn(PREFIX, "not formatted:", err);
    if (typeof RED !== "undefined" && RED.notify) {
      RED.notify("Cannot format — " + first + where, { type: "warning", timeout: 6000 });
    }
  }

  /**
   * Register the providers once Monaco exists.
   * @returns {void}
   */
  function register() {
    if (registered) return;
    if (typeof monaco === "undefined" || !monaco.languages) {
      setTimeout(register, 300);
      return;
    }
    registered = true;

    [
      ["javascript", "babel"],
      ["html", "html"],
    ].forEach(function (pair) {
      const language = pair[0];
      const parser = pair[1];
      monaco.languages.registerDocumentFormattingEditProvider(language, {
        displayName: "Prettier (fromcubes)",
        provideDocumentFormattingEdits: function (model) {
          return formatModel(model, parser);
        },
      });
      // Format Selection falls out of the same call: Prettier has no partial
      // mode, so the whole document is formatted and Monaco applies the edit.
      monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
        displayName: "Prettier (fromcubes)",
        provideDocumentRangeFormattingEdits: function (model) {
          return formatModel(model, parser);
        },
      });
    });

    window.__fcFormat = { ensure: ensurePrettier, format: formatModel };
    console.log(PREFIX, "formatting providers registered");
  }

  register();
})();
