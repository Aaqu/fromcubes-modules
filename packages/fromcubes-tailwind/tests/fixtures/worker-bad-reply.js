// Answers with the wrong shape.
const { parentPort } = require("worker_threads");
parentPort.on("message", ({ id }) => parentPort.postMessage({ id, results: ["only-one"] }));
