# fromcubes-modules

React portals for Node-RED — write JSX in the editor, deploy, open the URL; the
page talks to your flow over WebSocket. No build step, no browser compiler.

**📖 Documentation:** [aaqu.github.io/fromcubes-modules](https://aaqu.github.io/fromcubes-modules/) ·
**💬 Discord:** [join](https://discord.gg/KYzsfKkYxX) ·
**❤️ Sponsor:** [GitHub Sponsors](https://github.com/sponsors/Aaqu)

## Packages

| Package | |
|---|---|
| [`@aaqu/fromcubes-react`](packages/fromcubes-react) | The core: `portal-react` nodes, deploy-time bundling, WebSocket bridge, React Editor. **Start here** — [full README](packages/fromcubes-react/README.md) |
| [`@aaqu/fromcubes-tailwind`](packages/fromcubes-tailwind) | Tailwind CSS 4 for portals, with editor class completion |
| [`@aaqu/fromcubes-auth-headers`](packages/fromcubes-auth-headers) | Portal users from `x-portal-user-*` headers set by a reverse proxy |
| [`@aaqu/fromcubes-assets`](packages/fromcubes-assets) | Static files for portals, managed from a sidebar tab |

```bash
cd ~/.node-red
npm install @aaqu/fromcubes-react   # brings the three add-ons along, for now
# restart Node-RED
```

The add-ons are Node-RED plugins built on the core's public plugin API; your
own identity provider or CSS engine can be one too — see
[Plugins](packages/fromcubes-react/README.md#plugins-identity-providers-and-css-engines).

## Development

```bash
npm install   # workspaces: links the packages to each other
npm test      # every package, plus the cross-package tests in tests/
```

Internals and the plugin API: [README-DEV.md](packages/fromcubes-react/README-DEV.md).

## Support

fromcubes is built and maintained by one person. If it saves you time,
consider sponsoring its development:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor_on-GitHub-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Aaqu)

## License

Apache-2.0
