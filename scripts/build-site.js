/*
 * Build the GitHub Pages site into _site/:
 *
 *   _site/index.html   README.md, rendered
 *   _site/demo/        the app (the Vite build in dist/)
 *
 *   npm run build && node scripts/build-site.js
 *
 * Links in the README to files of the repository point at GitHub; images are
 * copied next to the page.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { marked } from "marked";

const REPO = "https://github.com/regislon/geomarmot";
const OUT = "_site";

if (!existsSync("dist/index.html")) {
  console.error("Build the app first: npm run build");
  process.exit(1);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync("dist", join(OUT, "demo"), { recursive: true });

const isRelative = (href) => !/^([a-z]+:|#|\/)/i.test(href);
const renderer = new marked.Renderer();
const baseLink = renderer.link.bind(renderer);
const baseImage = renderer.image.bind(renderer);
renderer.link = (token) => {
  if (isRelative(token.href)) {
    const path = token.href.replace(/^\.\//, "");
    // A folder (docs/decisions/, examples) is a tree on GitHub; a file is a blob.
    const folder = existsSync(path) && statSync(path).isDirectory();
    token.href = `${REPO}/${folder ? "tree" : "blob"}/main/${path}`;
  }
  return baseLink(token);
};
renderer.image = (token) => {
  if (isRelative(token.href)) {
    const target = join(OUT, token.href);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(token.href, target);
  }
  return baseImage(token);
};

const body = marked.parse(readFileSync("README.md", "utf8"), { renderer, gfm: true });

writeFileSync(
  join(OUT, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeoMarmot</title>
<meta name="description" content="Spatial ETL in your browser.">
<style>
  :root { --ink: #2a241d; --paper: #fbfaf7; --accent: #3f7d5a; --muted: #6d7a70; --border: #d8d8d0; --code: #f2f0ea; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #ece7df; --paper: #16130f; --accent: #7fae8c; --muted: #a3ab9f; --border: #3a342c; --code: #231f1a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { position: sticky; top: 0; display: flex; align-items: center; gap: 16px; padding: 12px 16px;
           background: var(--paper); border-bottom: 1px solid var(--border); }
  header strong { font-family: ui-serif, Georgia, serif; font-size: 20px; flex: 1; }
  .demo { background: var(--accent); color: #fff; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: 600; }
  .demo:hover { filter: brightness(1.1); }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-family: ui-serif, Georgia, serif; font-size: 40px; margin: 8px 0 16px; }
  h2 { font-family: ui-serif, Georgia, serif; margin-top: 40px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
  a { color: var(--accent); }
  img { max-width: 100%; border: 1px solid var(--border); border-radius: 6px; }
  blockquote { margin: 0; padding: 4px 16px; border-left: 4px solid var(--accent); color: var(--muted); }
  code { background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
  pre { background: var(--code); padding: 12px 16px; border-radius: 6px; overflow-x: auto; }
  pre code { padding: 0; background: none; }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
</style>
</head>
<body>
<header><strong>GeoMarmot</strong><a href="${REPO}">GitHub</a><a class="demo" href="demo/">Try the demo</a></header>
<main>
${body}
</main>
</body>
</html>
`,
);
console.log(`Wrote ${OUT}/index.html and ${OUT}/demo/`);
