# @aaqu/fromcubes-tailwind

[![npm version](https://img.shields.io/npm/v/%40aaqu%2Ffromcubes-tailwind.svg)](https://www.npmjs.com/package/@aaqu/fromcubes-tailwind)
[![license](https://img.shields.io/npm/l/%40aaqu%2Ffromcubes-tailwind.svg)](./LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Aaqu)

Tailwind CSS 4 for [`@aaqu/fromcubes-react`](https://www.npmjs.com/package/@aaqu/fromcubes-react)
portals — a Node-RED plugin that registers the CSS engine `tailwind`.

- At deploy, each portal's source is scanned for class names and only the
  utilities it uses are built — server-side, no CDN, no browser compiler.
- In the editor, `className="…"` completes the way
  [Tailwind CSS IntelliSense](https://github.com/tailwindlabs/tailwindcss-intellisense)
  does in VS Code, from Tailwind's own design system: every class and variant,
  colour swatches, `/50`-style modifiers, and the generated CSS — with theme
  values and pixel sizes — beside each suggestion and on hover. Colour squares
  sit next to colour classes in the code (the picker rewrites arbitrary ones
  like `bg-[#f00]`), and the same warnings appear, with quick fixes: classes
  that set the same CSS (`p-2 p-4`) and classes with a canonical spelling
  (`w-[16px]` → `w-4`).

## Install

```bash
cd ~/.node-red
npm install @aaqu/fromcubes-tailwind
# restart Node-RED
```

Requires `@aaqu/fromcubes-react` (a peer dependency — npm installs it if it is
missing). Once installed, `tailwind` becomes the CSS engine by itself — there
is nothing to set (unless you chose another engine before);
**Menu → Settings → Fromcubes** shows it and lets you switch engines. Without
this add-on the core serves portals with no generated stylesheet.

## Limitations

Only complete class names in the source are seen: `bg-${tone}-500` produces
no CSS. Write the full names (`tone === "red" ? "bg-red-500" : "bg-blue-500"`).

## Support

fromcubes is built and maintained by one person. If it saves you time,
consider sponsoring its development:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor_on-GitHub-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Aaqu)

## License

Apache-2.0
