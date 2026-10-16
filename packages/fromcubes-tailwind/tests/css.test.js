/**
 * Tailwind CSS generation (css.js) and the editor class list (candidates.js).
 */

const { generateCSS } = require("../css");
const { generateCandidates } = require("../candidates");

describe("generateCSS — arbitrary-value candidates", () => {
  it("emits CSS for calc() arbitrary value", async () => {
    const { css } = await generateCSS(
      'function App(){ return <div className="w-[calc(100%-2rem)]"/>; }',
    );
    expect(css).toContain("calc(100% - 2rem)");
  });

  it("emits CSS for repeat() with comma", async () => {
    const { css } = await generateCSS(
      'function App(){ return <div className="grid grid-cols-[repeat(2,1fr)]"/>; }',
    );
    expect(css.replace(/\s/g, "")).toContain("repeat(2,1fr)");
  });

  it("emits !important for trailing-! modifier", async () => {
    const { css } = await generateCSS(
      'function App(){ return <div className="mt-0!"/>; }',
    );
    expect(css).toContain("important");
  });

  it("emits container query CSS for @-variant", async () => {
    const { css } = await generateCSS(
      'function App(){ return <div className="@md:flex"/>; }',
    );
    expect(css).toContain("@container");
  });

  it("emits font-family for quoted arbitrary value in single-quoted class list", async () => {
    const { css } = await generateCSS(
      "function App(){ return <div className=\"font-['Open_Sans']\"/>; }",
    );
    expect(css).toContain("Open Sans");
  });

  it("still extracts plain classes outside strings (JSX expression maps)", async () => {
    const { css } = await generateCSS(
      "const variants = { primary: `bg-blue-600 hover:bg-blue-500` };",
    );
    expect(css).toContain("bg-blue-600");
    expect(css).toContain("hover\\:bg-blue-500");
  });

  it("does not choke on code-looking junk in strings", async () => {
    const { css } = await generateCSS(
      'const s = "send({ action: 1 }) w-full"; ',
    );
    expect(css).toContain("width: 100%");
  });

  it("dynamic template classes still produce no CSS (documented limitation)", async () => {
    const { css } = await generateCSS(
      "const cls = `bg-${tone}-500`; // never do this",
    );
    // bg-${tone}-500 is not a valid utility — nothing should be emitted for it
    expect(css).not.toContain("--tw-bg");
  });
});

test("candidate list is non-trivial and unique", () => {
  const list = generateCandidates();
  expect(list.length).toBeGreaterThan(1000);
  expect(new Set(list).size).toBe(list.length);
  expect(list).toContain("p-4");
});
