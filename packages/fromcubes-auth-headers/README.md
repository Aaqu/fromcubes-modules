# @aaqu/fromcubes-auth-headers

[![npm version](https://img.shields.io/npm/v/%40aaqu%2Ffromcubes-auth-headers.svg)](https://www.npmjs.com/package/@aaqu/fromcubes-auth-headers)
[![license](https://img.shields.io/npm/l/%40aaqu%2Ffromcubes-auth-headers.svg)](./LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Aaqu)

Identity for [`@aaqu/fromcubes-react`](https://www.npmjs.com/package/@aaqu/fromcubes-react)
portals from headers set by a reverse proxy — a Node-RED plugin that registers
the identity provider `headers`.

With **Portal Auth** on in a portal node, the user behind each session comes
from these headers; it appears as `useNodeRed().user` in the page and as
`msg._client` on messages, and drives per-user and authenticated-only
delivery.

| Header | Field |
|---|---|
| `x-portal-user-id` | `userId` — required; without it the session is anonymous |
| `x-portal-user-login` | `login` |
| `x-portal-user-display-name` | `displayName` |
| `x-portal-user-email` | `email` |
| `x-portal-user-role` | `role` |
| `x-portal-user-groups` | `groups` — comma-separated, always an array |

Every value is percent-encoded UTF-8 (`%C5%81ukasz` → `Łukasz`). A malformed
value is skipped; in `groups` only that element.

> **The proxy must strip all six headers from the client's request** before
> setting its own, and Node-RED must be reachable only through the proxy. The
> headers are trusted as they arrive — one let through is enough to
> impersonate any user.

## Install

```bash
cd ~/.node-red
npm install @aaqu/fromcubes-auth-headers
# restart Node-RED
```

Requires `@aaqu/fromcubes-react` (a peer dependency). Once installed, `headers`
becomes the identity provider by itself (unless you chose another before);
**Menu → Settings → Fromcubes** shows it and lets you switch providers.
Without this add-on, Portal Auth sees every session as anonymous.

## Support

fromcubes is built and maintained by one person. If it saves you time,
consider sponsoring its development:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor_on-GitHub-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Aaqu)

## License

Apache-2.0
