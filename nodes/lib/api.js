/** @module nodes/lib/api */

/**
 * The core's public surface for add-ons. Everything under `nodes/addons/`
 * reaches the core through this file and nothing else (a test enforces it),
 * so moving an add-on into its own package means changing one require:
 * `../../lib/api` → `@aaqu/fromcubes-portal-react/api`.
 *
 * Keep it small and stable — anything exported here is a promise to every
 * add-on, ours and third-party.
 */

const { createAdminSecurity, loadExpress } = require("./admin-security");
const {
  IDENTITY_TYPE,
  CSS_TYPE,
  API_VERSION,
} = require("./providers");

module.exports = {
  // Plugin contract (see lib/providers.js)
  IDENTITY_TYPE,
  CSS_TYPE,
  API_VERSION,
  // Admin route gates shared with the core: permission, CSRF, rate limit
  createAdminSecurity,
  // The express Node-RED itself ships (static/json/raw middleware)
  loadExpress,
};
