// Answers every request: the candidate upper-cased.
const { parentPort } = require("worker_threads");
parentPort.on("message", ({ id, candidates }) => parentPort.postMessage({ id, results: candidates.map((c) => c.toUpperCase()) }));
