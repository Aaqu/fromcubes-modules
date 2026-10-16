/**
 * The `x-portal-user-*` identity header contract (fromcubes-portal ADR 0008):
 * six headers set by an upstream auth proxy, every value percent-encoded
 * UTF-8. Pure parsing — no Node-RED, no I/O — so it is tested directly.
 *
 * Returns a PortalUser (see nodes/lib/helpers.js typedef) or null.
 */

// Cap on the `x-portal-user-groups` header. An oversized value is dropped
// whole rather than cut: a truncated list could end in a shortened group name
// that happens to match a different, real group. Same order of magnitude as
// Express's default header size — an honest auth proxy never gets near it.
const MAX_GROUPS_HEADER_BYTES = 8 * 1024;

// Single-value identity headers → PortalUser field. `x-portal-user-id` is the
// gate: without it the request is anonymous and the rest is ignored.
const PORTAL_USER_FIELDS = [
  ["x-portal-user-login", "login"],
  ["x-portal-user-display-name", "displayName"],
  ["x-portal-user-email", "email"],
  ["x-portal-user-role", "role"],
];

/**
 * Percent-decode one header value (UTF-8). Returns undefined for a malformed
 * escape or an empty result, so the caller skips the value instead of
 * keeping a half-decoded string.
 *
 * @param {*} raw
 * @returns {string|undefined}
 */
function decodeHeaderValue(raw) {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const value = decodeURIComponent(raw);
    return value === "" ? undefined : value;
  } catch (_) {
    return undefined;
  }
}

/**
 * Parse `x-portal-user-groups`: comma-separated, each element percent-encoded
 * on its own, so a literal comma inside a group name arrives as `%2C`. Split
 * on the raw commas BEFORE decoding; empty elements and elements with a
 * malformed escape are dropped, the rest survive.
 *
 * @param {*} raw
 * @returns {Array<string>}
 */
function parseGroupsHeader(raw) {
  if (typeof raw !== "string" || raw.length > MAX_GROUPS_HEADER_BYTES) {
    return [];
  }
  const groups = [];
  for (const part of raw.split(",")) {
    // Trim the raw element: Node joins a repeated header with ", ".
    const value = decodeHeaderValue(part.trim());
    if (value !== undefined) groups.push(value);
  }
  return groups;
}

/**
 * Build a PortalUser object from `x-portal-user-*` headers set by an upstream
 * auth proxy. Every value is percent-encoded UTF-8 (HTTP headers carry only
 * latin1, so "Łukasz" cannot travel raw). Returns null — anonymous — when
 * `x-portal-user-id` is missing or undecodable, whatever else is present.
 *
 * @param {Object<string,string>} headers HTTP request headers (lower-cased).
 * @returns {PortalUser|null}
 */
function extractPortalUser(headers) {
  const userId = decodeHeaderValue(headers["x-portal-user-id"]);
  if (userId === undefined) return null;
  const user = { userId };
  for (const [header, field] of PORTAL_USER_FIELDS) {
    const value = decodeHeaderValue(headers[header]);
    if (value !== undefined) user[field] = value;
  }
  user.groups = parseGroupsHeader(headers["x-portal-user-groups"]);
  return user;
}

module.exports = { extractPortalUser, MAX_GROUPS_HEADER_BYTES };
