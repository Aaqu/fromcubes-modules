/**
 * What Tailwind CSS IntelliSense — the VS Code extension — shows next to a
 * class: its colour swatch, the one-line declaration summary, the CSS preview
 * with theme values resolved in comments, and the variant details. Computed
 * the way IntelliSense computes it, from the same Tailwind design system.
 *
 * Ported from tailwindcss-intellisense (packages/tailwindcss-language-service,
 * MIT, © Tailwind Labs, Inc. — see THIRD-PARTY-NOTICES.md). Function names
 * follow the originals so the two can be read side by side; where this file
 * departs from them, a comment says why.
 */

const culori = require("culori");
const { tokenize, stringify } = require("@csstools/css-tokenizer");
const { parseComponentValue, isFunctionNode } = require("@csstools/css-parser-algorithms");
const { calcFromComponentValues } = require("@csstools/css-calc");

// IntelliSense defaults: `tailwindCSS.rootFontSize` and
// `tailwindCSS.showPixelEquivalents`.
const ROOT_FONT_SIZE = 16;

// ── AST ──────────────────────────────────────────────────────────────────

// At-rules IntelliSense leaves out of colours and declaration summaries:
// `@property` registrations and two `@supports` fallbacks Tailwind emits.
function isHiddenAtRule(node) {
  if (node.kind !== "at-rule") return false;
  if (node.name === "@property") return true;
  return (
    node.name === "@supports" &&
    (node.params === "(-moz-orient: inline)" ||
      node.params === "(background-image: linear-gradient(in lab, red, red))")
  );
}

function walkDecls(nodes, fn) {
  for (const node of nodes) {
    if (node.kind === "declaration") {
      if (node.value !== undefined) fn(node);
    } else if (!isHiddenAtRule(node) && node.nodes) {
      walkDecls(node.nodes, fn);
    }
  }
}

/**
 * Compile one candidate to Tailwind's AST — `[]` when it is not a utility.
 *
 * @param {Object} ds  Tailwind design system.
 * @param {string} candidate
 * @returns {Array<Object>}
 */
function compile(ds, candidate) {
  return ds.candidatesToAst([candidate])[0] || [];
}

// ── var(…) and calc(…) rewriting (util/rewriting) ────────────────────────

function replaceCssVars(str, { replace, recursive = true }) {
  const seen = new Set();

  for (let i = 0; i < str.length; ++i) {
    if (!str.startsWith("var(", i)) continue;

    let depth = 0;
    let fallbackStart = null;

    // The original loops on `i < str.length`, which never ends on an
    // unclosed `var(`; bounding `j` changes nothing for well-formed CSS.
    for (let j = i + 4; j < str.length; ++j) {
      if (str[j] === "(") {
        depth++;
      } else if (str[j] === ")" && depth > 0) {
        depth--;
      } else if (str[j] === "\\") {
        j++;
      } else if (str[j] === "," && depth === 0 && fallbackStart === null) {
        fallbackStart = j + 1;
      } else if (str[j] === ")" && depth === 0) {
        const name = fallbackStart === null ? str.slice(i + 4, j) : str.slice(i + 4, fallbackStart - 1);
        const fallback = fallbackStart === null ? null : str.slice(fallbackStart, j);

        const replacement = replace({ name, fallback, range: { start: i, end: j } });

        if (replacement !== null) {
          // A replacement that refers back to the variable itself would loop.
          if (replacement.includes(`var(${name})`) || replacement.includes(`var(${name},`)) {
            break;
          }
          str = str.slice(0, i) + replacement + str.slice(j + 1);
        }

        if (recursive) {
          const key = `${i}:${replacement}`;
          if (!seen.has(key)) {
            seen.add(key);
            i -= 1;
          }
        }

        break;
      }
    }
  }

  return str;
}

function replaceCssCalc(str, replace) {
  for (let i = 0; i < str.length; ++i) {
    if (!str.startsWith("calc(", i)) continue;

    let depth = 0;

    for (let j = i + 5; j < str.length; ++j) {
      if (str[j] === "(") {
        depth++;
      } else if (str[j] === ")" && depth > 0) {
        depth--;
      } else if (str[j] === ")" && depth === 0) {
        const replacement = replace({ value: str.slice(i + 5, j), range: { start: i, end: j } });
        if (replacement !== null) {
          str = str.slice(0, i) + replacement + str.slice(j + 1);
        }
        break;
      }
    }
  }

  return str;
}

