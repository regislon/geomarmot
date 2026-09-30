# 0003 — SheetJS comes from its own tarball and runs in a module worker

**Status:** accepted

The npm registry stops at SheetJS 0.18.5, which has a prototype-pollution bug on crafted files.
SheetJS publishes later versions as a tarball on its own CDN. `package.json` depends on
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`; `npm ci` installs it and records its
integrity hash in the lockfile, so builds do not fetch it at runtime.

The spike confirmed that 0.20.3 imports inside a Vite module worker (`worker.format: "es"`) and
round-trips a workbook with dates. All workbook parsing and writing stays in that worker so a
large workbook never freezes the page.
