/**
 * nodes/editor/class-completion.js — className completion with the logic of
 * Tailwind CSS IntelliSense: where a class list is, which variants are
 * typed, what is offered and in which order.
 */

const cc = require("../nodes/editor/class-completion");

// A small engine: two colours with modifiers, two plain classes, and
// variants of each shape IntelliSense handles.
const fakeData = () =>
  cc.prepare({
    engine: "tailwind",
    classes: ["bg-red-500", "flex", "p-4", "text-sm", "w-1/2"],
    colors: ["#fb2c36", "", "", "", ""],
    modifiers: [["0", "50"], ["tight"]],
    classModifiers: [0, -1, -1, 1, -1],
    variants: [
      { name: "hover", values: [], hasDash: true, isArbitrary: false, detail: "@media (hover: hover) { &:hover }", valueDetails: [], failed: false },
      { name: "group", values: ["hover", "focus"], hasDash: true, isArbitrary: true, detail: null, valueDetails: ["&:is(:where(.group):hover *)", null], failed: false },
      { name: "@", values: ["md"], hasDash: false, isArbitrary: true, detail: null, valueDetails: ["@container (width >= 28rem)"], failed: false },
      { name: "broken", values: ["x"], hasDash: true, isArbitrary: true, detail: null, valueDetails: [], failed: true },
    ],
    describe: true,
  });

const classListOf = (text) => cc.findClassList(cc.jsWithoutComments(text));

describe("findClassList — IntelliSense's class attribute lexer", () => {
  it.each([
    ['<div className="flex items-', "flex items-"],
    ["<div className='a b", "a b"],
    ['<div class="p-', "p-"],
    ['<div className="', ""],
    ["<div className={`flex ${on ? \"a\" : \"b\"} p-", " p-"],
    ['<div className={cn("a", on && "b', "b"],
    ['<div className={"p-4 m', "p-4 m"],
    ["<div\n  className={`\n    flex\n    bg-", "\n    flex\n    bg-"],
    ['<div className="w-[calc(100%-', "w-[calc(100%-"],
    ['/* className="x" */ <div className="y', "y"],
  ])("%j → %j", (text, expected) => {
    expect(classListOf(text)).toBe(expected);
  });

  it.each([
    ["<div className={on ? \"a\" : x"],
    ['<div className="a">text'],
    ['<div className="a" title="b'],
    ['el.className = "x'],
    ['// <div className="a'],
    ['const s = "bg-red-500 '],
    ["no attribute at all"],
  ])("%j → null", (text) => {
    expect(classListOf(text)).toBeNull();
  });
});

describe("getVariantsFromClassName", () => {
  const data = fakeData();
  it.each([
    ["hover:group-hover:bg-", ["hover", "group-hover"], 18],
    ["hover:", ["hover"], 6],
    ["hover::flex", ["hover"], 6],
    ["@md:p-", ["@md"], 4],
    ["bg-red", [], 0],
    ["nope:bg-", [], 0],
  ])("%j → %j at %i", async (className, variants, offset) => {
    expect(await cc.getVariantsFromClassName(data, className)).toEqual({ variants, offset });
  });

  it("asks isValidVariant about parts it does not list, awaiting it", async () => {
    const asked = [];
    const valid = async (part) => {
      asked.push(part);
      return part === "group-hover/item";
    };
    expect(await cc.getVariantsFromClassName(data, "group-hover/item:flex", valid)).toEqual({
      variants: ["group-hover/item"],
      offset: 17,
    });
    expect(asked).toEqual(["group-hover/item", "flex"]);
  });
});

