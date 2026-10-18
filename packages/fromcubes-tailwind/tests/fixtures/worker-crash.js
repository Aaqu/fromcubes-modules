// Dies on the first request.
const { parentPort } = require("worker_threads");
parentPort.on("message", () => {
  throw new Error("boom");
});
