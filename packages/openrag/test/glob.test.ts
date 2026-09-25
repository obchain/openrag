import { describe, expect, it } from "vitest";
import { compileDirectoryGlobs, compileGlobs, globToRegExp, matchesAny } from "../src/load/glob.js";

const matches = (pattern: string, path: string) => globToRegExp(pattern).test(path);

describe("globToRegExp", () => {
  it("matches a file at the root and deep inside with **/", () => {
    expect(matches("**/*.md", "guide.md")).toBe(true);
    expect(matches("**/*.md", "docs/billing/refunds.md")).toBe(true);
    expect(matches("**/*.md", "docs/billing/refunds.html")).toBe(false);
  });

  it("keeps a single * inside one segment", () => {
    expect(matches("docs/*.md", "docs/guide.md")).toBe(true);
    expect(matches("docs/*.md", "docs/billing/guide.md")).toBe(false);
  });

  it("matches one character with ?", () => {
    expect(matches("v?.md", "v2.md")).toBe(true);
    expect(matches("v?.md", "v22.md")).toBe(false);
  });

  it("treats a dot as a literal, not as any character", () => {
    expect(matches("*.md", "guide.md")).toBe(true);
    expect(matches("*.md", "guidexmd")).toBe(false);
  });

  it("matches dotfiles anywhere with **/.*", () => {
    expect(matches("**/.*", ".env")).toBe(true);
    expect(matches("**/.*", "docs/.env")).toBe(true);
    expect(matches("**/.*", "docs/env")).toBe(false);
  });

  it("matches everything under a folder with a trailing /**", () => {
    expect(matches("**/node_modules/**", "node_modules/pkg/readme.md")).toBe(true);
    expect(matches("**/node_modules/**", "app/node_modules/pkg/readme.md")).toBe(true);
    expect(matches("**/node_modules/**", "node_modules")).toBe(false);
  });
});

describe("compileDirectoryGlobs", () => {
  it("prunes the folder itself, which the file pattern does not match", () => {
    const patterns = compileDirectoryGlobs(["**/node_modules/**"]);
    expect(matchesAny("node_modules", patterns)).toBe(true);
    expect(matchesAny("app/node_modules", patterns)).toBe(true);
    expect(matchesAny("app/node_modules_old", patterns)).toBe(false);
  });
});

describe("matchesAny", () => {
  it("is true when any pattern matches and false for an empty list", () => {
    const patterns = compileGlobs(["**/*.md", "**/*.txt"]);
    expect(matchesAny("notes.txt", patterns)).toBe(true);
    expect(matchesAny("notes.pdf", patterns)).toBe(false);
    expect(matchesAny("notes.txt", [])).toBe(false);
  });
});
