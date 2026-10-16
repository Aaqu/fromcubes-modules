# @aaqu/fromcubes-tailwind

[![npm version](https://img.shields.io/npm/v/%40aaqu%2Ffromcubes-tailwind.svg)](https://www.npmjs.com/package/@aaqu/fromcubes-tailwind)
[![license](https://img.shields.io/npm/l/%40aaqu%2Ffromcubes-tailwind.svg)](./LICENSE)

Tailwind CSS 4 for [`@aaqu/fromcubes-react`](https://www.npmjs.com/package/@aaqu/fromcubes-react)
portals — a Node-RED plugin that registers the CSS engine `tailwind`.

- At deploy, each portal's source is scanned for class names and only the
  utilities it uses are built — server-side, no CDN, no browser compiler.
- In the editor, `className="…"` offers Tailwind classes as you type.

## Install

```bash
cd ~/.node-red
npm install @aaqu/fromcubes-tailwind
# restart Node-RED
```

Requires `@aaqu/fromcubes-react` (a peer dependency — npm installs it if it is
missing). `tailwind` is the default CSS engine, so nothing else needs setting;
**Menu → Settings → Fromcubes** shows it and lets you switch engines.

## Limitations

Only complete class names in the source are seen: `bg-${tone}-500` produces
no CSS. Write the full names (`tone === "red" ? "bg-red-500" : "bg-blue-500"`).

## License

Apache-2.0