describe("completionsFromClassList", () => {
  const invoke = { triggerKind: "invoke" };

  it("variants first, in IntelliSense's order and shapes, then every class", async () => {
    const list = await cc.completionsFromClassList(fakeData(), "", invoke);
    const variants = list.items.filter((i) => i.kind === "variant");
    expect(variants.map((i) => i.label)).toEqual(["hover:", "group-[]:", "group-hover:", "@[]:", "@md:", "broken-[]:"]);
    expect(variants[0]).toMatchObject({ detail: "@media (hover: hover) { &:hover }", insertText: "hover:", retrigger: true, sortText: "-00000000" });
    expect(variants[1]).toMatchObject({ insertText: "group-[${1}]:${0}", snippet: true });
    expect(variants[1].retrigger).toBeUndefined();
    expect(variants[2]).toMatchObject({ detail: "&:is(:where(.group):hover *)", retrigger: true });

    const classes = list.items.filter((i) => i.kind !== "variant");
    expect(classes.map((i) => i.label)).toEqual(["bg-red-500", "flex", "p-4", "text-sm", "w-1/2"]);
    expect(classes[0]).toEqual({ label: "bg-red-500", kind: "color", documentation: "#fb2c36", sortText: "0" });
    expect(classes[1]).toEqual({ label: "flex", kind: "constant", sortText: "1" });
    expect(list).toMatchObject({ range: { start: 0, end: 0 }, variants: [], important: false, modifiers: false });
  });

  it("replaces only the class being typed, after its variants", async () => {
    expect((await cc.completionsFromClassList(fakeData(), "flex ite", invoke)).range.start).toBe(-3);
    const list = await cc.completionsFromClassList(fakeData(), "flex hover:bg-", invoke);
    expect(list.range.start).toBe(-3);
    expect(list.variants).toEqual(["hover"]);
    // a variant already typed is not offered again
    expect(list.items.map((i) => i.label)).not.toContain("hover:");
  });

  it("splits on whitespace and `+`, like IntelliSense", async () => {
    expect((await cc.completionsFromClassList(fakeData(), "a+fl", invoke)).range.start).toBe(-2);
  });

  it("after `/`: only the class's modifiers", async () => {
    const slash = { triggerKind: "character", triggerCharacter: "/" };
    let list = await cc.completionsFromClassList(fakeData(), "p-2 hover:bg-red-500/", slash);
    expect(list.modifiers).toBe(true);
    expect(list.items).toEqual([
      { label: "hover:bg-red-500/0", kind: "constant", sortText: "00000000" },
      { label: "hover:bg-red-500/50", kind: "constant", sortText: "00000001" },
    ]);
    expect(list.range.start).toBe(-17);
    list = await cc.completionsFromClassList(fakeData(), "text-sm/", invoke);
    expect(list.items.map((i) => i.label)).toEqual(["text-sm/tight"]);
  });

  it("no modifier list for another trigger, a class without modifiers, or w-1/2", async () => {
    const dash = { triggerKind: "character", triggerCharacter: "-" };
    expect((await cc.completionsFromClassList(fakeData(), "bg-red-500/", dash)).modifiers).toBe(false);
    expect((await cc.completionsFromClassList(fakeData(), "p-4/", invoke)).modifiers).toBe(false);
    expect((await cc.completionsFromClassList(fakeData(), "w-1/", invoke)).modifiers).toBe(false);
  });

  it("a trailing `!` stays typed: insertText and filterText carry it", async () => {
    const list = await cc.completionsFromClassList(fakeData(), "p-4!", invoke);
    expect(list.important).toBe(true);
    expect(list.range.start).toBe(-4);
    expect(list.items.find((i) => i.label === "flex")).toMatchObject({ insertText: "flex!", filterText: "flex!" });
  });

  it("keyword colours are Color items without a swatch", async () => {
    const data = cc.prepare({ ...fakeData(), classes: ["bg-current", "bg-transparent"], colors: ["currentColor", "transparent"], classModifiers: [-1, -1] });
    const items = (await cc.completionsFromClassList(data, "", invoke)).items.filter((i) => i.kind !== "variant");
    expect(items).toEqual([
      { label: "bg-current", kind: "color", sortText: "0" },
      { label: "bg-transparent", kind: "color", sortText: "1" },
    ]);
  });

  it("applyModifierColors: swatch unless keyword or fully transparent", () => {
    const items = [{ kind: "constant" }, { kind: "constant" }, { kind: "constant" }, { kind: "constant" }];
    cc.applyModifierColors(items, [
      { color: "rgba(251, 44, 54, 0.5)" },
      { color: "rgba(251, 44, 54, 0)" },
      { color: "currentColor" },
      null,
    ]);
    expect(items).toEqual([
      { kind: "color", documentation: "rgba(251, 44, 54, 0.5)" },
      { kind: "color" },
      { kind: "color" },
      { kind: "constant" },
    ]);
  });
});