function evaluateExpression(str) {
  const tokens = tokenize({ css: `calc(${str})` });

  const components = parseComponentValue(tokens, {});
  if (!components) return null;

  const result = calcFromComponentValues([[components]], { randomSeed: 1, precision: 6 });

  const node = result[0][0];

  // A calc(…) left at the top level did not resolve to a single value.
  if (isFunctionNode(node) && node.name[1] === "calc(") return null;

  return stringify(...node.tokens());
}

function resolveVariableValue(ds, name) {
  const prefix = (ds.theme && ds.theme.prefix) || null;

  if (prefix && name.startsWith(`--${prefix}`)) {
    name = `--${name.slice(prefix.length + 3)}`;
  }

  // Variables escape the `.`; the v4 theme stores names without escapes.
  name = name.replaceAll("\\.", ".");

  return (ds.resolveThemeValue && ds.resolveThemeValue(name, true)) ?? null;
}

function replaceCssVarsWithFallbacks(ds, str) {
  const seen = new Set();

  return replaceCssVars(str, {
    replace({ name, fallback }) {
      // The design system wins over the fallback, as it would in a browser.
      if (name.startsWith("--")) {
        if (seen.has(name)) return null;
        const value = resolveVariableValue(ds, name);
        if (value !== null) {
          if (value.includes("var(")) seen.add(name);
          return value;
        }
      }

      if (fallback) return fallback;

      if (name === "--tw-text-shadow-alpha" || name === "--tw-drop-shadow-alpha" || name === "--tw-shadow-alpha") {
        return "100%";
      }

      return null;
    },
  });
}

function inlineThemeValues(css, ds) {
  const seen = new Set();

  function replace({ name, fallback }) {
    if (!name.startsWith("--")) return null;
    if (seen.has(name)) return null;

    const value = resolveVariableValue(ds, name);
    if (value === null) return fallback;
    if (value.includes("var(")) seen.add(name);

    return value;
  }

  css = replaceCssCalc(css, (expr) => evaluateExpression(replaceCssVars(expr.value, { replace })));
  css = replaceCssVars(css, { replace });

  return css;
}

// ── Comments ─────────────────────────────────────────────────────────────

function applyComments(str, comments) {
  const sorted = comments.map((c, order) => ({ ...c, order })).sort((a, b) => a.index - b.index || a.order - b.order);
  let out = "";
  let last = 0;
  for (const c of sorted) {
    out += str.slice(last, c.index) + ` /* ${c.value} */`;
    last = c.index;
  }
  return out + str.slice(last);
}

// ── CSS values (the subset of postcss-value-parser IntelliSense relies on) ──

const VALUE_STOP = new Set([" ", "\t", "\n", "\r", "\f", '"', "'", "/", ",", ":", "(", ")"]);

/**
 * Parse a CSS value into word / string / div / space / comment / function
 * nodes with source offsets, like postcss-value-parser.
 *
 * @param {string} value
 * @returns {Array<Object>}
 */
function parseValue(value) {
  let pos = 0;

  function parseNodes(inFunction) {
    const nodes = [];
    while (pos < value.length) {
      const start = pos;
      const ch = value[pos];

      if (ch === ")") {
        if (inFunction) return nodes;
        pos++;
        nodes.push({ type: "word", value: ")", sourceIndex: start, sourceEndIndex: pos });
      } else if (/\s/.test(ch)) {
        while (pos < value.length && /\s/.test(value[pos])) pos++;
        nodes.push({ type: "space", value: value.slice(start, pos), sourceIndex: start, sourceEndIndex: pos });
      } else if (ch === "/" && value[pos + 1] === "*") {
        const end = value.indexOf("*/", pos + 2);
        pos = end === -1 ? value.length : end + 2;
        nodes.push({ type: "comment", value: value.slice(start, pos), sourceIndex: start, sourceEndIndex: pos });
      } else if (ch === '"' || ch === "'") {
        pos++;
        while (pos < value.length && value[pos] !== ch) pos += value[pos] === "\\" ? 2 : 1;
        pos = Math.min(pos + 1, value.length);
        nodes.push({ type: "string", value: value.slice(start, pos), sourceIndex: start, sourceEndIndex: pos });
      } else if (ch === "/" || ch === "," || ch === ":") {
        pos++;
        nodes.push({ type: "div", value: ch, sourceIndex: start, sourceEndIndex: pos });
      } else if (ch === "(") {
        pos++;
        const children = parseNodes(true);
        if (value[pos] === ")") pos++;
        nodes.push({ type: "function", value: "", nodes: children, sourceIndex: start, sourceEndIndex: pos });
      } else {
        while (pos < value.length && !VALUE_STOP.has(value[pos])) pos += value[pos] === "\\" ? 2 : 1;
        if (value[pos] === "(") {
          const name = value.slice(start, pos);
          pos++;
          const children = parseNodes(true);
          if (value[pos] === ")") pos++;
          nodes.push({ type: "function", value: name, nodes: children, sourceIndex: start, sourceEndIndex: pos });
        } else {
          nodes.push({ type: "word", value: value.slice(start, pos), sourceIndex: start, sourceEndIndex: pos });
        }
      }
    }
    return nodes;
  }

  return parseNodes(false);
}

