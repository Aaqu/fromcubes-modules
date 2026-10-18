// Allocates until the heap cap stops it.
const { parentPort } = require("worker_threads");
parentPort.on("message", () => {
  const hoard = [];
  for (;;) hoard.push(new Array(1e6).fill(Math.random()));
});