describe("classListAt — class attributes, and strings already holding classes", () => {
  const data = fakeData();
  it("inside a class attribute", () => {
    expect(cc.classListAt(data, '<div className="flex p-', '<div className="flex p-')).toEqual({ classList: "flex p-", attribute: true });
  });

  it("a string on the line that holds a known class, variants and modifiers allowed", () => {
    for (const line of ['const v = { a: "bg-red-500 fl', 'const v = "hover:bg-red-500/50 fl', 'x("p-4! fl']) {
      expect(cc.classListAt(data, line, line)).toMatchObject({ attribute: false });
    }
  });

  it("a string whose only word starts like a class", () => {
    expect(cc.classListAt(data, 'const s = "fl', 'const s = "fl')).toEqual({ classList: "fl", attribute: false });
  });

  it("ordinary strings stay quiet", () => {
    for (const line of ['const s = "hello wor', 'const s = "x', "plain code"]) {
      expect(cc.classListAt(data, line, line)).toBeNull();
    }
  });
});

describe("classNameAt — the class under the cursor, for the hover", () => {
  const data = fakeData();
  it("in a class attribute: the whole class around the cursor", () => {
    const before = '<div className="flex bg-re';
    expect(cc.classNameAt(data, before, before, 'd-500 p-4">')).toEqual({ className: "bg-red-500", start: -5, end: 5 });
  });

  it("any class in an attribute — the engine decides", () => {
    const before = '<div className="hover:[color:re';
    expect(cc.classNameAt(data, before, before, 'd]">')).toMatchObject({ className: "hover:[color:red]" });
  });

  it("in other strings only a known class", () => {
    const before = 'const a = "bg-red-500 nop';
    expect(cc.classNameAt(data, before, before, 'e"')).toBeNull();
    const at = 'const a = "bg-re';
    expect(cc.classNameAt(data, at, at, 'd-500"')).toMatchObject({ className: "bg-red-500" });
  });

  it("outside a class list, or on whitespace: nothing", () => {
    expect(cc.classNameAt(data, "const x = ", "const x = ", "1;")).toBeNull();
    const before = '<div className="flex ';
    expect(cc.classNameAt(data, before, before, ' p-4">')).toBeNull();
  });
});

describe("small pieces", () => {
  it("jsWithoutComments blanks comments only, keeping length and lines", () => {
    const src = 'a("http://x") // c\n/* b\n */ "/* s */"';
    const out = cc.jsWithoutComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain('"http://x"');
    expect(out).toContain('"/* s */"');
    expect(out).not.toContain("// c");
  });

  it("segment splits at the top level only", () => {
    expect(cc.segment("hover:[&:hover]:flex", ":")).toEqual(["hover", "[&:hover]", "flex"]);
    expect(cc.segment("data-[a='b:c']:p-4", ":")).toEqual(["data-[a='b:c']", "p-4"]);
  });

  it("naturalExpand pads to the width of the total, else 8", () => {
    expect(cc.naturalExpand(5, 23286)).toBe("00005");
    expect(cc.naturalExpand(3)).toBe("00000003");
  });

  it("mayBeVariant: only text shaped like a variant goes to the server", () => {
    const data = fakeData();
    expect(cc.mayBeVariant(data, "bg-red-")).toBe(false);
    expect(cc.mayBeVariant(data, "flex")).toBe(false);
    expect(cc.mayBeVariant(data, "group-hover/item")).toBe(true);
    expect(cc.mayBeVariant(data, "group-[.is-open]")).toBe(true);
    expect(cc.mayBeVariant(data, "@lg")).toBe(true);
    expect(cc.mayBeVariant(data, "[&>*]")).toBe(true);
  });

  it("prepare is idempotent and hides its indexes from JSON", () => {
    const data = fakeData();
    expect(cc.prepare(data)).toBe(data);
    expect(Object.keys(JSON.parse(JSON.stringify(data)))).not.toContain("_index");
  });
});

