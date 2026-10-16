/**
 * Add-on: Portal Assets — static files (models, textures, fonts…) served
 * publicly at `<httpNodeRoot>/fromcubes/public/`, managed from a sidebar tab
 * in the editor (portal-assets.html). Files live in
 * `<userDir>/fromcubes/public/`.
 *
 * A Node-RED plugin, loaded by Node-RED itself (package.json → node-red →
 * plugins). Its admin routes use the core's gates through lib/api, so they
 * share the core's permission scopes, CSRF check and rate-limit buckets.
 */

const os = require("os");
const path = require("path");
const { createAdminSecurity, loadExpress } = require("../../lib/api");
const { registerAssets } = require("./assets");

module.exports = function (RED) {
  const { csrfGuard, rateLimit } = createAdminSecurity(RED);
  const userDir = RED.settings.userDir || path.join(os.homedir(), ".node-red");
  registerAssets(RED, loadExpress(), path.join(userDir, "fromcubes", "public"), {
    csrfGuard,
    rateLimit,
  });
  // A plugin with no type: registered so Node-RED lists it with its module
  // and loads portal-assets.html into the editor.
  RED.plugins.registerPlugin("fromcubes-portal-assets", {});
};