// Depth-first; `fn` returning false skips a function's children.
function walkValue(nodes, fn) {
  for (const node of nodes) {
    if (fn(node) === false) continue;
    if (node.type === "function") walkValue(node.nodes, fn);
  }
}

// postcss-value-parser's `unit()`: a leading number and what follows it.
const UNIT_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(.*)$/s;
function unit(word) {
  const m = UNIT_RE.exec(word);
  return m ? { number: m[1], unit: m[2] } : false;
}

// ── Pixel equivalents (util/pixelEquivalents) ────────────────────────────

function remComments(value, rootFontSize) {
  const comments = [];
  if (!value.includes("rem")) return comments;
  walkValue(parseValue(value), (node) => {
    if (node.type !== "word") return true;
    const u = unit(node.value);
    if (u && u.unit === "rem") {
      comments.push({ index: node.sourceEndIndex, value: `${parseFloat(u.number) * rootFontSize}px` });
    }
    return false;
  });
  return comments;
}

function addPixelEquivalentsToValue(value, rootFontSize, inComment = true) {
  if (!value.includes("rem")) return value;

  // Applied right to left: the original walks offsets taken before its first
  // insertion, which misplaces every comment after it.
  const found = [];
  walkValue(parseValue(value), (node) => {
    if (node.type !== "word") return true;
    const u = unit(node.value);
    if (u && u.unit === "rem") found.push({ node, px: `${parseFloat(u.number) * rootFontSize}px` });
    return false;
  });
  for (const { node, px } of found.reverse()) {
    value = inComment
      ? value.slice(0, node.sourceEndIndex) + ` /* ${px} */` + value.slice(node.sourceEndIndex)
      : value.slice(0, node.sourceIndex) + px + value.slice(node.sourceEndIndex);
  }
  return value;
}

