/*
 * Build the GitHub Pages site into _site/:  npm run build:site
 *
 *   _site/        the documentation, built with Zensical (zensical.toml): README.md as the home
 *                 page, docs/ as its sections, CONTRIBUTING.md
 *   _site/demo/   the app (the Vite build in dist/)
 *
 * The pages are staged into _site_src/ first, with their links fixed for the site: a link to
 * another page of the site becomes a link to its page, and a link to any other file of the
 * repository points at that file on GitHub. site/ holds the site's own assets (logo, styles).
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const REPO = "https://github.com/regislon/geomarmot";
const ZENSICAL = "zensical==0.0.67";
const SRC = "_site_src";
const OUT = "_site";

if (!existsSync("dist/index.html")) {
  console.error("Build the app first: npm run build");
  process.exit(1);
}

/** Repository path → path inside the site's sources. */
const pages = new Map([
  ["README.md", "index.md"],
  ["CONTRIBUTING.md", "contributing.md"],
]);
for (const name of readdirSync("docs")) if (name.endsWith(".md")) pages.set(`docs/${name}`, name);
for (const name of readdirSync("docs/decisions"))
  pages.set(`docs/decisions/${name}`, name === "README.md" ? "decisions/index.md" : `decisions/${name}`);
const folders = new Map([["docs/decisions", "decisions/index.md"]]);

function siteLink(fromRepo, fromSite, href) {
  if (/^([a-z]+:|#|\/)/i.test(href)) return href;
  const [path, anchor] = href.split("#");
  const target = posix.normalize(posix.join(posix.dirname(fromRepo), path)).replace(/\/$/, "");
  const staged = pages.get(target) || folders.get(target);
  const hash = anchor ? `#${anchor}` : "";
  if (staged) return posix.relative(posix.dirname(fromSite), staged) + hash;
  if (target.startsWith("docs/img/")) return posix.relative(posix.dirname(fromSite), target.slice("docs/".length));
  const folder = existsSync(target) && statSync(target).isDirectory();
  return `${REPO}/${folder ? "tree" : "blob"}/main/${target}${hash}`;
}

rmSync(SRC, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
for (const [repoPath, sitePath] of pages) {
  const text = readFileSync(repoPath, "utf8").replace(
    /(\]\()([^)\s]+)(\))/g,
    (_, open, href, close) => open + siteLink(repoPath, sitePath, href) + close,
  );
  mkdirSync(dirname(join(SRC, sitePath)), { recursive: true });
  writeFileSync(join(SRC, sitePath), text);
}
cpSync("docs/img", join(SRC, "img"), { recursive: true });
cpSync("site", SRC, { recursive: true });

execFileSync("uvx", [ZENSICAL, "build", "--clean"], { stdio: "inherit" });
cpSync("dist", join(OUT, "demo"), { recursive: true });
rmSync(SRC, { recursive: true, force: true });
console.log(`Wrote ${OUT}/ (documentation) and ${OUT}/demo/ (the app)`);