describe("findClassListsInText — every class list in the document", () => {
  const listsOf = (src) => cc.findClassListsInText(cc.jsWithoutComments(src)).map((l) => l.classList);

  it("attributes, expressions and template literals; comments skipped", () => {
    const src = [
      '<div className="flex p-2 p-4">',
      '  <span className={on ? "a b" : "c"} class="x"/>',
      '  <p className={`text-sm ${on ? "font-bold" : ""}`}/>',
      '  {/* <i className="p-1 p-2"/> */}',
      "</div>",
    ].join("\n");
    expect(listsOf(src)).toEqual(["flex p-2 p-4", "a b", "c", "x", "text-sm $", "font-bold"]);
  });

  it("offsets point at the list, whitespace trimmed; classes carry absolute and relative ranges", () => {
    const src = '<div className="  flex  p-2 ">';
    const [list] = cc.findClassListsInText(src);
    expect(src.slice(list.start, list.end)).toBe("flex  p-2");
    const names = cc.getClassNamesInClassList(list);
    expect(names.map((n) => [n.className, src.slice(n.start, n.end), n.relStart, n.relEnd])).toEqual([
      ["flex", "flex", 0, 4],
      ["p-2", "p-2", 6, 9],
    ]);
  });

  it("an unclosed list still counts, up to where lexing stopped", () => {
    expect(listsOf('<div className="flex p-')).toEqual(["flex p-"]);
  });

  it("uniqueClassNames: each class once", () => {
    expect(cc.uniqueClassNames(cc.findClassListsInText('<a className="p-2 p-4"/><b className="p-4 m-1"/>'))).toEqual(["p-2", "p-4", "m-1"]);
  });
});

describe("diagnose — cssConflict and suggestCanonicalClasses", () => {
  const padding = { rules: [{ properties: ["padding"], context: [] }] };
  const described = new Map([
    ["p-2", padding],
    ["p-4", padding],
    ["md:p-4", { rules: [{ properties: ["padding"], context: ["@media (width >= 48rem)"] }] }],
    ["flex", { rules: [{ properties: ["display"], context: [] }] }],
    ["w-[16px]", { rules: [{ properties: ["width"], context: [] }] }],
    ["custom", null],
  ]);
  const canonical = new Map([["w-[16px]", "w-4"], ["p-2", null]]);
  const run = (src) => cc.diagnose(cc.findClassListsInText(src), described, canonical);

  it("same properties in the same place: each class flagged, naming the others", () => {
    const src = '<div className="flex p-2 md:p-4 p-4 custom">';
    const d = run(src);
    expect(d.map((x) => [x.code, src.slice(x.start, x.end), x.message])).toEqual([
      ["cssConflict", "p-2", "'p-2' applies the same CSS properties as 'p-4'."],
      ["cssConflict", "p-4", "'p-4' applies the same CSS properties as 'p-2'."],
    ]);
    expect(d[0].severity).toBe("warning");
    expect(d[0].related.map((r) => [src.slice(r.start, r.end), r.message])).toEqual([["p-4", "p-4"]]);
  });

  it("the quick fix deletes the other classes from the list", () => {
    const src = '<div className="flex p-2 md:p-4 p-4">';
    const fix = run(src)[0].fixes[0];
    expect(fix.title).toBe("Delete 'p-4'");
    expect(src.slice(0, fix.start) + fix.text + src.slice(fix.end)).toBe('<div className="flex p-2 md:p-4">');
  });

  it("three-way conflicts read 'a, b and c'; lists are checked on their own", () => {
    const d = run('<a className="p-2 p-4 p-2"/><b className="p-4"/>');
    expect(d[0].message).toBe("'p-2' applies the same CSS properties as 'p-4' and 'p-2'.");
    expect(d).toHaveLength(3);
  });

  it("a canonical spelling, with its replacement as the fix — after the conflicts", () => {
    const src = '<div className="w-[16px] p-2 p-4">';
    const d = run(src);
    expect(d.map((x) => x.code)).toEqual(["cssConflict", "cssConflict", "suggestCanonicalClasses"]);
    const canon = d[2];
    expect(canon.message).toBe("The class `w-[16px]` can be written as `w-4`");
    expect(canon.fixes).toEqual([{ title: "Replace with 'w-4'", start: canon.start, end: canon.end, text: "w-4" }]);
  });

  it("without canonical answers yet: conflicts only", () => {
    const d = cc.diagnose(cc.findClassListsInText('<div className="w-[16px] p-2 p-4">'), described);
    expect(d.map((x) => x.code)).toEqual(["cssConflict", "cssConflict"]);
  });

  it("classes the engine does not generate are never reported", () => {
    expect(run('<div className="custom custom foo">')).toEqual([]);
  });

  it("removeRangesFromString and joinWithAnd, as the originals", () => {
    expect(cc.removeRangesFromString("a b c", [{ start: 2, end: 3 }])).toBe("a c");
    expect(cc.removeRangesFromString("a b c", [{ start: 0, end: 1 }, { start: 4, end: 5 }])).toBe("b");
    expect(cc.joinWithAnd(["'a'"])).toBe("'a'");
    expect(cc.joinWithAnd(["'a'", "'b'", "'c'"])).toBe("'a', 'b' and 'c'");
  });
});

