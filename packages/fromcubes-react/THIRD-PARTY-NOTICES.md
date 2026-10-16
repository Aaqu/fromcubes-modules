# Third-party notices

This package bundles or derives from the material listed below. Each notice
travels with every copy, as its licence requires.

## Lucide — the node icons in `nodes/icons/`

Each node icon is a composite. The cube is the fromcubes mark, traced from the
project's own artwork by `tools/build-icon.mjs` and not third-party material.
Beside it sits one icon from [Lucide](https://lucide.dev), recoloured and scaled
to the icon canvas; its path data is otherwise unchanged:

| File | Node type | Lucide icon |
| --- | --- | --- |
| `fromcubes-react.svg` | `portal-react` | `atom` |
| `fromcubes-component.svg` | `fc-portal-component` | `component` |
| `fromcubes-utility.svg` | `fc-portal-utility` | `wrench` |

The editor's file tree wears the same icons from the same source, plus five
more, built into `nodes/editor/icons.svg` by `tools/build-sprite.mjs`:

| Sprite symbol | Used for | Lucide icon |
| --- | --- | --- |
| `fc-icon-atom` | portal file | `atom` |
| `fc-icon-component` | component file | `component` |
| `fc-icon-wrench` | utility file | `wrench` |
| `fc-icon-code-xml` | `head.html` | `code-xml` |
| `fc-icon-folder` / `fc-icon-folder-open` | group folder | `folder` / `folder-open` |
| `fc-icon-workflow` | flow tab | `workflow` |
| `fc-icon-ban` | disabled node or flow | `ban` |
| `fc-icon-chevron-right` / `fc-icon-chevron-down` | expand toggle | `chevron-right` / `chevron-down` |

All path data lives once, in `tools/lucide-icons.mjs`, and is copied verbatim.
React's own logo is a Meta trademark and is deliberately not used.

ISC requires this notice to travel with every copy.

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors
2022.

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Ark Pixel — `nodes/editor/ark-pixel.woff2`

The editor's brand lockup is set in **Ark Pixel 10px proportional** by TakWolf,
release 2026.08.11, shipped unmodified. The file is the project's own `latin`
build (the editor's chrome is Latin-only), taken from the upstream release
rather than subsetted here, so it stays byte-identical to what TakWolf ships. The SIL Open Font License requires its text to travel with the font,
so the full licence is also kept beside it as
`nodes/editor/ark-pixel.LICENSE.txt`.

```
Ark Pixel Font
https://github.com/TakWolf/ark-pixel-font

Copyright (c) 2021, TakWolf (https://takwolf.com).

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
