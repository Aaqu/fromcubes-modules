/**
 * Unit tests for the plugin hook system.
 * Simulates RED.plugins.getByType / RED.log so the module can run
 * without a real Node-RED runtime.
 */

const makeHooks = require("../nodes/lib/hooks");

function fakeRED(plugins = [], legacy = []) {
  const errors = [];
  return {
    plugins: {
      getByType: (type) =>
        type === "fromcubes-hooks" ? plugins : type === "fromcubes-portal-react" ? legacy : [],
    },
    log: {
      error: (m) => errors.push(m),
      warn: (m) => errors.push(m),
    },
    _errors: errors,
  };
}

describe("hooks.allow", () => {
  it("returns true when no plugins registered", () => {
    const hooks = makeHooks(fakeRED());
    expect(hooks.allow("onIsValidConnection", {})).toBe(true);
  });

  it("returns true when every hook returns non-false", () => {
    const hooks = makeHooks(
      fakeRED([
        { id: "a", hooks: { onCanSendTo: () => true } },
        { id: "b", hooks: { onCanSendTo: () => undefined } },
      ]),
    );
    expect(hooks.allow("onCanSendTo", {}, {})).toBe(true);
  });

  it("returns false if any hook returns false", () => {
    const hooks = makeHooks(
      fakeRED([
        { id: "a", hooks: { onCanSendTo: () => true } },
        { id: "b", hooks: { onCanSendTo: () => false } },
      ]),
    );
    expect(hooks.allow("onCanSendTo", {}, {})).toBe(false);
  });

  it("thrown exception is treated as false and logged", () => {
    const red = fakeRED([
      {
        id: "boom",
        hooks: {
          onCanSendTo: () => {
            throw new Error("nope");
          },
        },
      },
    ]);
    const hooks = makeHooks(red);
    expect(hooks.allow("onCanSendTo", {}, {})).toBe(false);
    expect(red._errors.some((e) => e.includes("nope"))).toBe(true);
  });

  it("ignores plugins that do not expose the requested hook", () => {
    const hooks = makeHooks(
      fakeRED([
        { id: "a", hooks: { otherHook: () => false } },
        { id: "b" },
      ]),
    );
    expect(hooks.allow("onCanSendTo", {}, {})).toBe(true);
  });

  it("short-circuits on first false (does not call later hooks)", () => {
    const calls = [];
    const hooks = makeHooks(
      fakeRED([
        {
          id: "a",
          hooks: {
            onCanSendTo: () => {
              calls.push("a");
              return false;
            },
          },
        },
        {
          id: "b",
          hooks: {
            onCanSendTo: () => {
              calls.push("b");
              return true;
            },
          },
        },
      ]),
    );
    hooks.allow("onCanSendTo", {}, {});
    expect(calls).toEqual(["a"]);
  });
});

describe("hooks.transform", () => {
  it("passes msg unchanged when no plugins", () => {
    const hooks = makeHooks(fakeRED());
    const msg = { payload: 1 };
    expect(hooks.transform("onInbound", msg)).toBe(msg);
  });

  it("applies transformations in order", () => {
    const hooks = makeHooks(
      fakeRED([
        { id: "a", hooks: { onInbound: (m) => ({ ...m, a: 1 }) } },
        { id: "b", hooks: { onInbound: (m) => ({ ...m, b: 2 }) } },
      ]),
    );
    const result = hooks.transform("onInbound", { payload: 0 });
    expect(result).toEqual({ payload: 0, a: 1, b: 2 });
  });

  it("keeps current msg when hook returns undefined", () => {
    const hooks = makeHooks(
      fakeRED([
        { id: "a", hooks: { onInbound: () => undefined } },
        { id: "b", hooks: { onInbound: (m) => ({ ...m, b: 2 }) } },
      ]),
    );
    expect(hooks.transform("onInbound", { payload: 0 })).toEqual({
      payload: 0,
      b: 2,
    });
  });

  it("throwing hook does not abort the chain", () => {
    const red = fakeRED([
      {
        id: "bad",
        hooks: {
          onInbound: () => {
            throw new Error("boom");
          },
        },
      },
      { id: "good", hooks: { onInbound: (m) => ({ ...m, tagged: true }) } },
    ]);
    const hooks = makeHooks(red);
    const result = hooks.transform("onInbound", { payload: 1 });
    expect(result.tagged).toBe(true);
    expect(red._errors.some((e) => e.includes("boom"))).toBe(true);
  });
});

describe("hooks.hasHook", () => {
  it("reports whether any plugin implements a hook", () => {
    const hooks = makeHooks(
      fakeRED([{ id: "a", hooks: { onInbound: () => {} } }]),
    );
    expect(hooks.hasHook("onInbound")).toBe(true);
    expect(hooks.hasHook("onCanSendTo")).toBe(false);
  });
});

describe("legacy hook type", () => {
  it("plugins on the old type still run, after the new ones, with one warning each", () => {
    const calls = [];
    const red = fakeRED(
      [{ id: "new", hooks: { onInbound: (m) => (calls.push("new"), m) } }],
      [{ id: "old", hooks: { onInbound: (m) => (calls.push("old"), m) } }],
    );
    const hooks = makeHooks(red);
    hooks.transform("onInbound", {});
    hooks.transform("onInbound", {});
    expect(calls).toEqual(["new", "old", "new", "old"]);
    const warnings = red._errors.filter((m) => /old hook type/.test(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"old".*"fromcubes-portal-react".*"fromcubes-hooks"/);
  });

  it("an old-type plugin can still veto a connection", () => {
    const hooks = makeHooks(fakeRED([], [{ id: "old", hooks: { onIsValidConnection: () => false } }]));
    expect(hooks.allow("onIsValidConnection", {})).toBe(false);
  });
});
