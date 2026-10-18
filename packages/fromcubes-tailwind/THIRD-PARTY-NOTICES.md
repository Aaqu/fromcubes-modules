# Third-party notices

This package derives from the material listed below. Each notice travels with
every copy, as its licence requires.

## Tailwind CSS IntelliSense — `intellisense.js`

`intellisense.js` is ported from
[Tailwind CSS IntelliSense](https://github.com/tailwindlabs/tailwindcss-intellisense)
(`packages/tailwindcss-language-service`): colour detection (`util/color.ts`,
`util/colorEquivalents.ts`), theme-value and calc rewriting (`util/rewriting/`),
pixel equivalents (`util/pixelEquivalents.ts`) and the CSS shown for a class
(`util/jit.ts`, `completionProvider.ts`), and what the diagnostics compare
(`diagnostics/getCssConflictDiagnostics.ts`, `diagnostics/canonical-classes.ts`,
with CSS.escape as in the `css.escape` package). It is translated to plain JavaScript
and runs on Tailwind's own design system; departures from the original are
marked in the code.

```
MIT License

Copyright (c) Tailwind Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
