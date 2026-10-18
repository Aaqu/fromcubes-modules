/**
 * The editor data (candidates.js) and the IntelliSense port behind it
 * (intellisense.js): swatches, CSS previews, declaration summaries and
 * variant details, checked against what Tailwind CSS IntelliSense shows.
 */

const { completionData, describeCandidates, getDesignSystem } = require("../candidates");
const {
  addPixelEquivalentsToValue,
  addPixelEquivalentsToMediaQuery,
  getEquivalentColor,
  replaceCssVars,
  evaluateExpression,
  colorOf,
  cssEscape,
} = require("../intellisense");

const describeOne = async (c) => (await describeCandidates([c]))[0];

// Load the design system, the colour pass and the canonical-name worker's
// index once, outside any one test's time limit: describe() waits for the
// worker, and on a CI runner its first build alone takes ~6 s.
beforeAll(async () => {
  await completionData();
  await describeCandidates(["w-[16px]"]);
}, 120000);

describe("describe — what the detail pane and the hover show", () => {
  it("spacing: theme value resolved, pixel equivalent added", async () => {
    expect(await describeOne("p-4")).toEqual({
      hover: ".p-4 {\n  padding: calc(var(--spacing) * 4) /* 1rem = 16px */;\n}",
      documentation: ".p-4 {\n  padding: calc(var(--spacing) * 4) /* 1rem = 16px */;\n}",
      detail: "padding: 1rem /* 16px */;",
      color: null,
      rules: [{ properties: ["padding"], context: [] }],
      canonical: null,
    });
  });

  it("colour: oklch value and its hex, swatch colour", async () => {
    const d = await describeOne("text-red-500");
    expect(d.hover).toBe(".text-red-500 {\n  color: var(--color-red-500) /* oklch(63.7% 0.237 25.331) = #fb2c36 */;\n}");
    expect(d.detail).toBe("color: oklch(63.7% 0.237 25.331);");
    expect(d.color).toBe("#fb2c36");
  });

  it("a colour outside sRGB gets no hex comment, as IntelliSense, but still a swatch", async () => {
    const d = await describeOne("bg-blue-500");
    expect(d.hover).toContain("/* oklch(62.3% 0.214 259.815) */");
    expect(d.color).toBe("#2b7fff");
  });

  it("text size: calc in a theme value approximated", async () => {
    const d = await describeOne("text-sm");
    expect(d.hover).toContain("font-size: var(--text-sm) /* 0.875rem = 14px */;");
    expect(d.hover).toContain("var(--text-sm--line-height) /* calc(1.25 / 0.875) ≈ 1.428571 */");
  });

  it("variants: media query with its pixel width", async () => {
    const d = await describeOne("md:p-4");
    expect(d.hover).toBe(
      "@media (width >= 48rem /* 768px */) {\n  .md\\:p-4 {\n    padding: calc(var(--spacing) * 4) /* 1rem = 16px */;\n  }\n}",
    );
    expect(d.documentation).toBe(d.hover);
  });

  it("hover keeps @property registrations, the completion preview does not", async () => {
    const d = await describeOne("shadow-md");
    expect(d.hover).toContain("@property --tw-shadow {");
    expect(d.documentation).not.toContain("@property");
    expect(d.detail).toMatch(/^--tw-shadow: .*; box-shadow: /);
  });

  it("bookkeeping declarations stay out of the summary", async () => {
    expect((await describeOne("space-x-4")).detail).not.toContain("--tw-space-x-reverse: 0");
    expect((await describeOne("leading-6")).detail).toBe("line-height: 1.5rem /* 24px */;");
  });

  it("modifiers and arbitrary values", async () => {
    expect((await describeOne("bg-red-500/50")).color).toBe("rgba(251, 44, 54, 0.5)");
    expect((await describeOne("w-[calc(100%-2rem)]")).detail).toBe("width: calc(100% - 2rem /* 32px */);");
    expect((await describeOne("bg-[oklch(63.7%_0.237_25.331)]")).hover).toContain("oklch(63.7% 0.237 25.331) /* #fb2c36 */");
  });

  it("not a utility ⇒ null; a valid variant compiles with a test value", async () => {
    expect(await describeCandidates(["nope-x", "hover:[color:red]", "data-[open]:[color:red]", "bg-:[color:red]"])).toEqual([
      null,
      expect.objectContaining({ color: "#ff0000" }),
      expect.objectContaining({ color: "#ff0000" }),
      null,
    ]);
  });
});

describe("diagnostics data — what cssConflict and suggestCanonicalClasses compare", () => {
  it("rules: properties and where they apply, the class itself written as &", async () => {
    const [p2, hoverP4, mdP4, backdrop] = await describeCandidates(["p-2", "hover:p-4", "md:p-4", "backdrop:bg-black/25"]);
    expect(p2.rules).toEqual([{ properties: ["padding"], context: [] }]);
    expect(hoverP4.rules).toEqual([{ properties: ["padding"], context: ["@media (hover: hover)", "&:hover"] }]);
    expect(mdP4.rules).toEqual([{ properties: ["padding"], context: ["@media (width >= 48rem)"] }]);
    expect(backdrop.rules).toEqual([{ properties: ["background-color"], context: ["&::backdrop"] }]);
  });

  it("rules include @property registrations, as IntelliSense compares them too", async () => {
    const { rules } = await describeOne("shadow-md");
    expect(rules[0]).toEqual({ properties: ["--tw-shadow", "box-shadow"], context: [] });
    expect(rules).toContainEqual({ properties: ["syntax", "inherits", "initial-value"], context: ["@property --tw-shadow"] });
  });

  it("canonical spelling, or null when already canonical", async () => {
    const r = await describeCandidates(["w-[16px]", "flex-grow", "mt-[-16px]", "bg-red-500/[50%]", "p-4", "hover:bg-red-500"]);
    expect(r.map((x) => x.canonical)).toEqual(["w-4", "grow", "-mt-4", "bg-red-500/50", null, null]);
  });

  it("cssEscape follows CSS.escape", () => {
    expect(cssEscape("hover:bg-red-500/50")).toBe("hover\\:bg-red-500\\/50");
    expect(cssEscape("2xl:p-4")).toBe("\\32 xl\\:p-4");
    expect(cssEscape("-")).toBe("\\-");
    expect(cssEscape("-2")).toBe("-\\32 ");
    expect(cssEscape("w-[calc(100%-2rem)]")).toBe("w-\\[calc\\(100\\%-2rem\\)\\]");
  });
});

