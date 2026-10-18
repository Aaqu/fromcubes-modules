// Never answers.
const { parentPort } = require("worker_threads");
parentPort.on("message", () => {});