describe("colour squares", () => {
  const data = fakeData();
  const described = new Map([
    ["hover:bg-red-500", { color: "#fb2c36" }],
    ["bg-red-500/50", { color: "rgba(251, 44, 54, 0.5)" }],
    ["bg-[#00ff00]", { color: "#00ff00" }],
    ["bg-current", { color: "currentColor" }],
    ["bg-red-500/0", { color: "rgba(251, 44, 54, 0)" }],
  ]);

  it("every class with a colour — from the list or the engine — but no keyword or transparent one", () => {
    const src = '<div className="bg-red-500 flex hover:bg-red-500 bg-red-500/50 bg-[#00ff00] bg-current bg-red-500/0">';
    const lists = cc.findClassListsInText(src);
    expect(cc.classesNeedingColor(data, lists)).toEqual(["hover:bg-red-500", "bg-red-500/50", "bg-[#00ff00]", "bg-current", "bg-red-500/0"]);
    const colors = cc.documentColors(data, lists, described);
    expect(colors.map((c) => src.slice(c.start, c.end))).toEqual(["bg-red-500", "hover:bg-red-500", "bg-red-500/50", "bg-[#00ff00]"]);
    expect(colors[2].color).toEqual({ red: 251 / 255, green: 44 / 255, blue: 54 / 255, alpha: 0.5 });
  });

  it("parseColor reads what the engine sends", () => {
    expect(cc.parseColor("#f00")).toEqual({ red: 1, green: 0, blue: 0, alpha: 1 });
    expect(cc.parseColor("#ff000080").alpha).toBeCloseTo(0.502, 3);
    expect(cc.parseColor("rgb(0, 255, 0)")).toEqual({ red: 0, green: 1, blue: 0, alpha: 1 });
    expect(cc.parseColor("transparent")).toBeNull();
    expect(cc.parseColor("")).toBeNull();
  });

  it("the picker rewrites only arbitrary colours, keeping their short hex", () => {
    const green = { red: 0, green: 1, blue: 0, alpha: 1 };
    expect(cc.colorPresentations("bg-[#f00]", green)).toEqual(["bg-[#0f0]", "bg-[rgb(0,255,0)]", "bg-[hsl(120,100%,50%)]"]);
    expect(cc.colorPresentations("hover:text-[tomato]", green)).toEqual([
      "hover:text-[#00ff00]",
      "hover:text-[rgb(0,255,0)]",
      "hover:text-[hsl(120,100%,50%)]",
    ]);
    expect(cc.colorPresentations("border-[rgba(1,2,3,0.5)]", { red: 0.2, green: 0.4, blue: 0.6, alpha: 0.5 })).toEqual([
      "border-[#33669980]",
      "border-[rgba(51,102,153,0.5)]",
      // the original's number rounding reaches the alpha too
      "border-[hsla(210,50%,40%,1)]",
    ]);
    expect(cc.colorPresentations("bg-red-500", green)).toEqual([]);
  });
});
