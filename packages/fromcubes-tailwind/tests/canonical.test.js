/**
 * canonical.js — canonical class names from a worker thread, and the
 * guards that keep a misbehaving worker from touching Node-RED.
 */

const path = require("path");
const { createCanonicalizer, canonicalizer } = require("../canonical");

const fixture = (name) => path.join(__dirname, "fixtures", name);
const made = [];
const make = (opts) => {
  const logs = [];
  const c = createCanonicalizer({ log: (m) => logs.push(m), ...opts });
  made.push(c);
  return { c, logs };
};

afterEach(() => made.splice(0).forEach((c) => c.stop()));
afterAll(() => canonicalizer.stop());

test("the real worker answers with Tailwind's canonical spellings", { timeout: 60000 }, async () => {
  const { c } = make();
  expect(await c.canonicalize(["w-[16px]", "p-4", "flex-grow", "mt-[-16px]"])).toEqual(["w-4", "p-4", "grow", "-mt-4"]);
  expect(c.state()).toMatchObject({ running: true, failures: 0, pending: 0 });
});

test("Node-RED's thread keeps running while the index is built", { timeout: 60000 }, async () => {
  const { c } = make();
  let ticks = 0;
  const iv = setInterval(() => ticks++, 10);
  const started = Date.now();
  await c.canonicalize(["w-[16px]"]);
  clearInterval(iv);
  // A blocked event loop would not tick at all during the build.
  expect(ticks).toBeGreaterThan((Date.now() - started) / 10 / 4);
});

test("answers are passed through, request by request", async () => {
  const { c } = make({ workerFile: fixture("worker-echo.js") });
  const [a, b] = await Promise.all([c.canonicalize(["a", "b"]), c.canonicalize(["c"])]);
  expect(a).toEqual(["A", "B"]);
  expect(b).toEqual(["C"]);
  expect(await c.canonicalize([])).toEqual([]);
});

test("no answer in time: nulls, the worker is terminated, the failure counted", async () => {
  const { c, logs } = make({ workerFile: fixture("worker-silent.js"), timeoutMs: 200 });
  expect(await c.canonicalize(["a", "b"])).toEqual([null, null]);
  expect(c.state()).toMatchObject({ running: false, failures: 1, disabled: false });
  expect(logs[0]).toMatch(/no answer within 200 ms/);
});

test("a crashing worker: nulls; after maxFailures in a row the feature is off, logged once", async () => {
  const { c, logs } = make({ workerFile: fixture("worker-crash.js"), maxFailures: 2 });
  expect(await c.canonicalize(["a"])).toEqual([null]);
  expect(c.state()).toMatchObject({ failures: 1, disabled: false });
  expect(await c.canonicalize(["a"])).toEqual([null]);
  expect(c.state()).toMatchObject({ failures: 2, disabled: true, running: false });
  expect(logs.filter((m) => /switched off/.test(m))).toHaveLength(1);
  // switched off: answered at once, no worker started
  expect(await c.canonicalize(["a"])).toEqual([null]);
  expect(c.state().running).toBe(false);
});

test("a malformed answer is nulls, not trusted", async () => {
  const { c } = make({ workerFile: fixture("worker-bad-reply.js") });
  expect(await c.canonicalize(["a", "b"])).toEqual([null, null]);
});

test("the heap cap stops a runaway worker, not the process", { timeout: 60000 }, async () => {
  const { c, logs } = make({ workerFile: fixture("worker-hog.js"), maxHeapMb: 32, timeoutMs: 30000 });
  expect(await c.canonicalize(["a"])).toEqual([null]);
  expect(c.state()).toMatchObject({ running: false, failures: 1 });
  expect(logs[0]).toMatch(/worker stopped/);
});

test("the queue is bounded", async () => {
  const { c } = make({ workerFile: fixture("worker-silent.js"), maxPending: 2, timeoutMs: 5000 });
  c.canonicalize(["a"]);
  c.canonicalize(["b"]);
  expect(await c.canonicalize(["c"])).toEqual([null]);
  expect(c.state().pending).toBe(2);
});

test("an idle worker is stopped and started again when needed", async () => {
  const { c } = make({ workerFile: fixture("worker-echo.js"), idleMs: 50 });
  expect(await c.canonicalize(["a"])).toEqual(["A"]);
  expect(c.state().running).toBe(true);
  await new Promise((r) => setTimeout(r, 150));
  expect(c.state().running).toBe(false);
  expect(await c.canonicalize(["b"])).toEqual(["B"]);
  expect(c.state()).toMatchObject({ running: true, failures: 0 });
});

test("warm() starts the worker ahead of the first request", () => {
  const { c } = make({ workerFile: fixture("worker-echo.js") });
  expect(c.state().running).toBe(false);
  c.warm();
  expect(c.state().running).toBe(true);
});

test("the main thread never canonicalises", () => {
  const fs = require("fs");
  for (const file of ["candidates.js", "intellisense.js", "tailwind.js", "css.js", "canonical.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    expect(src, file).not.toMatch(/\.canonicalizeCandidates\(/);
  }
});
