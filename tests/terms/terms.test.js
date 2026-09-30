import { describe, expect, it, beforeEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHashFile, candidates, parseHashFile, scanText, tokenize } from "../../scripts/terms/lib.js";

const SALT = "test-salt";
const LIST = parseHashFile(buildHashFile(SALT, ["acme widgets", "zorblax"]));
const SCRIPT = resolve("scripts/check-terms.js");

describe("tokenize", () => {
  it("splits camelCase and acronyms before lowercasing", () => {
    expect(tokenize("AcmeWidgets").pieces).toEqual(["acme", "widgets"]);
    expect(tokenize("HTTPServer").pieces).toEqual(["http", "server"]);
    expect(tokenize("ACMEWidgets").pieces).toEqual(["acme", "widgets"]);
  });

  it("splits letter/digit boundaries and separators", () => {
    expect(tokenize("acme2widgets").pieces).toEqual(["acme", "2", "widgets"]);
    expect(tokenize("acme-widgets_x").pieces).toEqual(["acme", "widgets", "x"]);
  });

  it("folds full-width look-alikes with NFKC", () => {
    expect(tokenize("ＺＯＲＢＬＡＸ").runs).toEqual(["zorblax"]);
  });
});

describe("scanText", () => {
  const variants = ["Acme Widgets", "acme-widgets", "AcmeWidgets", "ACMEWIDGETS", "acmewidgets", "ACME_WIDGETS"];
  for (const text of variants) {
    it(`matches "${text}"`, () => expect(scanText(`x ${text} y`, LIST).length).toBeGreaterThan(0));
  }

  it("does not match unrelated text", () => {
    expect(scanText("acme gadgets and widgetry", LIST)).toEqual([]);
  });

  it("reports the line", () => {
    expect(scanText("ok\nzorblax\n", LIST)[0].line).toBe(2);
  });

  it("candidates include 3-piece concatenations", () => {
    expect(candidates("a b c")).toContain("abc");
  });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "terms-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "tester@example.org");
  git("config", "user.name", "Tester");
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts/forbidden-terms.sha256"), buildHashFile(SALT, ["acme widgets", "zorblax"]));
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const run = (...a) => spawnSync("node", [SCRIPT, ...a, "--cwd", dir], { encoding: "utf8" });
  return { dir, git, run };
}

describe("check-terms CLI", () => {
  let r;
  beforeEach(() => {
    r = repo();
  });

  it("the hash file scans itself without a hit", () => {
    expect(r.run("--tree").status).toBe(0);
    expect(r.run("--history", "--all").status).toBe(0);
  });

  it("catches a hit in a path", () => {
    writeFileSync(join(r.dir, "zorblax-notes.txt"), "fine");
    r.git("add", ".");
    expect(r.run("--tree").status).toBe(1);
  });

  it("scans staged content, not the working copy", () => {
    writeFileSync(join(r.dir, "a.txt"), "made by AcmeWidgets");
    r.git("add", "a.txt");
    writeFileSync(join(r.dir, "a.txt"), "clean now");
    expect(r.run("--staged").status).toBe(1);
    r.git("add", "a.txt");
    expect(r.run("--staged").status).toBe(0);
  });

  it("catches a bad commit message, a bad author email and an added line in an old commit", () => {
    writeFileSync(join(r.dir, "b.txt"), "zorblax inside\n");
    r.git("add", ".");
    r.git("commit", "-q", "-m", "add b");
    writeFileSync(join(r.dir, "b.txt"), "clean\n");
    r.git("add", ".");
    r.git("commit", "-q", "-m", "clean b");
    expect(r.run("--tree").status).toBe(0);
    expect(r.run("--history", "--all").status).toBe(1);

    const r2 = repo();
    writeFileSync(join(r2.dir, "c.txt"), "x");
    r2.git("add", ".");
    r2.git("commit", "-q", "-m", "Thanks, Acme Widgets team");
    expect(r2.run("--history", "HEAD~1..HEAD").status).toBe(1);

    const r3 = repo();
    writeFileSync(join(r3.dir, "d.txt"), "x");
    r3.git("add", ".");
    r3.git("-c", "user.email=me@zorblax.example", "commit", "-q", "-m", "ok");
    expect(r3.run("--history", "--all").status).toBe(1);
  });

  it("--all includes the root commit's message, author and content", () => {
    const dir = mkdtempSync(join(tmpdir(), "terms-root-"));
    const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "tester@example.org");
    git("config", "user.name", "Tester");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts/forbidden-terms.sha256"), buildHashFile(SALT, ["zorblax"]));
    writeFileSync(join(dir, "root.txt"), "zorblax\n");
    git("add", ".");
    git("commit", "-q", "-m", "root");
    writeFileSync(join(dir, "root.txt"), "clean\n");
    git("add", ".");
    git("commit", "-q", "-m", "second");
    const run = (...a) => spawnSync("node", [SCRIPT, ...a, "--cwd", dir], { encoding: "utf8" });
    expect(run("--history", "HEAD~1..HEAD").status).toBe(0);
    expect(run("--history", "--all").status).toBe(1);
  });

  it("refuses binaries outside the allowlist and checks PNG metadata", () => {
    writeFileSync(join(r.dir, "data.bin"), Buffer.from([0, 1, 2, 0]));
    r.git("add", ".");
    expect(r.run("--tree").status).toBe(1);
    r.git("rm", "-q", "--cached", "data.bin");

    mkdirSync(join(r.dir, "docs/img"), { recursive: true });
    const text = Buffer.from("Author\0zorblax");
    const chunk = Buffer.concat([Buffer.alloc(4), Buffer.from("tEXt"), text, Buffer.alloc(4)]);
    chunk.writeUInt32BE(text.length, 0);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk]);
    writeFileSync(join(r.dir, "docs/img/shot.png"), png);
    r.git("add", ".");
    expect(r.run("--tree").status).toBe(1);
  });

  it("scans stdin with --text", () => {
    const res = spawnSync("node", [SCRIPT, "--text", "--cwd", r.dir], {
      input: "PR by acme widgets",
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
  });
});
