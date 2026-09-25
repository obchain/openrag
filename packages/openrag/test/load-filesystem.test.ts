import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentId } from "../src/hash.js";
import { loadFiles } from "../src/load/filesystem.js";

let root = "";

const write = async (relative: string, contents: string | Uint8Array) => {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  return absolute;
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openrag-fs-"));
  await write("index.md", "# Welcome\n");
  await write("guides/billing-refunds.md", "# Refunds\nWe refund within 30 days.\n");
  await write("guides/deep/nested/setup.html", "<h1>Setup</h1>");
  await write("guides/notes.txt", "plain text");
  await write("logo.png", "binary-ish but not included");
  await write(".env", "SECRET=1");
  await write(".cache/page.md", "# Hidden\n");
  await write("node_modules/pkg/readme.md", "# Dependency\n");
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("loadFiles", () => {
  it("returns one document per file with relative, /-separated uris", async () => {
    const { documents, failures } = await loadFiles(root);
    expect(documents.map((document) => document.uri)).toEqual([
      "guides/billing-refunds.md",
      "guides/deep/nested/setup.html",
      "guides/notes.txt",
      "index.md",
    ]);
    expect(failures).toEqual([]);
  });

  it("skips dotfiles, dot folders, node_modules and formats that are not included", async () => {
    const uris = (await loadFiles(root)).documents.map((document) => document.uri);
    expect(uris).not.toContain(".env");
    expect(uris).not.toContain(".cache/page.md");
    expect(uris).not.toContain("node_modules/pkg/readme.md");
    expect(uris).not.toContain("logo.png");
  });

  it("honours custom include and exclude patterns", async () => {
    const { documents } = await loadFiles(root, {
      include: ["guides/**/*.md"],
      exclude: ["**/billing-*.md"],
    });
    expect(documents).toEqual([]);

    const onlyHtml = await loadFiles(root, { include: ["**/*.html"] });
    expect(onlyHtml.documents.map((document) => document.uri)).toEqual(["guides/deep/nested/setup.html"]);
  });

  it("produces byte-identical documents when nothing changed", async () => {
    const first = await loadFiles(root);
    const second = await loadFiles(root);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("derives ids from the namespace and uri, not from run order", async () => {
    const { documents } = await loadFiles(root, { namespace: "acme" });
    const billing = documents.find((document) => document.uri === "guides/billing-refunds.md");
    expect(billing?.id).toBe(documentId("acme", "guides/billing-refunds.md"));

    const other = await loadFiles(root, { namespace: "globex" });
    expect(other.documents[0]?.uri).toBe(documents[0]?.uri);
    expect(other.documents[0]?.id).not.toBe(documents[0]?.id);
  });

  it("fingerprints content and carries size and mtime", async () => {
    const { documents } = await loadFiles(root, { include: ["index.md"] });
    const document = documents[0];
    expect(document?.text).toBe("# Welcome\n");
    expect(document?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(document?.metadata?.bytes).toBe(10);
    expect(typeof document?.metadata?.modifiedAt).toBe("string");
  });

  it("titles a document from its path, using the folder for index and readme", async () => {
    const { documents } = await loadFiles(root);
    const titles = Object.fromEntries(documents.map((document) => [document.uri, document.title]));
    expect(titles["guides/billing-refunds.md"]).toBe("billing refunds");
    expect(titles["index.md"]).toBe("index"); // nothing above it to name it after

    const directory = await mkdtemp(path.join(tmpdir(), "openrag-title-"));
    await mkdir(path.join(directory, "billing-and-plans"));
    await writeFile(path.join(directory, "billing-and-plans/index.md"), "# Billing\n");
    await writeFile(path.join(directory, "billing-and-plans/README.md"), "# Billing\n");

    const nested = await loadFiles(directory);
    expect(nested.documents.map((document) => document.title)).toEqual([
      "billing and plans",
      "billing and plans",
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  it("returns an empty result for an empty folder", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "openrag-empty-"));
    await expect(loadFiles(empty)).resolves.toEqual({ documents: [], failures: [] });
    await rm(empty, { recursive: true, force: true });
  });

  it("reports a missing path instead of throwing", async () => {
    const missing = path.join(root, "nope");
    const { documents, failures } = await loadFiles(missing);
    expect(documents).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.uri).toBe(missing);
  });

  it("reports an unreadable file and still loads the rest", async () => {
    if (process.getuid?.() === 0) return; // root can read anything
    const directory = await mkdtemp(path.join(tmpdir(), "openrag-perm-"));
    await writeFile(path.join(directory, "readable.md"), "# Fine\n");
    const locked = path.join(directory, "locked.md");
    await writeFile(locked, "# Secret\n");
    await chmod(locked, 0o000);

    const { documents, failures } = await loadFiles(directory);
    expect(documents.map((document) => document.uri)).toEqual(["readable.md"]);
    expect(failures.map((failure) => failure.uri)).toEqual(["locked.md"]);

    await chmod(locked, 0o600);
    await rm(directory, { recursive: true, force: true });
  });

  it("reports a symbolic link instead of following it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openrag-link-"));
    await writeFile(path.join(directory, "real.md"), "# Real\n");
    await symlink(path.join(directory, "real.md"), path.join(directory, "link.md"));

    const { documents, failures } = await loadFiles(directory);
    expect(documents.map((document) => document.uri)).toEqual(["real.md"]);
    expect(failures[0]).toEqual({ uri: "link.md", reason: "symbolic link skipped" });
    await rm(directory, { recursive: true, force: true });
  });

  it("skips a file with binary content even when the pattern includes it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openrag-bin-"));
    await writeFile(path.join(directory, "page.md"), "# Text\n");
    await writeFile(path.join(directory, "image.md"), Buffer.from([0x89, 0x50, 0x00, 0x1a]));

    const { documents, failures } = await loadFiles(directory);
    expect(documents.map((document) => document.uri)).toEqual(["page.md"]);
    expect(failures).toEqual([{ uri: "image.md", reason: "looks like a binary file" }]);
    await rm(directory, { recursive: true, force: true });
  });

  it("skips a file over the size limit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openrag-big-"));
    await writeFile(path.join(directory, "huge.md"), "x".repeat(2048));

    const { documents, failures } = await loadFiles(directory, { maxBytes: 1024 });
    expect(documents).toEqual([]);
    expect(failures[0]?.reason).toContain("over the 1024 byte limit");
    await rm(directory, { recursive: true, force: true });
  });

  it("loads a folder of 120 files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openrag-many-"));
    for (let i = 0; i < 120; i++) {
      await writeFile(path.join(directory, `page-${String(i).padStart(3, "0")}.md`), `# Page ${i}\n`);
    }
    const { documents, failures } = await loadFiles(directory);
    expect(documents).toHaveLength(120);
    expect(new Set(documents.map((document) => document.id)).size).toBe(120);
    expect(failures).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  });

  it("accepts a list of files and makes uris relative to their common parent", async () => {
    const { documents } = await loadFiles([
      path.join(root, "index.md"),
      path.join(root, "guides/billing-refunds.md"),
    ]);
    expect(documents.map((document) => document.uri)).toEqual(["guides/billing-refunds.md", "index.md"]);
  });

  it("loads a named file even when the include patterns would not pick it up", async () => {
    const { documents } = await loadFiles(path.join(root, "logo.png"), { root });
    expect(documents.map((document) => document.uri)).toEqual(["logo.png"]);
  });

  it("uses an explicit root for uris when one is given", async () => {
    const { documents } = await loadFiles(path.join(root, "guides"), { root });
    expect(documents.map((document) => document.uri)).toContain("guides/notes.txt");
  });
});