// Media queries follow the browser's initial font size, always 16px —
// not the root font size.
const MQ_DIMENSION_RE = /(?<![\w.-])([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(r?em)(?![\w-])/g;
function mediaQueryComments(params) {
  const comments = [];
  for (const m of params.matchAll(MQ_DIMENSION_RE)) {
    comments.push({ index: m.index + m[0].length, value: `${Number(m[1]) * 16}px` });
  }
  return comments;
}

function addPixelEquivalentsToMediaQuery(query) {
  return query.replace(/(?<=^\s*@(?:media|container)\s*).*?$/, (params) =>
    applyComments(params, mediaQueryComments(params)),
  );
}

// ── Colours (util/color, util/colorEquivalents) ──────────────────────────

const COLOR_PROPS = [
  "accent-color",
  "caret-color",
  "color",
  "column-rule-color",
  "background-color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-inline-color",
  "border-inline-start-color",
  "border-inline-end-color",
  "border-block-color",
  "border-block-start-color",
  "border-block-end-color",
  "fill",
  "outline-color",
  "stop-color",
  "stroke",
  "text-decoration-color",
];

const NAMED_COLORS = Object.keys(culori.colorsNamed);

function getKeywordColor(value) {
  if (typeof value !== "string") return null;
  value = value.toLowerCase();
  if (value === "transparent") return "transparent";
  if (value === "currentcolor") return "currentColor";
  return null;
}

function tryParseColor(color) {
  try {
    return culori.parse(color) ?? null;
  } catch {
    return null;
  }
}

function getColorFromValue(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  const keyword = getKeywordColor(trimmed);
  if (keyword) return keyword;

  if (
    !/^\s*(?:rgba?|hsla?|(?:ok)?(?:lab|lch))\s*\([^)]+\)\s*$/.test(trimmed) &&
    !/^\s*#[0-9a-f]+\s*$/i.test(trimmed) &&
    !NAMED_COLORS.includes(trimmed)
  ) {
    return null;
  }

  return tryParseColor(trimmed);
}

function formatColor(color) {
  if (color.alpha === undefined || color.alpha === 1) return culori.formatHex(color);
  return culori.formatHex8(color);
}

function getEquivalentColor(value) {
  const color = getColorFromValue(value);
  if (!color) return value;
  if (typeof color === "string") return value;
  if (!culori.inGamut("rgb")(color)) return value;
  return formatColor(color);
}

const COLOR_MIX_REGEX = /color-mix\(in [^,]+,\s*(.*?)\s*(\d+|\.\d+|\d+\.\d+)%,\s*transparent\)/g;

function removeColorMixWherePossible(str) {
  return str.replace(COLOR_MIX_REGEX, (match, color, percentage) => {
    if (color.startsWith("var(")) return match;

    const parsed = tryParseColor(color);
    if (!parsed) return match;

    const alpha = Number(percentage) / 100;
    if (Number.isNaN(alpha)) return match;

    return culori.formatRgb({ ...parsed, alpha });
  });
}

const LIGHT_DARK_REGEX = /light-dark\(\s*(.*?)\s*,\s*.*?\s*\)/g;

function resolveLightDark(str) {
  return str.replace(LIGHT_DARK_REGEX, (_, lightColor) => lightColor);
}

const COLOR_FNS = new Set(["rgb", "rgba", "hwb", "hsl", "hsla", "lab", "lch", "oklab", "oklch", "color"]);
const COLOR_NAMES = new Set([...NAMED_COLORS.map((c) => c.toLowerCase()), "transparent", "currentcolor"]);
const CSS_VARS = /var\([^)]+\)/;
const COLOR_FN_ARGS =
  /^\s*(?:(?:-?[\d.]+(?:%|deg|g?rad|turn)?|var\([^)]+\))(?:\s*[,/]\s*|\s+)){2,3}(?:-?[\d.]+(?:%|deg|g?rad|turn)?|var\([^)]+\))\s*$/i;

// Spans of colour-looking text: named colours, colour functions, hex.
function maybeFindColors(input) {
  const colors = [];
  const len = input.length;

  for (let i = 0; i < len; ++i) {
    const char = input.charCodeAt(i);
    let inner = char;

    if (char >= 0x61 && char <= 0x7a) {
      // a-z: read a name
      const start = i;
      let end = i;

      for (let j = start + 1; j < len; j++) {
        inner = input.charCodeAt(j);

        if ((inner >= 0x30 && inner <= 0x39) || (inner >= 0x61 && inner <= 0x7a) || inner === 0x2d) {
          end = j;
        } else if (inner === 0x28) {
          break; // start of a function
        } else if (inner === 0x2c || inner === 0x20 || inner === 0x0a || inner === 0x09 || inner === 0x0d || inner === 0x29) {
          break;
        } else {
          end = i;
          break;
        }
      }

      const name = input.slice(start, end + 1);

      if (COLOR_NAMES.has(name)) {
        i = end;
        colors.push([start, end + 1]);
        continue;
      }

      if (inner === 0x28 && COLOR_FNS.has(name)) {
        // Scan to the balancing `)`
        let depth = 1;
        const argStart = end + 2;

        for (let j = argStart; j < len; ++j) {
          inner = input.charCodeAt(j);

          if (inner === 0x5c) {
            j += 1;
          } else if (inner === 0x27 || inner === 0x22) {
            while (++j < len) {
              const nextChar = input.charCodeAt(j);
              if (nextChar === 0x5c) {
                j += 1;
                continue;
              }
              if (nextChar === char) break;
            }
          } else if (inner === 0x28) {
            depth++;
          } else if (inner === 0x29) {
            depth--;
          }

          if (depth > 0) continue;

          const args = input.slice(argStart, j);

          if (!COLOR_FN_ARGS.test(args)) continue;
          colors.push([start, j + 1]);
          i = j + 1;

          break;
        }

        continue;
      }

      i = end;
    } else if (char === 0x23) {
      // #: read hex digits
      const start = i;
      let end = i;
      const last = Math.min(start + 1 + 8, len);

      for (let j = start + 1; j < last; j++) {
        const c = input.charCodeAt(j);

        if ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66)) {
          end = j;
        } else if (c === 0x2c || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x29) {
          break;
        } else {
          end = start;
          break;
        }
      }

      const hexLen = end - start;
      i = end;

      if (hexLen === 3 || hexLen === 4 || hexLen === 6 || hexLen === 8) {
        colors.push([start, end + 1]);
        continue;
      }
    }
  }

  return colors;
}

