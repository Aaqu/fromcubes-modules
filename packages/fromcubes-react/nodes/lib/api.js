/** @module nodes/lib/api */

/**
 * The core's public surface for add-ons. Add-on packages
 * (@aaqu/fromcubes-auth-headers, -tailwind, -assets, and third-party ones)
 * require `@aaqu/fromcubes-react/api` — package.json `exports` maps it here —
 * and nothing else from the core (tests/addon-boundary.test.js).
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
