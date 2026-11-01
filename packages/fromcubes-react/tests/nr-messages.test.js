/**
 * The browser side of per-message delivery: the `window.__NR` bridge that
 * buildPage inlines, and the useNodeRedMessages hook from NR_HOOKS_SRC. Both
 * run in a vm against a fake WebSocket/document and a tiny React stand-in —
 * there is no DOM in this test suite, and the point is the wiring, not React.
 */

const vm = require("vm");
const { buildPage, NR_HOOKS_SRC } = require("../nodes/lib/page-builder");

// The first inline <script> of the page holds the bridge.
function bridgeSource() {
  const html = buildPage("t", "", "/fromcubes/t/_ws", "", "", null, false, "");
  const m = html.match(/<script>([\s\S]*?window\.__NR\.connect\(\);)/);
  if (!m) throw new Error("bridge script not found");
  return m[1];
}

function makeEnv() {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }
    send(s) {
      this.sent.push(s);
    }
    close() {}
  }
  const errors = [];
  const window = {};
  const ctx = {
    window,
    WebSocket: FakeWebSocket,
    location: { protocol: "http:", host: "x", reload() {} },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {} }),
      body: { appendChild() {} },
    },
    console: { error: (...a) => errors.push(a), log() {} },
    setTimeout: () => 0,
    Date,
    JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(bridgeSource(), ctx);
  const ws = sockets[0];
  const frame = (obj) => ws.onmessage({ data: JSON.stringify(obj) });
  return { ctx, NR: window.__NR || ctx.window.__NR, frame, errors };
}

describe("window.__NR.subscribeMessages", () => {
  it("calls the listener once per data frame, with topic", () => {
    const { NR, frame } = makeEnv();
    const got = [];
    NR.subscribeMessages((p, meta) => got.push([p, meta.topic]));
    frame({ type: "data", payload: { a: 1 }, topic: "adresacja-ip" });
    frame({ type: "data", payload: { b: 2 }, topic: "photos" });
    frame({ type: "data", payload: 3 });
    expect(got).toEqual([
      [{ a: 1 }, "adresacja-ip"],
      [{ b: 2 }, "photos"],
      [3, ""],
    ]);
  });

  it("does not replay the last frame on subscribe (subscribe still does)", () => {
    const { NR, frame } = makeEnv();
    frame({ type: "data", payload: "old" });
    const perMsg = [];
    const state = [];
    NR.subscribeMessages((p) => perMsg.push(p));
    NR.subscribe((p) => state.push(p));
    expect(perMsg).toEqual([]);
    expect(state).toEqual(["old"]);
  });

  it("isolates a throwing listener from the others and from useNodeRed", () => {
    const { NR, frame, errors } = makeEnv();
    const got = [];
    const state = [];
    NR.subscribeMessages(() => {
      throw new Error("boom");
    });
    NR.subscribeMessages((p) => got.push(p));
    NR.subscribe((p) => state.push(p));
    frame({ type: "data", payload: 1 });
    expect(got).toEqual([1]);
    expect(state).toEqual([1]);
    expect(errors).toHaveLength(1);
  });

  it("stops after unsubscribe", () => {
    const { NR, frame } = makeEnv();
    const got = [];
    const off = NR.subscribeMessages((p) => got.push(p));
    frame({ type: "data", payload: 1 });
    off();
    frame({ type: "data", payload: 2 });
    expect(got).toEqual([1]);
  });

  it("ignores non-data frames", () => {
    const { NR, frame } = makeEnv();
    const got = [];
    NR.subscribeMessages((p) => got.push(p));
    frame({ type: "hello", portalClient: "c1" });
    frame({ type: "auth_required" });
    expect(got).toEqual([]);
  });
});

describe("useNodeRedMessages (NR_HOOKS_SRC)", () => {
  // A React stand-in for one component instance: refs persist across
  // renders, layout effects run every render, mount effects run once.
  function fakeReact() {
    const refs = [];
    const cleanups = [];
    let i = 0;
    let mounted = false;
    const React = {
      useRef(v) {
        const k = i++;
        if (!(k in refs)) refs[k] = { current: v };
        return refs[k];
      },
      useLayoutEffect(fn) {
        fn();
      },
      useEffect(fn, deps) {
        if (deps && deps.length === 0 && mounted) return;
        const c = fn();
        if (typeof c === "function") cleanups.push(c);
      },
      useState(v) {
        const k = i++;
        if (!(k in refs)) refs[k] = { current: typeof v === "function" ? v() : v };
        const box = refs[k];
        return [box.current, (nv) => { box.current = nv; }];
      },
      useCallback: (f) => f,
    };
    return {
      React,
      render(component) {
        i = 0;
        component();
        mounted = true;
      },
      unmount() {
        cleanups.forEach((c) => c());
      },
    };
  }

  function setup() {
    const env = makeEnv();
    const r = fakeReact();
    env.ctx.React = r.React;
    vm.runInContext(NR_HOOKS_SRC, env.ctx);
    return { ...env, r, hook: env.ctx.window.useNodeRedMessages };
  }

  it("delivers two back-to-back frames to the handler, both of them", () => {
    const { r, hook, frame } = setup();
    const got = [];
    r.render(() => hook((p, { topic }) => got.push(topic)));
    frame({ type: "data", payload: {}, topic: "adresacja-ip" });
    frame({ type: "data", payload: {}, topic: "photos" });
    expect(got).toEqual(["adresacja-ip", "photos"]);
  });

  it("subscribes once and always calls the latest handler", () => {
    const { r, hook, frame, NR } = setup();
    const got = [];
    r.render(() => hook((p) => got.push("first:" + p)));
    r.render(() => hook((p) => got.push("second:" + p)));
    expect(NR._msgListeners.size).toBe(1);
    frame({ type: "data", payload: 1 });
    expect(got).toEqual(["second:1"]);
  });

  it("unsubscribes on unmount", () => {
    const { r, hook, NR } = setup();
    r.render(() => hook(() => {}));
    r.unmount();
    expect(NR._msgListeners.size).toBe(0);
  });

  it("is a window property, so a portal's own declaration shadows it", () => {
    expect(NR_HOOKS_SRC).toMatch(/window\.useNodeRedMessages\s*=/);
    expect(NR_HOOKS_SRC).not.toMatch(/^function useNodeRedMessages/m);
  });

  it("useNodeRed exposes data and topic of the same, last frame", () => {
    const { r, ctx, frame } = setup();
    let out;
    const comp = () => { out = ctx.useNodeRed(); };
    r.render(comp);
    expect(out.data).toBe(null);
    expect(out.topic).toBe("");
    frame({ type: "data", payload: 1, topic: "a" });
    frame({ type: "data", payload: 2 });
    r.render(comp);
    expect(out.data).toBe(2);
    expect(out.topic).toBe("");
    frame({ type: "data", payload: 3, topic: "b" });
    r.render(comp);
    expect([out.data, out.topic]).toEqual([3, "b"]);
  });

  it("useNodeRed seeds a late mount with the last frame and its topic", () => {
    const { r, ctx, frame } = setup();
    frame({ type: "data", payload: "x", topic: "t" });
    let out;
    r.render(() => { out = ctx.useNodeRed(); });
    expect([out.data, out.topic]).toEqual(["x", "t"]);
  });
});