function parseColors(input) {
  const colors = [];
  const lower = input.toLowerCase();

  for (const [start, end] of maybeFindColors(lower)) {
    const str = input.slice(start, end).replace(CSS_VARS, "1");

    const keyword = getKeywordColor(str);
    if (keyword) {
      colors.push(keyword);
      continue;
    }

    const color = tryParseColor(str);
    if (color) colors.push(color);
  }

  return colors;
}

function getColorsInString(ds, str) {
  if (/(?:box|drop)-shadow/.test(str) && !/--tw-drop-shadow/.test(str)) return [];

  str = replaceCssVarsWithFallbacks(ds, str);
  str = removeColorMixWherePossible(str);
  str = resolveLightDark(str);

  return parseColors(str);
}

const dedupe = (arr) => [...new Set(arr)];

function getColorFromDecls(ds, decls) {
  const props = Object.keys(decls).filter((prop) => {
    if (prop === "content") {
      let value = decls[prop];
      if (Array.isArray(value) && value.length === 1) value = value[0];
      if (value === '""' || value === "''" || value === "var(--tw-content)") return false;
    }
    if (prop === "mask-image" || prop === "mask-composite") return false;
    if (prop === "--tw-drop-shadow") return false;
    return true;
  });

  if (props.length === 0) return null;

  const nonCustomProps = props.filter((prop) => !prop.startsWith("--"));
  const areAllCustom = nonCustomProps.length === 0;

  // Every real property must be a colour property.
  if (!areAllCustom && nonCustomProps.some((prop) => !COLOR_PROPS.includes(prop))) return null;

  const propsToCheck = areAllCustom ? props : nonCustomProps;

  const colors = propsToCheck.flatMap((prop) => decls[prop].flatMap((str) => getColorsInString(ds, str)));

  // One colour, alpha aside
  const colorStrings = dedupe(
    colors.map((color) => (typeof color === "string" ? color : culori.formatRgb({ ...color, alpha: undefined }))),
  );
  if (colorStrings.length !== 1) return null;

  const keyword = getKeywordColor(colorStrings[0]);
  if (keyword) return keyword;

  const nonKeywordColors = colors.filter((color) => typeof color !== "string");
  const alphas = dedupe(nonKeywordColors.map((color) => color.alpha ?? 1));

  if (alphas.length === 1) return nonKeywordColors[0];
  if (alphas.length === 2 && alphas.includes(0)) return nonKeywordColors.find((color) => (color.alpha ?? 1) !== 0);

  return null;
}

function getColorFromRoot(ds, ast) {
  const decls = {};
  walkDecls(ast, (node) => {
    (decls[node.property] ??= []).push(node.value);
  });
  return getColorFromDecls(ds, decls);
}

// IntelliSense's shortcut, kept so the same classes get a swatch: these are
// never (or, for mask-*, deliberately not) treated as colours.
const isNegative = /^-/;
const isNumericUtility =
  /^-?((min-|max-)?[wh]|z|start|indent|flex|columns|order|rounded|row|col|size|basis|end|delay|duration|ease|font|top|left|bottom|right|leading|cursor|(backdrop-)?(opacity|brightness|sepia|saturate|hue-rotate|grayscale|contrast|blur)|(space|scale|skew|rotate|translate|border-spacing|gap)(-[xyz])?|(scroll-)?[pm][trblxyse]?)-/;
const isMaskUtility = /^-?mask-/;

function isLikelyColorless(className) {
  return isNegative.test(className) || isNumericUtility.test(className) || isMaskUtility.test(className);
}

/**
 * The colour IntelliSense would show for `className`, as the editor needs
 * it: `"transparent"` / `"currentColor"` for the keywords, `#rrggbb` when
 * opaque, `rgba(r, g, b, a)` otherwise — the forms Monaco draws a swatch
 * for (IntelliSense writes 8-digit hex, which Monaco's swatch ignores).
 *
 * @param {Object} ds
 * @param {string} className
 * @param {Array<Object>} [ast]  Already compiled, to skip compiling again.
 * @returns {string|null}
 */
