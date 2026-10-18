/**
 * Add-on: CSS engine "tailwind" — Tailwind CSS 4 utilities generated
 * server-side at deploy (css.js), with what the editor needs to complete and
 * explain classes the way Tailwind CSS IntelliSense does (candidates.js).
 *
 * A Node-RED plugin, loaded by Node-RED itself (package.json → node-red →
 * plugins). The core (@aaqu/fromcubes-react) finds it by type through
 * RED.plugins; this package reaches the core only through its `api` export.
 */

const { CSS_TYPE, API_VERSION } = require("@aaqu/fromcubes-react/api");
const { generateCSS } = require("./css");
const { generateCandidates, completionData, describeCandidates, canonicalCandidates } = require("./candidates");
const { canonicalizer } = require("./canonical");

const provider = {
  type: CSS_TYPE,
  apiVersion: API_VERSION,
  label: "Tailwind CSS 4 utility classes",
  generate: (source) => generateCSS(source),
  editor: {
    // Plain names, for cores that know only this.
    classes: () => generateCandidates(),
    completions: () => completionData(),
    describe: (candidates) => describeCandidates(candidates),
    canonical: (candidates) => canonicalCandidates(candidates),
  },
};

module.exports = function (RED) {
  canonicalizer.setLog((msg) => RED.log.warn("[fromcubes-tailwind] " + msg));
  RED.plugins.registerPlugin("tailwind", provider);
};

// For tests: the definition exactly as registered.
module.exports.provider = provider;