describe("completion data", () => {
  it("swatches where IntelliSense draws them", async () => {
    const { classes } = await completionData();
    const color = (name) => classes.find((c) => c.name === name).color;
    expect(color("bg-red-500")).toBe("#fb2c36");
    expect(color("text-white")).toBe("#ffffff");
    expect(color("bg-transparent")).toBe("transparent");
    expect(color("bg-current")).toBe("currentColor");
    expect(color("shadow-red-500")).toBe("#fb2c36");
    expect(color("from-red-500")).toBe("#fb2c36");
    expect(color("bg-inherit")).toBeNull();
    expect(color("p-4")).toBeNull();
    // IntelliSense's shortcut: mask utilities are not treated as colours
    expect(color("mask-radial-from-red-500")).toBeNull();
  });

  it("modifiers as Tailwind lists them", async () => {
    const { classes } = await completionData();
    const mods = (name) => classes.find((c) => c.name === name).modifiers;
    expect(mods("bg-red-500")).toEqual(["0", "5", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55", "60", "65", "70", "75", "80", "85", "90", "95", "100"]);
    expect(mods("text-sm")).toEqual(["tight", "snug", "normal", "relaxed", "loose"]);
    expect(mods("p-4")).toEqual([]);
  });

  it("variants with IntelliSense's details", async () => {
    const { variants } = await completionData();
    const v = (name) => variants.find((x) => x.name === name);
    expect(v("hover")).toMatchObject({ detail: "@media (hover: hover) { &:hover }", isArbitrary: false, failed: false });
    expect(v("md").detail).toBe("@media (width >= 48rem /* 768px */)");
    // `group` alone outputs nothing: offered only with a value, or as group-[…]
    expect(v("group")).toMatchObject({ detail: null, isArbitrary: true });
    expect(v("group").valueDetails[v("group").values.indexOf("hover")]).toContain(":hover");
    // value details are not given pixel equivalents (IntelliSense neither)
    expect(v("max").valueDetails[0]).toBe("@media (width < 40rem)");
    expect(v("@")).toMatchObject({ hasDash: false, isArbitrary: true });
  });

  it("matches the design system's class list one to one", async () => {
    const { classes } = await completionData();
    const ds = await getDesignSystem();
    expect(classes.map((c) => c.name)).toEqual(ds.getClassList().map(([n]) => n));
  });
});

describe("helpers", () => {
  it("pixel equivalents: every rem, placed after its own number", () => {
    expect(addPixelEquivalentsToValue("0.5rem 1rem", 16)).toBe("0.5rem /* 8px */ 1rem /* 16px */");
    expect(addPixelEquivalentsToValue("1rem", 16, false)).toBe("16px");
    expect(addPixelEquivalentsToValue("calc(100% - 2rem)", 16)).toBe("calc(100% - 2rem /* 32px */)");
    expect(addPixelEquivalentsToValue("2em", 16)).toBe("2em");
  });

  it("media queries: rem and em at the browser's 16px", () => {
    expect(addPixelEquivalentsToMediaQuery("@media (width >= 40rem)")).toBe("@media (width >= 40rem /* 640px */)");
    expect(addPixelEquivalentsToMediaQuery("@container (width < 2.5em)")).toBe("@container (width < 2.5em /* 40px */)");
    expect(addPixelEquivalentsToMediaQuery("&:hover")).toBe("&:hover");
  });

  it("colour equivalents only for colours inside sRGB", () => {
    expect(getEquivalentColor("oklch(63.7% 0.237 25.331)")).toBe("#fb2c36");
    expect(getEquivalentColor("oklch(62.3% 0.214 259.815)")).toBe("oklch(62.3% 0.214 259.815)");
    expect(getEquivalentColor("transparent")).toBe("transparent");
  });

  it("calc evaluation as @csstools/css-calc does it", () => {
    expect(evaluateExpression("0.25rem * 4")).toBe("1rem");
    expect(evaluateExpression("1.25 / 0.875")).toBe("1.428571");
    expect(evaluateExpression("infinity * 1px")).toBeNull();
  });

  it("an unclosed var( does not hang", () => {
    expect(replaceCssVars("var(--x", { replace: () => "1" })).toBe("var(--x");
  });

  it("colourless shortcut skips compiling", async () => {
    const ds = await getDesignSystem();
    const compile = vi.spyOn(ds, "candidatesToAst");
    expect(colorOf(ds, "-mt-4")).toBeNull();
    expect(colorOf(ds, "w-4")).toBeNull();
    expect(compile).not.toHaveBeenCalled();
    compile.mockRestore();
  });
});
