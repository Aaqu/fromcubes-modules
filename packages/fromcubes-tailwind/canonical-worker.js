/**
 * Worker thread for canonical class names (`w-[16px]` → `w-4`).
 *
 * Tailwind builds its canonicalisation index on first use — over a second
 * of CPU. Done on Node-RED's own thread it would stop every flow for that
 * long, so it lives here: its own design system, built as soon as the
 * worker starts, answering `{id, candidates}` with `{id, results}`.
 * Supervised by canonical.js.
 */

const { parentPort } = require("worker_threads");
const { __unstable__loadDesignSystem } = require("tailwindcss");
const { loadStylesheet, TW_INPUT } = require("./css");

// rem → px for canonical forms; IntelliSense's `rootFontSize` default.
const ROOT_FONT_SIZE = 16;

const ready = __unstable__loadDesignSystem(TW_INPUT, { base: __dirname, loadStylesheet }).then((ds) => {
  if (typeof ds.canonicalizeCandidates !== "function") return null;
  // Build the index now, not on the first request.
  ds.canonicalizeCandidates(["p-4"], { rem: ROOT_FONT_SIZE });
  return ds;
});

parentPort.on("message", async (msg) => {
  const id = msg && msg.id;
  try {
    const ds = await ready;
    const candidates = Array.isArray(msg.candidates) ? msg.candidates : [];
    // One at a time, as IntelliSense: canonicalising a whole list may one
    // day merge classes, which would no longer map one to one.
    const results = candidates.map((c) => {
      if (!ds || typeof c !== "string") return null;
      try {
        return ds.canonicalizeCandidates([c], { rem: ROOT_FONT_SIZE })[0] ?? null;
      } catch {
        return null;
      }
    });
    parentPort.postMessage({ id, results });
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
});
