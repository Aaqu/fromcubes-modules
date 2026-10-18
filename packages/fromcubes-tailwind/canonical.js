/**
 * Canonical class names, computed off Node-RED's thread.
 *
 * Supervises canonical-worker.js so that nothing it does can stall or take
 * down Node-RED:
 * - started lazily (the editor's first visit) and stopped again after
 *   `idleMs` without requests; `unref()`ed, so it never keeps the process up;
 * - its heap is capped (`maxHeapMb`): Tailwind blowing up kills the worker,
 *   not Node-RED;
 * - every request answers within `timeoutMs` — a late or stuck worker is
 *   terminated and the request answered with nulls;
 * - a crash, error or timeout counts as a failure; after `maxFailures` in a
 *   row canonical suggestions are switched off for the process, logged once
 *   — a success resets the count;
 * - at most `maxPending` requests wait; beyond that the answer is nulls.
 * Every failure answers `null` per candidate — "no suggestion" — never a
 * rejection: the only feature at stake is the canonical-class warning.
 */

const path = require("path");

const DEFAULTS = {
  workerFile: path.join(__dirname, "canonical-worker.js"),
  // The first request waits for the index: ~2 s, more on a busy machine.
  timeoutMs: 20000,
  idleMs: 10 * 60 * 1000,
  maxFailures: 3,
  maxPending: 100,
  maxHeapMb: 256,
};

/**
 * @param {Object} [options]  Overrides of DEFAULTS, plus `log(msg)` for warnings.
 * @returns {{canonicalize: function(Array<string>): Promise<Array<string|null>>, warm: function(): void, stop: function(): void, state: function(): Object}}
 */
function createCanonicalizer(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  let log = opts.log || (() => {});
  let Worker = null;
  try {
    ({ Worker } = require("worker_threads"));
  } catch {
    // no worker threads: no canonical suggestions, and nothing heavy here
  }

  let worker = null;
  let failures = 0;
  let disabled = !Worker;
  let nextId = 1;
  let idleTimer = null;
  const pending = new Map();

  function settleAll() {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve(entry.nulls);
      pending.delete(id);
    }
  }

  function stopWorker() {
    clearTimeout(idleTimer);
    idleTimer = null;
    const w = worker;
    worker = null;
    if (w) {
      w.removeAllListeners();
      w.on("error", () => {});
      w.terminate().catch(() => {});
    }
    settleAll();
  }

  function fail(reason) {
    failures++;
    stopWorker();
    if (failures >= opts.maxFailures) {
      disabled = true;
      log(`canonical class suggestions switched off after ${failures} failures (last: ${reason})`);
    } else {
      log(`canonical class worker stopped: ${reason}`);
    }
  }

  function armIdle() {
    clearTimeout(idleTimer);
    if (pending.size > 0 || !worker) return;
    idleTimer = setTimeout(stopWorker, opts.idleMs);
    idleTimer.unref();
  }

  function spawn() {
    if (worker || disabled) return worker;
    let w;
    try {
      w = new Worker(opts.workerFile, { resourceLimits: { maxOldGenerationSizeMb: opts.maxHeapMb } });
    } catch (e) {
      fail(e.message);
      return null;
    }
    w.unref();
    w.on("message", (msg) => {
      const entry = msg && pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      const ok = !msg.error && Array.isArray(msg.results) && msg.results.length === entry.nulls.length;
      if (ok) failures = 0;
      entry.resolve(ok ? msg.results.map((r) => (typeof r === "string" ? r : null)) : entry.nulls);
      armIdle();
    });
    w.on("error", (e) => {
      if (worker === w) fail(e.message);
    });
    w.on("exit", (code) => {
      if (worker === w) fail(`exited with code ${code}`);
    });
    worker = w;
    armIdle();
    return w;
  }

  /**
   * Tailwind's canonical spelling per candidate (itself when already
   * canonical), or `null` where none could be had.
   *
   * @param {Array<string>} candidates
   * @returns {Promise<Array<string|null>>}
   */
  function canonicalize(candidates) {
    const nulls = candidates.map(() => null);
    if (candidates.length === 0 || disabled || pending.size >= opts.maxPending) return Promise.resolve(nulls);
    const w = spawn();
    if (!w) return Promise.resolve(nulls);
    clearTimeout(idleTimer);
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        resolve(nulls);
        fail(`no answer within ${opts.timeoutMs} ms`);
      }, opts.timeoutMs);
      timer.unref();
      pending.set(id, { resolve, timer, nulls });
      w.postMessage({ id, candidates });
    });
  }

  return {
    canonicalize,
    // Start building the index ahead of the first request.
    warm: () => void spawn(),
    stop: stopWorker,
    setLog: (fn) => {
      log = fn || (() => {});
    },
    state: () => ({ running: !!worker, disabled, failures, pending: pending.size }),
  };
}

const canonicalizer = createCanonicalizer();

module.exports = { createCanonicalizer, canonicalizer, DEFAULTS };