function colorOf(ds, className, ast) {
  if (isLikelyColorless(className)) return null;
  const color = getColorFromRoot(ds, ast || compile(ds, className));
  if (!color) return null;
  if (typeof color === "string") return color;
  if (color.alpha === undefined || color.alpha === 1) return culori.formatHex(color);
  return culori.formatRgb(color);
}

// ── Theme comments (rewriting/add-theme-values, util/equivalents) ────────

// Comments for one declaration value, offsets into that value. IntelliSense
// rewrites the whole stylesheet; every var(…) and calc(…) sits in a value,
// so per value is the same result.
function themeValueComments(value, ds) {
  const comments = [];
  const replaced = [];

  replaceCssCalc(value, (expr) => {
    const inlined = replaceCssVars(expr.value, {
      replace({ name }) {
        if (!name.startsWith("--")) return null;
        let v = resolveVariableValue(ds, name);
        if (v === null) return null;
        return replaceCssCalc(v, (e) => evaluateExpression(e.value));
      },
    });

    const evaluated = evaluateExpression(inlined);
    if (expr.value === evaluated) return null;
    if (!evaluated) return null;

    replaced.push(expr.range);

    const px = addPixelEquivalentsToValue(evaluated, ROOT_FONT_SIZE, false);
    if (px !== evaluated) {
      comments.push({ index: expr.range.end + 1, value: `${evaluated} = ${px}` });
      return null;
    }

    const color = getEquivalentColor(evaluated);
    if (color !== evaluated) {
      comments.push({ index: expr.range.end + 1, value: `${evaluated} = ${color}` });
      return null;
    }

    comments.push({ index: expr.range.end + 1, value: evaluated });
    return null;
  });

  replaceCssVars(value, {
    recursive: false,
    replace({ name, range }) {
      if (!name.startsWith("--")) return null;

      for (const r of replaced) {
        if (r.start <= range.start && r.end >= range.end) return null;
      }

      let v = resolveVariableValue(ds, name);
      if (v === null) return null;

      const px = addPixelEquivalentsToValue(v, ROOT_FONT_SIZE, false);
      if (px !== v) {
        comments.push({ index: range.end + 1, value: `${v} = ${px}` });
        return null;
      }

      const color = getEquivalentColor(v);
      if (color !== v) {
        comments.push({ index: range.end + 1, value: `${v} = ${color}` });
        return null;
      }

      v = replaceCssCalc(v, (expr) => {
        const evaluated = evaluateExpression(expr.value);
        if (!evaluated) return null;
        if (evaluated === expr.value) return null;
        return `calc(${expr.value}) ≈ ${evaluated}`;
      });

      comments.push({ index: range.end + 1, value: v });
      return null;
    },
  });

  return comments;
}

const COLOR_EQUIVALENT_FNS = ["rgb", "rgba", "hsl", "hsla", "lch", "lab", "oklch", "oklab"];

function colorEquivalentComments(value) {
  const comments = [];
  if (!COLOR_EQUIVALENT_FNS.some((fn) => value.includes(fn))) return comments;

  walkValue(parseValue(value), (node) => {
    if (node.type !== "function") return true;
    if (node.value === "var") return true;
    if (!COLOR_EQUIVALENT_FNS.includes(node.value)) return false;

    const values = node.nodes.filter((n) => n.type === "word").map((n) => n.value);
    if (values.length < 3) return false;

    const color = `${node.value}(${values.join(" ")})`;
    const equivalent = getEquivalentColor(color);
    if (equivalent !== color) comments.push({ index: node.sourceEndIndex, value: equivalent });

    return false;
  });

  return comments;
}

function annotateValue(value, ds) {
  return applyComments(value, [
    ...themeValueComments(value, ds),
    ...remComments(value, ROOT_FONT_SIZE),
    ...colorEquivalentComments(value),
  ]);
}

// ── Stringify (util/jit: stringifyRoot, stringifyDecls) ──────────────────

/**
 * Print Tailwind AST nodes the way IntelliSense shows them: two-space
 * indent, every declaration closed with `;`, theme values and pixel/colour
 * equivalents added as comments.
 *
 * @param {Object} ds
 * @param {Array<Object>} nodes
 * @returns {string}
 */
