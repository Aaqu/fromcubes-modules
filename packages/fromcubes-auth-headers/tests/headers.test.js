/**
 * The x-portal-user-* header contract (fromcubes-portal ADR 0008):
 * whitelist of fields, percent-decoding, groups limits, no key injection.
 * What forged headers buy an attacker end-to-end is in the monorepo's
 * tests/identity.test.js.
 */

const { extractPortalUser, MAX_GROUPS_HEADER_BYTES } = require("../headers");

describe("extractPortalUser — header contract", () => {
  it("returns null when no identity header is present", () => {
    expect(extractPortalUser({})).toBeNull();
    expect(extractPortalUser({ host: "red:1880", cookie: "a=1" })).toBeNull();
  });

  it("maps the six contract headers", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-login": "jan",
      "x-portal-user-display-name": "Jan%20Kowalski",
      "x-portal-user-email": "jan%40example.com",
      "x-portal-user-role": "editor",
      "x-portal-user-groups": "ops,dev",
    });
    expect(user).toEqual({
      userId: "u1",
      login: "jan",
      displayName: "Jan Kowalski",
      email: "jan@example.com",
      role: "editor",
      groups: ["ops", "dev"],
    });
  });

  it("percent-decodes UTF-8 values", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-display-name": "%C5%81ukasz%20%C5%BB%C3%B3%C5%82%C4%87",
    });
    expect(user.displayName).toBe("Łukasz Żółć");
  });

  it("missing x-portal-user-id means anonymous, whatever else is present", () => {
    expect(
      extractPortalUser({
        "x-portal-user-login": "jan",
        "x-portal-user-display-name": "Jan",
        "x-portal-user-email": "jan%40example.com",
        "x-portal-user-role": "editor",
        "x-portal-user-groups": "ops",
      }),
    ).toBeNull();
  });

  it("empty or undecodable x-portal-user-id means anonymous", () => {
    expect(extractPortalUser({ "x-portal-user-id": "" })).toBeNull();
    expect(extractPortalUser({ "x-portal-user-id": "%E0%A4%A" })).toBeNull();
  });

  it("drops a single-value field with a malformed escape, keeps the rest", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-display-name": "%E0%A4%A",
      "x-portal-user-login": "jan",
    });
    expect(user).toEqual({ userId: "u1", login: "jan", groups: [] });
  });

  it("ignores the pre-contract -username / -name headers", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-username": "jan",
      "x-portal-user-name": "Jan Kowalski",
    });
    expect(user).toEqual({ userId: "u1", groups: [] });
  });

  it("ignores non-contract x-portal-user-* headers (no arbitrary key injection)", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-isadmin": "true",
      "x-portal-user-__proto__": "x",
      "x-portal-user-constructor": "x",
    });
    expect(Object.keys(user)).toEqual(["userId", "groups"]);
  });
});

describe("extractPortalUser — groups header", () => {
  const groupsOf = (raw) =>
    extractPortalUser({ "x-portal-user-id": "u1", "x-portal-user-groups": raw })
      .groups;

  it("splits on raw commas before decoding, so %2C stays inside a name", () => {
    expect(
      groupsOf("Utrzymanie%20ruchu%20%E2%80%93%20hala%202,a%2Cb,hala-2"),
    ).toEqual(["Utrzymanie ruchu – hala 2", "a,b", "hala-2"]);
  });

  it("empty or missing header yields []", () => {
    expect(groupsOf("")).toEqual([]);
    expect(extractPortalUser({ "x-portal-user-id": "u1" }).groups).toEqual([]);
  });

  it("drops empty elements", () => {
    expect(groupsOf(",,x,")).toEqual(["x"]);
  });

  it("drops only the element with a malformed escape", () => {
    expect(groupsOf("ok,%E0%A4%A,hala-2")).toEqual(["ok", "hala-2"]);
  });

  it("trims around raw commas (Node joins a repeated header with ', ')", () => {
    expect(groupsOf("ops, dev")).toEqual(["ops", "dev"]);
  });

  it("does not parse JSON any more", () => {
    expect(groupsOf('["a","b"]')).toEqual(['["a"', '"b"]']);
  });

  it("drops an oversized header whole instead of truncating a name", () => {
    const big = "a,".repeat(MAX_GROUPS_HEADER_BYTES);
    expect(groupsOf(big)).toEqual([]);
  });

  it("userId '__proto__' cannot poison a Map-based userIndex", () => {
    const userIndex = new Map();
    const user = extractPortalUser({ "x-portal-user-id": "__proto__" });
    userIndex.set(user.userId, new Set());
    expect(userIndex.get("__proto__")).toBeInstanceOf(Set);
    expect({}.size).toBeUndefined();
  });
});
