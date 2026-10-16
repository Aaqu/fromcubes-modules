/**
 * Add-on: identity provider "headers" — the user comes from `x-portal-user-*`
 * headers injected by a reverse proxy (see headers.js for the contract).
 *
 * A Node-RED plugin, loaded by Node-RED itself (package.json → node-red →
 * plugins). The core finds it by type through RED.plugins; nothing in the
 * core requires this file.
 */

const { IDENTITY_TYPE, API_VERSION } = require("../../lib/api");
const { extractPortalUser } = require("./headers");

const provider = {
  type: IDENTITY_TYPE,
  apiVersion: API_VERSION,
  label: "x-portal-user-* headers from a reverse proxy",
  resolveUser: (req) => extractPortalUser(req.headers || {}),
};

module.exports = function (RED) {
  RED.plugins.registerPlugin("headers", provider);
};

// For tests: the definition exactly as registered.
module.exports.provider = provider;