function stringifyRoot(ds, nodes) {
  const lines = [];

  function print(node, depth) {
    const pad = "  ".repeat(depth);
    if (node.kind === "declaration") {
      lines.push(`${pad}${node.property}: ${annotateValue(node.value ?? "", ds)}${node.important ? " !important" : ""};`);
    } else if (node.kind === "rule") {
      lines.push(`${pad}${node.selector} {`);
      for (const child of node.nodes) print(child, depth + 1);
      lines.push(`${pad}}`);
    } else if (node.kind === "at-rule") {
      let head = node.params ? `${node.name} ${node.params}` : node.name;
      if (node.name === "@media" || node.name === "@container") {
        head = `${node.name} ${applyComments(node.params, mediaQueryComments(node.params))}`;
      }
      if (!node.nodes) {
        lines.push(`${pad}${head};`);
      } else if (node.nodes.length === 0) {
        lines.push(`${pad}${head} {}`);
      } else {
        lines.push(`${pad}${head} {`);
        for (const child of node.nodes) print(child, depth + 1);
        lines.push(`${pad}}`);
      }
    } else if (node.kind === "comment") {
      lines.push(`${pad}/*${node.value}*/`);
    }
    // at-root and context nodes do not survive candidatesToAst
  }

  for (const node of nodes) print(node, 0);
  return lines.join("\n");
}

const IGNORED_DETAIL_VALUES = new Set([
  "var(--tw-border-style)",
  "var(--tw-outline-style)",
  "var(--tw-translate-x) var(--tw-translate-y)",
  "var(--tw-translate-x) var(--tw-translate-y) var(--tw-translate-z)",
  "var(--tw-scale-x) var(--tw-scale-y)",
  "var(--tw-scale-x) var(--tw-scale-y) var(--tw-scale-z)",
]);

function isOtherDecl(node) {
  if (node.property === "--tw-leading") return false;
  if (node.property === "--tw-duration") return false;
  if (node.property === "--tw-ease") return false;
  if (node.property === "--tw-font-weight") return false;
  if (node.property === "--tw-gradient-via-stops") return false;
  if (node.property === "--tw-gradient-stops") return false;
  if (node.property === "--tw-tracking") return false;
  if (node.property === "--tw-space-x-reverse" && node.value === "0") return false;
  if (node.property === "--tw-space-y-reverse" && node.value === "0") return false;
  if (node.property === "--tw-divide-x-reverse" && node.value === "0") return false;
  if (node.property === "--tw-divide-y-reverse" && node.value === "0") return false;
  return true;
}

// The one-line summary beside a completion: `padding: 1rem /* 16px */;`.
function stringifyDecls(ds, ast) {
  let decls = [];
  walkDecls(ast, (node) => {
    if (!IGNORED_DETAIL_VALUES.has(node.value)) decls.push(node);
  });

  // Bookkeeping declarations go, as long as they are not the only ones.
  if (decls.some(isOtherDecl)) decls = decls.filter(isOtherDecl);

  return decls
    .map(({ property, value }) => {
      value = inlineThemeValues(value, ds).trim();
      value = addPixelEquivalentsToValue(value, ROOT_FONT_SIZE);
      return `${property}: ${value};`;
    })
    .join(" ");
}

// ── Diagnostics (diagnostics/getCssConflictDiagnostics, canonical-classes) ──

// CSS.escape (CSSOM), as the css.escape package IntelliSense uses.
function cssEscape(value) {
  const string = String(value);
  const length = string.length;
  const firstCodeUnit = string.charCodeAt(0);
  let result = "";
  for (let index = 0; index < length; index++) {
    const codeUnit = string.charCodeAt(index);
    if (codeUnit === 0x0000) {
      result += "\uFFFD";
    } else if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
    ) {
      result += "\\" + codeUnit.toString(16) + " ";
    } else if (index === 0 && length === 1 && codeUnit === 0x002d) {
      result += "\\" + string.charAt(index);
    } else if (
      codeUnit >= 0x0080 ||
      codeUnit === 0x002d ||
      codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      result += string.charAt(index);
    } else {
      result += "\\" + string.charAt(index);
    }
  }
  return result;
}

/**
 * What the CSS-conflict check compares between two classes of one list
 * (recordClassDetails): per rule or at-rule that holds declarations, its
 * property names and where it applies — the selectors and at-rules around
 * it, with the class's own selector written as `&` so `p-2` and `p-4`
 * compare equal.
 *
 * @param {Array<Object>} ast
 * @param {string} className
 * @returns {Array<{properties: Array<string>, context: Array<string>}>}
 */
