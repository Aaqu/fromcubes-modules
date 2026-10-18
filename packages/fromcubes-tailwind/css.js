/**
 * Tailwind CSS 4 compiled server-side: scan a portal's source for class
 * candidates and build only the utilities it uses.
 */

const fs = require("fs");
const path = require("path");

const twCompile = require("tailwindcss").compile;
const CANDIDATE_RE = /[a-zA-Z0-9_\-:.\/\[\]#%]+/g;

// Contents of "…", '…' and `…` literals in the scanned source. Tailwind
// classes live inside string literals, and splitting THOSE on whitespace
// keeps arbitrary values with `(`, `)`, `,`, `!`, `@`, `'` intact — chars
// CANDIDATE_RE cannot include globally without gluing candidates to
// surrounding code (`className="w-…`). Single regex alternation, escape-aware.
const STRING_LITERAL_RE =
  /"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;

// The stylesheet every portal is built from. The editor's class list
// (candidates.js) loads the same one, so it offers exactly what builds.
const TW_INPUT = `@import 'tailwindcss';`;

/**
 * Resolve the `@import`s in TW_INPUT for Tailwind's compiler.
 *
 * @param {string} id
 * @param {string} [base]
 * @returns {Promise<{content: string, base: string}>}
 */
async function loadStylesheet(id, base) {
  let resolved;
  if (id === "tailwindcss") {
    resolved = require.resolve("tailwindcss/index.css");
  } else {
    resolved = require.resolve(id, { paths: [base || __dirname] });
  }
  return {
    content: fs.readFileSync(resolved, "utf8"),
    base: path.dirname(resolved),
  };
}

let twCompiled = null;
/**
 * Lazily compile the Tailwind base stylesheet. Result is memoized at module
 * scope — first call resolves async stylesheet imports, every subsequent
 * call returns the cached compiler.
 *
 * @returns {Promise<Object>}  Tailwind `compile()` result with a `.build()` method.
 */
async function getTwCompiled() {
  if (twCompiled) return twCompiled;
  twCompiled = await twCompile(TW_INPUT, { loadStylesheet });
  return twCompiled;
}

/**
 * Generate the per-page Tailwind CSS bundle by scanning `source` for utility
 * class candidates and feeding them to the compiled Tailwind core.
 *
 * @param {string} source  Source text to scan for class candidates.
 * @returns {Promise<{css: string}>}
 */
async function generateCSS(source) {
  const compiled = await getTwCompiled();
  const candidates = new Set(source.match(CANDIDATE_RE) || []);
  // Second pass: whitespace-split string-literal contents so arbitrary
  // values like w-[calc(100%-2rem)], grid-cols-[repeat(2,1fr)], mt-0! and
  // @md:flex survive as single candidates. Tailwind ignores candidates that
  // don't parse as utilities, so the extra tokens are harmless.
  STRING_LITERAL_RE.lastIndex = 0;
  let m;
  while ((m = STRING_LITERAL_RE.exec(source)) !== null) {
    const body = m[1] ?? m[2] ?? m[3] ?? "";
    for (const tok of body.split(/\s+/)) if (tok) candidates.add(tok);
  }
  const css = compiled.build([...candidates]);
  return { css };
}

module.exports = { generateCSS, getTwCompiled, loadStylesheet, TW_INPUT };
