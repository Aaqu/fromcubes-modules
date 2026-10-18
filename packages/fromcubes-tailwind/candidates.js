/**
 * The editor's view of Tailwind CSS 4: every class, variant and modifier,
 * read from Tailwind's own design system — the source Tailwind CSS
 * IntelliSense (VS Code) completes from — instead of a hand-kept list. It is
 * loaded from the same stylesheet css.js builds portals from, so the editor
 * offers exactly the classes that produce CSS, no more and no fewer.
 */

const { __unstable__loadDesignSystem } = require("tailwindcss");
const { loadStylesheet, TW_INPUT } = require("./css");
const { describeCandidate, variantList, colorOf, isLikelyColorless } = require("./intellisense");
const { canonicalizer } = require("./canonical");

let designSystem = null;
/**
 * Tailwind's design system, loaded once. `__unstable__` is Tailwind's name
 * for it; IntelliSense loads the same function for every v4 project.
 *
 * @returns {Promise<Object>}
 */
function getDesignSystem() {
  if (!designSystem) {
    designSystem = __unstable__loadDesignSystem(TW_INPUT, { base: __dirname, loadStylesheet });
    // A failed load is retried on the next call rather than remembered.
    designSystem.catch(() => {
      designSystem = null;
    });
  }
  return designSystem;
}

/**
 * Every class name, in Tailwind's order (natural sort, fractions last).
 *
 * @returns {Promise<Array<string>>}
 */
async function generateCandidates() {
  const ds = await getDesignSystem();
  return ds.getClassList().map(([name]) => name);
}

let completions = null;
/**
 * Classes with their modifiers (`bg-red-500/50`, `text-sm/6`) and swatch
 * colour, and the variants with their details — the data IntelliSense
 * builds its completion list from. Computed once: colours take every
 * colour-capable class through the compiler.
 *
 * @returns {Promise<{classes: Array<{name: string, modifiers: Array<string>, color: string|null}>, variants: Array<Object>}>}
 */
function completionData() {
  if (!completions) {
    completions = getDesignSystem().then((ds) => {
      const list = ds.getClassList();
      const colorful = list.map(([name]) => name).filter((name) => !isLikelyColorless(name));
      const asts = ds.candidatesToAst(colorful);
      const colors = new Map();
      colorful.forEach((name, i) => {
        const color = colorOf(ds, name, asts[i]);
        if (color) colors.set(name, color);
      });
      // An editor has just opened: let the worker build Tailwind's
      // canonicalisation index (over a second of CPU) off this thread
      // before the first diagnostics ask for it.
      canonicalizer.warm();
      return {
        classes: list.map(([name, meta]) => ({
          name,
          modifiers: (meta && meta.modifiers) || [],
          color: colors.get(name) || null,
        })),
        variants: variantList(ds),
      };
    });
    completions.catch(() => {
      completions = null;
    });
  }
  return completions;
}

/**
 * The CSS, declaration summary, colour, conflict rules and canonical
 * spelling of each candidate — for the completion's detail pane, the hover,
 * modifier swatches, colour squares and diagnostics. `null` for a candidate
 * Tailwind generates nothing for. The canonical spelling comes from the
 * worker thread; when it cannot give one, `canonical` stays `null`.
 *
 * @param {Array<string>} candidates
 * @returns {Promise<Array<Object|null>>}
 */
async function describeCandidates(candidates) {
  const ds = await getDesignSystem();
  const results = candidates.map((candidate) => {
    try {
      return describeCandidate(ds, candidate);
    } catch {
      return null;
    }
  });
  const known = candidates.filter((_, i) => results[i]);
  const canonical = await canonicalizer.canonicalize(known);
  let j = 0;
  results.forEach((r, i) => {
    if (!r) return;
    const c = canonical[j++];
    r.canonical = c && c !== candidates[i] ? c : null;
  });
  return results;
}

module.exports = { generateCandidates, completionData, describeCandidates, getDesignSystem };