function conflictRules(ast, className) {
  const entries = [];
  const classSelector = `.${cssEscape(className)}`;

  function walk(nodes, path) {
    for (const node of nodes) {
      if (node.kind !== "rule" && node.kind !== "at-rule") continue;

      const properties = [];
      for (const child of node.nodes || []) {
        if (child.kind === "declaration") properties.push(child.property);
      }

      if (properties.length > 0) {
        entries.push({
          properties,
          context: [...path, node]
            .map((n) => (n.kind === "rule" ? n.selector.replaceAll(classSelector, "&") : `${n.name} ${n.params}`))
            .filter((selector) => selector !== "" && selector !== "&"),
        });
      }

      if (node.nodes) walk(node.nodes, [...path, node]);
    }
  }

  walk(ast, []);
  return entries;
}

/**
 * Everything the editor shows for one candidate, or `null` when Tailwind
 * does not generate anything for it.
 *
 * - `hover`: the whole output, `@property` registrations included — what
 *   IntelliSense's hover shows.
 * - `documentation`: the completion item's CSS preview — the top-level
 *   rules. When there are none, which is the case for any candidate with a
 *   variant (the AST then starts at `@media`, `@supports`, …), the output
 *   minus `@property`: IntelliSense shows nothing there, which reads as a
 *   bug rather than a choice.
 * - `detail`: the one-line declaration summary, or `N rules`.
 * - `color`: as `colorOf`.
 * - `rules`: what the CSS-conflict diagnostic compares (`conflictRules`).
 *
 * The canonical spelling is not here: it comes from a worker thread
 * (canonical.js), and nothing that waits for this should wait for that.
 *
 * @param {Object} ds
 * @param {string} candidate
 * @returns {{hover: string, documentation: string|null, detail: string|null, color: string|null, rules: Array<Object>}|null}
 */
function describeCandidate(ds, candidate) {
  const ast = compile(ds, candidate);
  if (ast.length === 0) return null;

  const rules = ast.filter((node) => node.kind === "rule");
  const shown = rules.length ? rules : ast.filter((node) => !isHiddenAtRule(node));

  return {
    hover: stringifyRoot(ds, ast),
    documentation: shown.length ? stringifyRoot(ds, shown) : null,
    detail: shown.length === 1 ? stringifyDecls(ds, ast) : shown.length > 1 ? `${shown.length} rules` : null,
    color: colorOf(ds, candidate, ast),
    rules: conflictRules(ast, candidate),
  };
}

/**
 * Variants with what IntelliSense shows beside each completion: `detail`
 * for the bare variant (`hover:`) — `null` when it has none to offer, as
 * for `group` which needs a value — and one entry per value (`group-hover:`)
 * in `valueDetails`, `null` where that value produces nothing.
 * `failed` marks a variant whose selectors could not be computed:
 * IntelliSense then offers only its `[…]` form.
 *
 * @param {Object} ds
 * @returns {Array<Object>}
 */
function variantList(ds) {
  return ds.getVariants().map((variant) => {
    const values = variant.values || [];
    let detail = null;
    let failed = false;
    try {
      const selectors = variant.selectors({});
      if (selectors.length > 0) {
        detail = selectors.map((selector) => addPixelEquivalentsToMediaQuery(selector)).join(", ");
      }
    } catch {
      failed = true;
    }
    const valueDetails = failed
      ? []
      : values.map((value) => {
          let selectors = [];
          try {
            selectors = variant.selectors({ value });
          } catch {
            // as IntelliSense: a value whose selectors throw is not offered
          }
          return selectors.length ? selectors.join(", ") : null;
        });
    return {
      name: variant.name,
      values,
      hasDash: !!variant.hasDash,
      isArbitrary: !!variant.isArbitrary,
      detail,
      valueDetails,
      failed,
    };
  });
}

module.exports = {
  describeCandidate,
  variantList,
  colorOf,
  isLikelyColorless,
  compile,
  // exported for tests
  cssEscape,
  conflictRules,
  stringifyRoot,
  stringifyDecls,
  inlineThemeValues,
  addPixelEquivalentsToValue,
  addPixelEquivalentsToMediaQuery,
  getEquivalentColor,
  replaceCssVars,
  replaceCssCalc,
  evaluateExpression,
  parseValue,
};
