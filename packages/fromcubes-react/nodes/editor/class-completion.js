/**
 * className completion, diagnostics and colour squares — the logic of
 * Tailwind CSS IntelliSense (the VS Code extension), pure: where class lists
 * are, which variants are already typed, which items to offer and how to
 * sort them, which classes conflict or have a canonical spelling, which
 * carry a colour. No DOM, no Monaco, no network; the glue in
 * portal-react.html feeds it the engine's data (GET
 * /fromcubes-react/css-classes, /css-describe) and maps the results onto
 * Monaco.
 *
 * Ported from tailwindcss-intellisense (packages/tailwindcss-language-service:
 * completionProvider.ts, util/getVariantsFromClassName.ts, util/lexers.ts,
 * util/find.ts, util/doc.ts, util/segment.ts, util/naturalExpand.ts,
 * util/joinWithAnd.ts, util/removeRangesFromString.ts, documentColorProvider.ts,
 * diagnostics/getCssConflictDiagnostics.ts, diagnostics/canonical-classes.ts,
 * codeActions/, and the server's colour presentations — MIT,
 * © Tailwind Labs, Inc.; see THIRD-PARTY-NOTICES.md). Names follow the
 * originals; departures are commented.
 *
 * Loaded in the browser by the asset loader in portal-react.html
 * (`<base>/editor/class-completion.js`, exposes `window.__fcClassCompletion`)
 * and in tests via `require()`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.__fcClassCompletion = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** How far before the cursor a class attribute is looked for. */
  const SEARCH_RANGE = 15000;

  /** IntelliSense's trigger characters, plus its separator `:`. */
  const TRIGGER_CHARACTERS = ['"', "'", "`", " ", ".", "(", "[", "]", "!", "/", "-", ":"];

  /** `tailwindCSS.classAttributes` default. */
  const CLASS_ATTRIBUTES = ["class", "className", "ngClass", "class:list"];

  /** Matches MAX_DESCRIBE in lib/providers.js — candidates per request. */
  const MAX_DESCRIBE = 64;

  const SEP = ":";

  // ── text ─────────────────────────────────────────────────────────────

  const JS_TOKEN_RE = /\/\/.*$|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/gm;

  /**
   * Blank out `//` and block comments, keeping length and line breaks, so
   * a commented-out `className="…"` is not taken for a live one. One regex
   * pass is the same tokenisation as the original's lexer: at each spot the
   * first alternative that matches wins. (Its regex-literal stripping is not
   * ported.)
   *
   * @param {string} text
   * @returns {string}
   */
  function jsWithoutComments(text) {
    return text.replace(JS_TOKEN_RE, function (m) {
      if (m[0] !== "/") return m;
      return m.replace(/[^\n]/g, " ");
    });
  }

  /**
   * Split `input` on `separator` at the top level only — not inside
   * `(…)`, `[…]`, `{…}` or quotes.
   *
   * @param {string} input
   * @param {string} separator  One character.
   * @returns {Array<string>}
   */
  function segment(input, separator) {
    const closing = [];
    const parts = [];
    let lastPos = 0;
    for (let idx = 0; idx < input.length; idx++) {
      const char = input[idx];
      if (closing.length === 0 && char === separator) {
        parts.push(input.slice(lastPos, idx));
        lastPos = idx + 1;
        continue;
      }
      switch (char) {
        case "\\":
          idx += 1;
          break;
        case "'":
        case '"':
          while (++idx < input.length) {
            if (input[idx] === "\\") {
              idx += 1;
              continue;
            }
            if (input[idx] === char) break;
          }
          break;
        case "(":
          closing.push(")");
          break;
        case "[":
          closing.push("]");
          break;
        case "{":
          closing.push("}");
          break;
        case ")":
        case "]":
        case "}":
          if (closing.length > 0 && char === closing[closing.length - 1]) closing.pop();
          break;
      }
    }
    parts.push(input.slice(lastPos));
    return parts;
  }

  /**
   * @param {number} value
   * @param {number} [total]
   * @returns {string}  `value` zero-padded to the width of `total` (else 8)
   */
  function naturalExpand(value, total) {
    const length = typeof total === "number" ? total.toString().length : 8;
    return ("0".repeat(length) + value).slice(-length);
  }

  // ── where the class list is (util/lexers.ts, util/find.ts) ──────────────

  function rule(type, re, action) {
    return { type: type, re: new RegExp(re, "y"), push: action && action.push, pop: !!(action && action.pop) };
  }

  const CLASS_ATTRIBUTE_STATES = {
    doubleClassList: [
      rule("arb", "(?<!\\\\)\\[", { push: "arbitrary" }),
      rule("lbrace", "(?<!\\\\)\\{", { push: "interpBrace" }),
      rule("rbrace", "(?<!\\\\)\\}", { pop: true }),
      rule("end", '(?<!\\\\)"', { pop: true }),
      rule("classlist", "[\\s\\S]"),
    ],
    singleClassList: [
      rule("lbrace", "(?<!\\\\)\\{", { push: "interpBrace" }),
      rule("rbrace", "(?<!\\\\)\\}", { pop: true }),
      rule("end", "(?<!\\\\)'", { pop: true }),
      rule("classlist", "[\\s\\S]"),
    ],
    tickClassList: [
      rule("lbrace", "(?<=(?<!\\\\)\\$)\\{", { push: "interpBrace" }),
      rule("rbrace", "(?<!\\\\)\\}", { pop: true }),
      rule("end", "(?<!\\\\)`", { pop: true }),
      rule("classlist", "[\\s\\S]"),
    ],
    interpBrace: [
      rule("startSingle", "(?<!\\\\)'", { push: "singleClassList" }),
      rule("startDouble", '(?<!\\\\)"', { push: "doubleClassList" }),
      rule("startTick", "(?<!\\\\)`", { push: "tickClassList" }),
      rule("lbrace", "(?<!\\\\)\\{", { push: "interpBrace" }),
      rule("rbrace", "(?<!\\\\)\\}", { pop: true }),
      rule("text", "[\\s\\S]"),
    ],
    interpParen: [
      rule("startSingle", "(?<!\\\\)'", { push: "singleClassList" }),
      rule("startDouble", '(?<!\\\\)"', { push: "doubleClassList" }),
      rule("startTick", "(?<!\\\\)`", { push: "tickClassList" }),
      rule("lbrace", "(?<!\\\\)\\(", { push: "interpParen" }),
      rule("rbrace", "(?<!\\\\)\\)", { pop: true }),
      rule("text", "[\\s\\S]"),
    ],
    interpSingle: [
      rule("startDouble", '(?<!\\\\)"', { push: "doubleClassList" }),
      rule("startTick", "(?<!\\\\)`", { push: "tickClassList" }),
      rule("single", "(?<!\\\\)'", { pop: true }),
      rule("text", "[\\s\\S]"),
    ],
    interpDouble: [
      rule("startSingle", "(?<!\\\\)'", { push: "singleClassList" }),
      rule("startTick", "(?<!\\\\)`", { push: "tickClassList" }),
      rule("double", '(?<!\\\\)"', { pop: true }),
      rule("text", "[\\s\\S]"),
    ],
    arbitrary: [
      rule("arb", "(?<!\\\\)\\]", { pop: true }),
      rule("space", "\\s", { pop: true }),
      rule("arb2", "[\\s\\S]"),
    ],
  };

  const CLASS_ATTRIBUTE_LEXER = Object.assign(
    {
      main: [
        rule("start1", '"', { push: "doubleClassList" }),
        rule("start2", "'", { push: "singleClassList" }),
        rule("start3", "\\{", { push: "interpBrace" }),
        rule("start4", "`", { push: "tickClassList" }),
        rule("start5", "\\(", { push: "interpParen" }),
      ],
    },
    CLASS_ATTRIBUTE_STATES,
  );

  const COMPUTED_CLASS_ATTRIBUTE_LEXER = Object.assign(
    {
      main: [
        rule("lbrace", "\\{", { push: "interpBrace" }),
        rule("single", "'", { push: "interpSingle" }),
        rule("double", '"', { push: "interpDouble" }),
      ],
    },
    CLASS_ATTRIBUTE_STATES,
  );

  /**
   * A state-machine lexer with moo's semantics: in each state the first
   * rule that matches at the position wins; no match is a syntax error,
   * which ends the run (`failed`) with the tokens read so far.
   *
   * @param {Object<string, Array<Object>>} states
   * @param {string} input
   * @param {number} [start]  Where in `input` to begin (offsets count from it).
   * @returns {{tokens: Array<{type: string, value: string, offset: number}>, failed: boolean}}
   */
  function lex(states, input, start) {
    const tokens = [];
    const stack = [];
    const from = start || 0;
    let state = "main";
    let pos = from;
    while (pos < input.length) {
      const rules = states[state];
      let hit = null;
      let value = "";
      for (let i = 0; i < rules.length; i++) {
        rules[i].re.lastIndex = pos;
        const m = rules[i].re.exec(input);
        if (m) {
          hit = rules[i];
          value = m[0];
          break;
        }
      }
      if (!hit) return { tokens: tokens, failed: true };
      tokens.push({ type: hit.type, value: value, offset: pos - from });
      pos += value.length;
      if (hit.push) {
        stack.push(state);
        state = hit.push;
      } else if (hit.pop && stack.length) {
        state = stack.pop();
      }
    }
    return { tokens: tokens, failed: false };
  }

  const CLASS_ATTRIBUTE_RE = new RegExp(
    "(?:\\s|:|\\()(" +
      CLASS_ATTRIBUTES.flatMap(function (a) {
        return [a, "\\[" + a + "\\]"];
      }).join("|") +
      ")\\s*=\\s*['\"`{]",
    "gi",
  );

  function lexerFor(match) {
    const computed = match[0][0] === ":" || (match[1].startsWith("[") && match[1].endsWith("]"));
    return computed ? COMPUTED_CLASS_ATTRIBUTE_LEXER : CLASS_ATTRIBUTE_LEXER;
  }

  /**
   * The class list the cursor is in — the text from its start to the
   * cursor — or `null` outside one. `text` ends at the cursor and is already
   * without comments. As IntelliSense: the last class attribute before the
   * cursor is lexed up to it; the cursor is in its class list when the last
   * token is part of one.
   *
   * @param {string} text
   * @returns {string|null}
   */
  function findClassList(text) {
    CLASS_ATTRIBUTE_RE.lastIndex = 0;
    let match = null;
    let m;
    while ((m = CLASS_ATTRIBUTE_RE.exec(text)) !== null) match = m;
    if (!match) return null;

    const lexed = lex(lexerFor(match), text, match.index + match[0].length - 1);
    if (lexed.failed) return null;
    const tokens = lexed.tokens;
    const last = tokens[tokens.length - 1];
    if (!last) return null;
    if (!(last.type.startsWith("start") || last.type === "classlist" || last.type.startsWith("arb"))) return null;

    let classList = "";
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].type === "classlist" || tokens[i].type.startsWith("arb")) {
        classList = tokens[i].value + classList;
      } else {
        break;
      }
    }
    return classList;
  }

  /**
   * Every class list of every class attribute in `text` (comments already
   * blanked), the way IntelliSense finds them for diagnostics and colour
   * squares: offsets into `text`, surrounding whitespace trimmed, a list
   * lexed up to a syntax error still counted, each range once.
   *
   * @param {string} text
   * @returns {Array<{classList: string, start: number, end: number}>}
   */
  function findClassListsInText(text) {
    const results = [];
    const seen = new Set();
    const re = new RegExp(CLASS_ATTRIBUTE_RE.source, "gi");
    let match;
    while ((match = re.exec(text)) !== null) {
      const base = match.index + match[0].length - 1;
      const lists = [];
      let current = null;
      for (const token of lex(lexerFor(match), text, base).tokens) {
        if (token.type === "classlist" || token.type.startsWith("arb")) {
          if (current) current.value += token.value;
          else current = { value: token.value, offset: token.offset };
        } else {
          if (current) lists.push(current);
          current = null;
        }
      }
      if (current) lists.push(current);

      for (const list of lists) {
        if (list.value.trim() === "") continue;
        const before = /^\s*/.exec(list.value)[0].length;
        const after = /\s*$/.exec(list.value)[0].length;
        const start = base + list.offset + before;
        const end = base + list.offset + list.value.length - after;
        const key = start + ":" + end;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ classList: text.slice(start, end), start: start, end: end });
      }
    }
    return results;
  }

  /**
   * The classes of one list with their offsets — absolute (`start`, `end`)
   * and within the list (`relStart`, `relEnd`).
   *
   * @param {{classList: string, start: number}} list
   * @returns {Array<{className: string, start: number, end: number, relStart: number, relEnd: number, list: Object}>}
   */
  function getClassNamesInClassList(list) {
    const parts = list.classList.split(/(\s+)/);
    const names = [];
    let index = 0;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0 && parts[i]) {
        names.push({
          className: parts[i],
          start: list.start + index,
          end: list.start + index + parts[i].length,
          relStart: index,
          relEnd: index + parts[i].length,
          list: list,
        });
      }
      index += parts[i].length;
    }
    return names;
  }

  /**
   * @param {Array<Object>} classLists
   * @returns {Array<string>}  each class written in them, once
   */
  function uniqueClassNames(classLists) {
    const set = new Set();
    for (const list of classLists) {
      for (const c of getClassNamesInClassList(list)) set.add(c.className);
    }
    return Array.from(set);
  }

  // ── the engine's data ────────────────────────────────────────────────

  /**
   * Index the engine's completion data in place (idempotent): class name →
   * position, the variant names IntelliSense matches literally, and a cache
   * for answers from the server.
   *
   * @param {Object} data  GET /fromcubes-react/css-classes
   * @returns {Object} data
   */
  function prepare(data) {
    if (data._index) return data;
    const index = new Map();
    for (let i = 0; i < data.classes.length; i++) index.set(data.classes[i], i);
    const all = new Set();
    for (const variant of data.variants || []) {
      if (variant.values.length) {
        for (const value of variant.values) {
          all.add(value === "DEFAULT" ? variant.name : variant.name + (variant.hasDash ? "-" : "") + value);
        }
      } else {
        all.add(variant.name);
      }
    }
    Object.defineProperty(data, "_index", { value: index });
    Object.defineProperty(data, "_allVariants", { value: all });
    // Kept when the glue carries them over from the previous fetch.
    if (!data._described) Object.defineProperty(data, "_described", { value: new Map() });
    if (!data._canonical) Object.defineProperty(data, "_canonical", { value: new Map() });
    return data;
  }

  /**
   * @param {Object} data
   * @param {string} className
   * @returns {Array<string>}
   */
  function modifiersOf(data, className) {
    const i = data._index.get(className);
    if (i === undefined) return [];
    const m = data.classModifiers[i];
    return m >= 0 ? data.modifiers[m] : [];
  }

  /**
   * Whether `part` is worth asking the engine about as a variant — only
   * text shaped like one of its variants (`group-hover/x`, `data-[…]`,
   * `@md/x`, `[&>*]`). IntelliSense compiles every candidate locally; here
   * each check is a request, so `bg-red-` is not one.
   *
   * @param {Object} data
   * @param {string} part
   * @returns {boolean}
   */
  function mayBeVariant(data, part) {
    if (!part) return false;
    if (part[0] === "[") return true;
    for (const variant of data.variants || []) {
      const name = variant.name;
      if (part === name) return true;
      if (part.startsWith(name + "/") || part.startsWith(name + "[")) return true;
      if (variant.hasDash ? part.startsWith(name + "-") : part.startsWith(name)) return true;
    }
    return false;
  }

  /**
   * @param {Object} data
   * @param {string} token  One class as typed, variants and all.
   * @returns {boolean}  whether its utility is one the engine lists
   */
  function isKnownClass(data, token) {
    const parts = segment(token, SEP);
    let base = parts[parts.length - 1];
    if (base.endsWith("!")) base = base.slice(0, -1);
    else if (base.startsWith("!")) base = base.slice(1);
    if (data._index.has(base)) return true;
    const slash = base.lastIndexOf("/");
    return slash > 0 && modifiersOf(data, base.slice(0, slash)).length > 0;
  }

  // ── class list → items (completionProvider.ts) ───────────────────────

  /**
   * The variants already typed in front of the class: `hover:md:bg-` →
   * `["hover", "md"]`, and how far into the class name they reach.
   * `isValidVariant` answers for parts that are not one of the listed
   * variant names (`group-hover/item`, `data-[open]`); it may be async.
   *
   * @param {Object} data
   * @param {string} className
   * @param {function(string): (boolean|Promise<boolean>)} [isValidVariant]
   * @returns {Promise<{variants: Array<string>, offset: number}>}
   */
  async function getVariantsFromClassName(data, className, isValidVariant) {
    const parts = segment(className, SEP);
    if (parts.length < 2) return { variants: [], offset: 0 };

    let offset = 0;
    const variants = new Set();

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      // An empty part is `hover::` (not a class) or a trailing `:` (a
      // utility comes next): either way the variants end here.
      if (part === "") break;
      const valid = data._allVariants.has(part) || (isValidVariant ? await isValidVariant(part) : false);
      if (!valid) break;

      variants.add(part);
      offset += part.length;
      // Every variant but the last is followed by the separator.
      offset += index < parts.length - 1 ? SEP.length : 0;
    }

    return { variants: Array.from(variants), offset: offset };
  }

  /**
   * The completion list for the class list ending at the cursor — what
   * IntelliSense's completionsFromClassList returns for Tailwind v4.
   *
   * Items carry a `kind` (`variant`, `color`, `constant`), `label`,
   * `sortText`, and as needed `detail`, `documentation` (a swatch colour),
   * `insertText` (`snippet` when it is one), `filterText`, `retrigger` (open
   * the list again once inserted, as after `hover:`). `range` is relative
   * to the cursor: the replaced text starts `-range.start` characters
   * before it. `variants`/`important` are what the class items stand under,
   * for fetching their CSS; `modifiers` marks a list of `/…` modifiers,
   * whose colours the caller fetches (IntelliSense compiles each one).
   *
   * @param {Object} data  prepare()d engine data
   * @param {string} classList  Class list text up to the cursor.
   * @param {{triggerKind: "invoke"|"character"|"incomplete", triggerCharacter?: string}} [context]
   * @param {function(string): (boolean|Promise<boolean>)} [isValidVariant]
   * @returns {Promise<Object>}
   */
  async function completionsFromClassList(data, classList, context, isValidVariant) {
    const classNames = classList.split(/[\s+]/);
    const partialClassName = classNames[classNames.length - 1];
    let start = 0 - partialClassName.length; // not -0 for an empty one

    const found = await getVariantsFromClassName(data, partialClassName, isValidVariant);
    const existingVariants = found.variants;
    const offset = found.offset;

    if (
      context &&
      (context.triggerKind === "invoke" || (context.triggerKind === "character" && context.triggerCharacter === "/")) &&
      partialClassName.includes("/")
    ) {
      const beforeSlash = partialClassName.split("/").slice(0, -1).join("/");
      const baseClassName = beforeSlash.slice(offset);
      const modifiers = modifiersOf(data, baseClassName);

      if (modifiers.length > 0) {
        return {
          range: { start: start, end: 0 },
          variants: [],
          important: false,
          modifiers: true,
          items: modifiers.map(function (modifier, index) {
            return { label: beforeSlash + "/" + modifier, kind: "constant", sortText: naturalExpand(index) };
          }),
        };
      }
    }

    start += offset;

    // IntelliSense ends the range before a trailing `!`; Monaco wants the
    // cursor inside the range, so the `!` stays in it and goes back in
    // through insertText (and filterText, to keep matching).
    const important = partialClassName.substr(offset).endsWith("!");

    const items = [];
    const seenVariants = new Set();
    let variantOrder = 0;

    function variantItem(item) {
      item.kind = "variant";
      item.sortText = "-" + naturalExpand(variantOrder++);
      if (!item.snippet) item.retrigger = true;
      return item;
    }

    for (const variant of data.variants || []) {
      if (existingVariants.includes(variant.name)) continue;
      if (seenVariants.has(variant.name)) continue;
      seenVariants.add(variant.name);

      const dash = variant.hasDash ? "-" : "";

      if (variant.isArbitrary) {
        items.push(
          variantItem({
            label: variant.name + dash + "[]" + SEP,
            insertText: variant.name + dash + "[${1}]" + SEP + "${0}",
            snippet: true,
          }),
        );
      }

      // Its selectors could not be computed: nothing more is offered.
      if (variant.failed) continue;

      // A variant that outputs nothing on its own (`group`) is offered only
      // with its values.
      if (variant.detail !== null && variant.detail !== undefined) {
        items.push(variantItem({ label: variant.name + SEP, detail: variant.detail, insertText: variant.name + SEP }));
      }

      for (let i = 0; i < variant.values.length; i++) {
        const value = variant.values[i];
        const key = variant.name + "-" + value;
        if (existingVariants.includes(key)) continue;
        if (seenVariants.has(key)) continue;
        seenVariants.add(key);

        const detail = variant.valueDetails[i];
        if (detail === null || detail === undefined) continue;

        items.push(
          variantItem({
            label: value === "DEFAULT" ? variant.name + SEP : variant.name + dash + value + SEP,
            detail: detail,
          }),
        );
      }
    }

    const total = data.classes.length;
    for (let index = 0; index < total; index++) {
      const className = data.classes[index];
      const color = data.colors[index];
      const item = { label: className, kind: color ? "color" : "constant", sortText: naturalExpand(index, total) };
      // The keywords are colours without a swatch.
      if (color && color !== "transparent" && color !== "currentColor") item.documentation = color;
      if (important) {
        item.insertText = className + "!";
        item.filterText = className + "!";
      }
      items.push(item);
    }

    return { range: { start: start, end: 0 }, variants: existingVariants, important: important, modifiers: false, items: items };
  }

  /**
   * Give modifier items the colours the engine reports for them: Color kind,
   * and a swatch unless the colour is a keyword or fully transparent.
   *
   * @param {Array<Object>} items
   * @param {Array<Object|null>} described  describe() results, item by item
   * @returns {Array<Object>} items
   */
  function applyModifierColors(items, described) {
    items.forEach(function (item, i) {
      const color = described[i] && described[i].color;
      if (!color) return;
      item.kind = "color";
      if (color !== "transparent" && color !== "currentColor" && !/,\s*0\)$/.test(color)) {
        item.documentation = color;
      }
    });
    return items;
  }

  // ── diagnostics (diagnostics/, codeActions/) ─────────────────────────

  // Order-insensitive, as IntelliSense's `equal`.
  function equal(a, b) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    const x = a.concat().sort();
    const y = b.concat().sort();
    for (let i = 0; i < x.length; ++i) if (x[i] !== y[i]) return false;
    return true;
  }

  function joinWithAnd(strings) {
    return strings.reduce(function (acc, cur, i) {
      if (i === 0) return cur;
      if (strings.length > 1 && i === strings.length - 1) return acc + " and " + cur;
      return acc + ", " + cur;
    }, "");
  }

  /**
   * Cut ranges out of a class list, each with the whitespace before it.
   *
   * @param {string} str
   * @param {Array<{start: number, end: number}>} ranges
   * @returns {string}
   */
  function removeRangesFromString(str, ranges) {
    const indexRanges = ranges.map(function (range) {
      let start = range.start;
      for (let i = start - 1; i >= 0; i--) {
        if (/\s/.test(str.charAt(i))) start = i;
        else break;
      }
      return { start: start, end: range.end };
    });
    indexRanges.sort(function (a, b) {
      return a.start - b.start;
    });
    let result = "";
    let i = 0;
    indexRanges.forEach(function (r) {
      result += str.substring(i, r.start);
      i = r.end;
    });
    return (result + str.substring(i)).trim();
  }

  /**
   * Pairs of a class and the others in its list that set the same CSS
   * properties in the same place — same rules, same properties, same
   * selectors and at-rules around them.
   *
   * @param {Array<Object>} classNames
   * @param {Map<string, Array<{properties: Array<string>, context: Array<string>}>>} groups
   * @returns {Array<[Object, Array<Object>]>}
   */
  function findConflicts(classNames, groups) {
    const out = [];
    for (const className of classNames) {
      const entries = groups.get(className.className) || [];
      const conflicting = [];

      for (const other of classNames) {
        if (className === other) continue;
        const otherEntries = groups.get(other.className) || [];
        if (entries.length !== otherEntries.length) continue;

        let hasConflict = false;
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const otherEntry = otherEntries[i];
          if (entry.properties.length !== otherEntry.properties.length) {
            hasConflict = false;
            break;
          }
          if (entry.context.length !== otherEntry.context.length) {
            hasConflict = false;
            break;
          }
          if (!equal(entry.properties, otherEntry.properties)) {
            hasConflict = false;
            break;
          }
          if (!equal(entry.context, otherEntry.context)) {
            hasConflict = false;
            break;
          }
          if (entry.properties.length === 0 && otherEntry.properties.length === 0) continue;
          hasConflict = true;
        }

        if (hasConflict) conflicting.push(other);
      }

      if (conflicting.length > 0) out.push([className, conflicting]);
    }
    return out;
  }

  /**
   * IntelliSense's diagnostics for class attributes under Tailwind v4, at
   * their default severity (warning): `cssConflict` — two classes of a list
   * set the same properties — and `suggestCanonicalClasses` — a class has a
   * canonical spelling (`w-[16px]` → `w-4`). Each carries its quick fixes as
   * plain edits: delete the other classes, or replace with the suggestion.
   * Classes the engine does not generate are never reported, as there.
   *
   * @param {Array<Object>} classLists  findClassListsInText()
   * @param {Map<string, Object|null>} described  describe() results by class
   * @param {Map<string, string|null>} [canonical]  canonical spellings by class
   * @returns {Array<Object>}
   */
  function diagnose(classLists, described, canonical) {
    const diagnostics = [];
    const quote = function (c) {
      return "'" + c.className + "'";
    };

    for (const list of classLists) {
      const classNames = getClassNamesInClassList(list);
      const groups = new Map();
      for (const c of classNames) {
        const d = described.get(c.className);
        if (d && d.rules) groups.set(c.className, d.rules);
      }
      for (const [className, others] of findConflicts(classNames, groups)) {
        diagnostics.push({
          code: "cssConflict",
          severity: "warning",
          start: className.start,
          end: className.end,
          message: quote(className) + " applies the same CSS properties as " + joinWithAnd(others.map(quote)) + ".",
          related: others.map(function (o) {
            return { start: o.start, end: o.end, message: o.className };
          }),
          fixes: [
            {
              title: "Delete " + joinWithAnd(others.map(quote)),
              start: list.start,
              end: list.end,
              text: removeRangesFromString(
                list.classList,
                others.map(function (o) {
                  return { start: o.relStart, end: o.relEnd };
                }),
              ),
            },
          ],
        });
      }
    }

    for (const list of classLists) {
      for (const c of getClassNamesInClassList(list)) {
        const spelling = canonical && canonical.get(c.className);
        if (!spelling || spelling === c.className) continue;
        diagnostics.push({
          code: "suggestCanonicalClasses",
          severity: "warning",
          start: c.start,
          end: c.end,
          message: "The class `" + c.className + "` can be written as `" + spelling + "`",
          related: [],
          fixes: [{ title: "Replace with '" + spelling + "'", start: c.start, end: c.end, text: spelling }],
        });
      }
    }

    return diagnostics;
  }

  // ── colour squares (documentColorProvider.ts) ────────────────────────

  const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const RGB_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i;

  /**
   * A swatch colour as sent by the engine, as Monaco's IColor (0–1
   * channels), or `null` for the keywords and anything else.
   *
   * @param {string|null} str
   * @returns {{red: number, green: number, blue: number, alpha: number}|null}
   */
  function parseColor(str) {
    if (!str) return null;
    let m = HEX_RE.exec(str);
    if (m) {
      let hex = m[1];
      if (hex.length <= 4) {
        hex = hex
          .split("")
          .map(function (c) {
            return c + c;
          })
          .join("");
      }
      const n = function (i) {
        return parseInt(hex.slice(i, i + 2), 16) / 255;
      };
      return { red: n(0), green: n(2), blue: n(4), alpha: hex.length === 8 ? n(6) : 1 };
    }
    m = RGB_RE.exec(str);
    if (m) {
      return {
        red: Math.min(255, +m[1]) / 255,
        green: Math.min(255, +m[2]) / 255,
        blue: Math.min(255, +m[3]) / 255,
        alpha: m[4] === undefined ? 1 : Math.min(1, +m[4]),
      };
    }
    return null;
  }

  /**
   * @param {Object} data  prepare()d engine data
   * @param {Map<string, Object|null>} described
   * @param {string} className
   * @returns {string|null}  the class's colour, from the list or the engine
   */
  function colorOfClass(data, described, className) {
    const i = data._index.get(className);
    if (i !== undefined) return data.colors[i] || null;
    const d = described.get(className);
    return (d && d.color) || null;
  }

  /**
   * Classes whose colour the list does not carry — with variants, modifiers
   * or arbitrary values — and the engine has to be asked about.
   *
   * @param {Object} data
   * @param {Array<Object>} classLists
   * @returns {Array<string>}
   */
  function classesNeedingColor(data, classLists) {
    return uniqueClassNames(classLists).filter(function (c) {
      return !data._index.has(c);
    });
  }

  /**
   * The colour squares IntelliSense draws: every class in a class attribute
   * that carries a colour, except the keywords and fully transparent ones.
   *
   * @param {Object} data
   * @param {Array<Object>} classLists
   * @param {Map<string, Object|null>} described
   * @returns {Array<{start: number, end: number, color: Object}>}
   */
  function documentColors(data, classLists, described) {
    const colors = [];
    for (const list of classLists) {
      for (const c of getClassNamesInClassList(list)) {
        const color = parseColor(colorOfClass(data, described, c.className));
        if (!color || color.alpha === 0) continue;
        colors.push({ start: c.start, end: c.end, color: color });
      }
    }
    return colors;
  }

  // The CSS named colours, as the color-name package IntelliSense uses.
  const COLOR_NAMES = (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
    "mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab " +
    "orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru " +
    "pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan " +
    "teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" ");

  const PRESENTATION_RE = new RegExp(
    "-\\[(" + COLOR_NAMES.join("|") + "|(?:(?:#|rgba?\\(|hsla?\\())[^\\]]+)\\]$",
    "i",
  );

  // culori's serializers: channels clamped and rounded to 0–255, alpha and
  // HSL to two decimals.
  const clamp01 = function (v) {
    return Math.max(0, Math.min(1, v || 0));
  };
  const to255 = function (v) {
    return Math.round(clamp01(v) * 255);
  };
  const twoDecimals = function (v) {
    return Math.round(v * 100) / 100;
  };
  const hex2 = function (n) {
    return ((1 << 8) | n).toString(16).slice(1);
  };

  function formatHex8(c) {
    return "#" + hex2(to255(c.r)) + hex2(to255(c.g)) + hex2(to255(c.b)) + hex2(to255(c.alpha === undefined ? 1 : c.alpha));
  }

  function formatRgb(c) {
    const rgb = to255(c.r) + ", " + to255(c.g) + ", " + to255(c.b);
    if (c.alpha === undefined || c.alpha === 1) return "rgb(" + rgb + ")";
    return "rgba(" + rgb + ", " + twoDecimals(clamp01(c.alpha)) + ")";
  }

  function formatHsl(c) {
    const r = c.r || 0;
    const g = c.g || 0;
    const b = c.b || 0;
    const M = Math.max(r, g, b);
    const m = Math.min(r, g, b);
    const s = M === m ? 0 : (M - m) / (1 - Math.abs(M + m - 1));
    const l = 0.5 * (M + m);
    let h = 0;
    if (M - m !== 0) {
      h = (M === r ? (g - b) / (M - m) + (g < b) * 6 : M === g ? (b - r) / (M - m) + 2 : (r - g) / (M - m) + 4) * 60;
    }
    const hsl = twoDecimals(h) + ", " + twoDecimals(clamp01(s) * 100) + "%, " + twoDecimals(clamp01(l) * 100) + "%";
    if (c.alpha === undefined || c.alpha === 1) return "hsl(" + hsl + ")";
    return "hsla(" + hsl + ", " + twoDecimals(clamp01(c.alpha)) + ")";
  }

  /**
   * What the colour picker may write back for a class: only an arbitrary
   * colour (`bg-[#ff0000]`, `text-[rgb(…)]`, `border-[tomato]`) can take a
   * new one — as hex, rgb() and hsl(). Other classes get none, as there.
   *
   * @param {string} className
   * @param {{red: number, green: number, blue: number, alpha: number}} color
   * @returns {Array<string>}
   */
  function colorPresentations(className, color) {
    const match = className.match(PRESENTATION_RE);
    if (match === null) return [];

    const currentColor = match[1];
    const isNamedColor = COLOR_NAMES.includes(currentColor);
    const rgb = { r: color.red, g: color.green, b: color.blue, alpha: color.alpha };

    let hexValue = formatHex8(rgb);
    if (!isNamedColor && (currentColor.length === 4 || currentColor.length === 5)) {
      const m = hexValue.match(/^#([a-f\d])\1([a-f\d])\2([a-f\d])\3(?:([a-f\d])\4)?$/i);
      const chars = m ? m.slice(1) : [];
      if (chars.length) hexValue = "#" + chars.filter(Boolean).join("");
    }
    if (hexValue.length === 5) hexValue = hexValue.replace(/f$/, "");
    else if (hexValue.length === 9) hexValue = hexValue.replace(/ff$/, "");

    const prefix = className.substr(0, match.index);

    return [
      hexValue,
      formatRgb(rgb).replace(/ /g, ""),
      formatHsl(rgb)
        .replace(/ /g, "")
        .replace(/\d+\.\d+(%?)/g, function (value, suffix) {
          return Math.round(parseFloat(value)) + suffix;
        }),
    ].map(function (value) {
      return prefix + "-[" + value + "]";
    });
  }

  // ── entry points for the glue ────────────────────────────────────────

  const OPEN_STRING_RE = /["'`]([^"'`]*)$/;

  /**
   * The class list at the cursor: inside a class attribute (IntelliSense's
   * rule), or — this editor's addition, which IntelliSense leaves to
   * `classRegex` settings — inside any string on the line that already holds
   * a class the engine knows, or whose first word starts like one, so
   * `const variants = { primary: "bg-blue-600 …" }` completes too.
   *
   * @param {Object} data  prepare()d engine data
   * @param {string} textBefore  Up to SEARCH_RANGE characters ending at the cursor.
   * @param {string} lineBefore  The cursor's line up to the cursor.
   * @returns {{classList: string, attribute: boolean}|null}
   */
  function classListAt(data, textBefore, lineBefore) {
    const inAttribute = findClassList(jsWithoutComments(textBefore));
    if (inAttribute !== null) return { classList: inAttribute, attribute: true };

    const open = OPEN_STRING_RE.exec(lineBefore);
    if (!open) return null;
    const inside = open[1].replace(/\$\{[^}]*\}/g, " ");
    const parts = inside.split(/\s+/);
    const word = parts[parts.length - 1] || "";
    for (const part of parts) {
      if (part && isKnownClass(data, part)) return { classList: inside, attribute: false };
    }
    if (parts.length === 1 && word.length >= 2) {
      const typed = segment(word, SEP).pop();
      for (const cls of data.classes) {
        if (cls.indexOf(typed) === 0) return { classList: inside, attribute: false };
      }
    }
    return null;
  }

  /**
   * The class under the cursor, for a hover: its text and where it lies
   * relative to the cursor (`start` ≤ 0 ≤ `end`).
   *
   * @param {Object} data
   * @param {string} textBefore
   * @param {string} lineBefore
   * @param {string} lineAfter  The cursor's line from the cursor on.
   * @returns {{className: string, start: number, end: number}|null}
   */
  function classNameAt(data, textBefore, lineBefore, lineAfter) {
    const at = classListAt(data, textBefore, lineBefore);
    if (!at) return null;
    const before = /[^\s+]*$/.exec(at.classList)[0];
    const after = /^[^\s+"'`{}]*/.exec(lineAfter)[0];
    const className = before + after;
    if (!className) return null;
    if (!at.attribute && !isKnownClass(data, className)) return null;
    return { className: className, start: -before.length, end: after.length };
  }

  return {
    SEARCH_RANGE: SEARCH_RANGE,
    TRIGGER_CHARACTERS: TRIGGER_CHARACTERS,
    CLASS_ATTRIBUTES: CLASS_ATTRIBUTES,
    MAX_DESCRIBE: MAX_DESCRIBE,
    jsWithoutComments: jsWithoutComments,
    segment: segment,
    naturalExpand: naturalExpand,
    findClassList: findClassList,
    findClassListsInText: findClassListsInText,
    getClassNamesInClassList: getClassNamesInClassList,
    uniqueClassNames: uniqueClassNames,
    findConflicts: findConflicts,
    joinWithAnd: joinWithAnd,
    removeRangesFromString: removeRangesFromString,
    diagnose: diagnose,
    parseColor: parseColor,
    classesNeedingColor: classesNeedingColor,
    documentColors: documentColors,
    colorPresentations: colorPresentations,
    prepare: prepare,
    modifiersOf: modifiersOf,
    mayBeVariant: mayBeVariant,
    isKnownClass: isKnownClass,
    getVariantsFromClassName: getVariantsFromClassName,
    completionsFromClassList: completionsFromClassList,
    applyModifierColors: applyModifierColors,
    classListAt: classListAt,
    classNameAt: classNameAt,
  };
});
