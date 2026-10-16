/**
 * Add-on: CSS engine "tailwind" — Tailwind CSS 4 utilities generated
 * server-side at deploy (css.js), with the class list for editor completion
 * (candidates.js).
 *
 * A Node-RED plugin, loaded by Node-RED itself (package.json → node-red →
 * plugins). The core (@aaqu/fromcubes-react) finds it by type through
 * RED.plugins; this package reaches the core only through its `api` export.
 */

const { CSS_TYPE, API_VERSION } = require("@aaqu/fromcubes-react/api");
const { generateCSS } = require("./css");
const { generateCandidates } = require("./candidates");

const provider = {
  type: CSS_TYPE,
  apiVersion: API_VERSION,
  label: "Tailwind CSS 4 utility classes",
  generate: (source) => generateCSS(source),
  editor: { classes: () => generateCandidates() },
};

module.exports = function (RED) {
  RED.plugins.registerPlugin("tailwind", provider);
};

// For tests: the definition exactly as registered.
module.exports.provider = provider;
