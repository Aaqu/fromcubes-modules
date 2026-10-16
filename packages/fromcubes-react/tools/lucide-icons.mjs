/**
 * Vendored Lucide icon data — the one place these paths live.
 *
 * The project needs eight icons; a dependency on Lucide for eight icons would
 * cost more than it explains, so the path data is copied in from
 * lucide-react v1.25.0 (ISC — see THIRD-PARTY-NOTICES.md) and left otherwise
 * untouched. Both generators read from here, so the node icons on the canvas
 * and the file icons in the tree can never drift apart.
 *
 * Each entry carries its upstream Lucide name, which the licence notice lists.
 */

/** @typedef {{lucide: string, body: string}} LucideIcon */

/** Lucide's own canvas: 24x24, stroked, round caps. */
export const VIEW_BOX = "0 0 24 24";
export const STROKE_ATTRS =
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

/** @type {Object<string, LucideIcon>} */
export const ICONS = {
  atom: {
    lucide: "atom",
    body: [
      '<circle cx="12" cy="12" r="1"/>',
      '<path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z"/>',
      '<path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z"/>',
    ].join("\n"),
  },
  component: {
    lucide: "component",
    body: [
      '<path d="M15.536 11.293a1 1 0 0 0 0 1.414l2.376 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/>',
      '<path d="M2.297 11.293a1 1 0 0 0 0 1.414l2.377 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414L6.088 8.916a1 1 0 0 0-1.414 0z"/>',
      '<path d="M8.916 17.912a1 1 0 0 0 0 1.415l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.415l-2.377-2.376a1 1 0 0 0-1.414 0z"/>',
      '<path d="M8.916 4.674a1 1 0 0 0 0 1.414l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/>',
    ].join("\n"),
  },
  wrench: {
    lucide: "wrench",
    body:
      '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>',
  },
  codeXml: {
    lucide: "code-xml",
    body: [
      '<path d="m18 16 4-4-4-4"/>',
      '<path d="m6 8-4 4 4 4"/>',
      '<path d="m14.5 4-5 16"/>',
    ].join("\n"),
  },
  folder: {
    lucide: "folder",
    body:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  },
  folderOpen: {
    lucide: "folder-open",
    body:
      '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  },
  workflow: {
    lucide: "workflow",
    body: [
      '<rect width="8" height="8" x="3" y="3" rx="2"/>',
      '<path d="M7 11v4a2 2 0 0 0 2 2h4"/>',
      '<rect width="8" height="8" x="13" y="13" rx="2"/>',
    ].join("\n"),
  },
  ban: {
    lucide: "ban",
    body: ['<circle cx="12" cy="12" r="10"/>', '<path d="M4.929 4.929 19.07 19.071"/>'].join("\n"),
  },
  chevronRight: { lucide: "chevron-right", body: '<path d="m9 18 6-6-6-6"/>' },
  chevronDown: { lucide: "chevron-down", body: '<path d="m6 9 6 6 6-6"/>' },
};
