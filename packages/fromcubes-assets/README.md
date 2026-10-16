# @aaqu/fromcubes-assets

[![npm version](https://img.shields.io/npm/v/%40aaqu%2Ffromcubes-assets.svg)](https://www.npmjs.com/package/@aaqu/fromcubes-assets)
[![license](https://img.shields.io/npm/l/%40aaqu%2Ffromcubes-assets.svg)](./LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Aaqu)

Static files for [`@aaqu/fromcubes-react`](https://www.npmjs.com/package/@aaqu/fromcubes-react)
portals — 3D models, textures, fonts, images — a Node-RED plugin.

- **Sidebar tab "Portal Assets"** in the editor: upload (also drag & drop),
  folders, rename, move, download, delete.
- Files live in `<userDir>/fromcubes/public/` and are served publicly at
  `<httpNodeRoot>/fromcubes/public/<path>`, so a portal loads them with e.g.
  `useGLTF("/fromcubes/public/models/robot.glb")`.

## Install

```bash
cd ~/.node-red
npm install @aaqu/fromcubes-assets
# restart Node-RED
```

Requires `@aaqu/fromcubes-react` (a peer dependency).

## Security

- Every change goes through the editor's admin API: Node-RED's admin auth
  (`portal-react.write`), a CSRF header check and a rate limit.
- Paths are validated segment by segment; `..`, hidden files, Windows-reserved
  names and symlinks escaping the folder are refused.
- `.html`, `.svg` and `.js` are served as downloads with
  `Content-Security-Policy: default-src 'none'`, never rendered.
- Errors on the public route say only `Not found` / `Forbidden` /
  `Bad request` — never where files live on disk.
- Limits: 100 MB per upload, 500 MB and 1000 files in total, 10 folder levels.

## Support

fromcubes is built and maintained by one person. If it saves you time,
consider sponsoring its development:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor_on-GitHub-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Aaqu)

## License

Apache-2.0
