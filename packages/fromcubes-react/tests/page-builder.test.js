const { buildPage } = require("../nodes/lib/page-builder");

function render(cssHash, nodeRoot) {
  return buildPage(
    "Test portal",
    "",
    "/fromcubes/test/_ws",
    "",
    cssHash,
    null,
    false,
    nodeRoot,
  );
}

describe("buildPage stylesheet URL", () => {
  it("links generated CSS through the public runtime route", () => {
    const html = render("abc123", "");

    expect(html).toContain(
      '<link rel="stylesheet" href="/fromcubes/css/abc123.css">',
    );
    expect(html).not.toContain("/fromcubes-react/css/");
  });

  it("includes a custom httpNodeRoot", () => {
    const html = render("deadbeef", "/runtime");

    expect(html).toContain(
      '<link rel="stylesheet" href="/runtime/fromcubes/css/deadbeef.css">',
    );
  });

  it("does not emit a stylesheet link when no CSS hash exists", () => {
    const html = render("", "/runtime");

    expect(html).not.toContain('<link rel="stylesheet"');
  });
});
