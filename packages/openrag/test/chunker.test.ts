import { describe, expect, it } from "vitest";
import { chunkDocument, embedText } from "../src/chunk/chunker.js";
import { parseMarkdown } from "../src/parse/markdown.js";
import type { SourceDocument } from "../src/types.js";

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

const document = (text: string): SourceDocument => ({
  id: "doc1",
  namespace: "acme",
  uri: "docs/refunds.md",
  title: "refunds",
  text,
  contentHash: "hash",
});

const chunk = (source: string, maxTokens: number, header = true) => {
  const document_ = document(source);
  return chunkDocument(document_, parseMarkdown(source), { maxTokens, header, countTokens: words });
};

const PAGE = `# Billing

Intro line here.

## Refunds

Refunds land within 30 days.

Cards are faster than bank transfers.

### International

Bank transfers take longer.
`;

describe("chunkDocument", () => {
  it("never mixes two sections into one chunk, however much budget is left", () => {
    const pieces = chunk(PAGE, 1000); // far more budget than the whole page needs
    expect(pieces.map((piece) => piece.headingPath)).toEqual([[], ["Refunds"], ["Refunds", "International"]]);
    for (const piece of pieces) {
      const sections = ["Intro line here.", "Refunds land within 30 days.", "Bank transfers take longer."];
      expect(sections.filter((line) => piece.text.includes(line))).toHaveLength(1);
    }
  });

  it("packs neighbouring blocks of one section together", () => {
    const refunds = chunk(PAGE, 100).find((piece) => piece.headingPath.join() === "Refunds");
    expect(refunds?.text).toBe("Refunds land within 30 days.\n\nCards are faster than bank transfers.");
  });

  it("starts a new chunk when the budget is spent", () => {
    const pieces = chunk(PAGE, 12).filter((piece) => piece.headingPath.join() === "Refunds");
    expect(pieces).toHaveLength(2);
    expect(pieces[0]?.text).toBe("Refunds land within 30 days.");
  });

  it("counts the header against the budget, since the header is embedded too", () => {
    for (const piece of chunk(PAGE, 12)) {
      expect(words(embedText(piece, true))).toBeLessThanOrEqual(12);
    }
  });

  it("carries the document's identity onto every chunk", () => {
    const [first] = chunk(PAGE, 100);
    expect(first?.docId).toBe("doc1");
    expect(first?.namespace).toBe("acme");
    expect(first?.uri).toBe("docs/refunds.md");
    expect(first?.title).toBe("Billing"); // the page's own h1, not the file name
    expect(first?.id).toMatch(/^doc1-[0-9a-f]{12}$/);
    expect(first?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps a chunk's id when text above it changes, so only that text re-embeds", () => {
    const deepest = (source: string) =>
      chunk(source, 100).find((piece) => piece.headingPath.join() === "Refunds,International");
    const before = deepest(PAGE);
    const after = deepest(
      PAGE.replace("Intro line here.", "Intro line here, now rather longer than before."),
    );
    expect(after?.id).toBe(before?.id);
    expect(after?.charStart).not.toBe(before?.charStart); // it did move
  });

  it("fingerprints what the embedder reads, so one paragraph under two headings stays two chunks", () => {
    const page = "# T\n\n## A\n\nSame paragraph text.\n\n## B\n\nSame paragraph text.\n";
    const [a, b] = chunk(page, 100);
    expect(a?.text).toBe(b?.text);
    expect(a?.hash).not.toBe(b?.hash);
    expect(a?.id).not.toBe(b?.id);
  });

  it("gives two truly identical chunks distinct ids", () => {
    const page = "# T\n\n## A\n\nRepeated line.\n\nOther text between.\n\nRepeated line.\n";
    const ids = chunk(page, 6).map((piece) => piece.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses a budget the header alone cannot fit, instead of shredding the page", () => {
    const page =
      "# A Very Long Document Title That Eats The Entire Budget By Itself\n\n## Section\n\nBody text here.\n";
    expect(() => chunk(page, 5)).toThrow(/budget/);
  });

  it("reads back from the source at the offsets it reports, every block of it", () => {
    for (const piece of chunk(PAGE, 100)) {
      const span = PAGE.slice(piece.charStart, piece.charEnd);
      for (const block of piece.text.split("\n\n")) expect(span).toContain(block);
      // the span ends where the chunk ends, not early
      expect(span.endsWith(piece.text.split("\n\n").at(-1) as string)).toBe(true);
    }
  });

  it("keeps offsets true for a block it had to split", () => {
    const long = `## Setup\n\n${Array.from({ length: 12 }, (_, i) => `Step number ${i} explains a thing.`).join(" ")}\n`;
    const pieces = chunk(long, 10);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(long.slice(piece.charStart, piece.charEnd)).toBe(piece.text);
    }
  });

  it("builds the embedded text as path then piece, and can leave the path out", () => {
    const [first] = chunk(PAGE, 100);
    expect(embedText(first as never, true)).toBe("Billing\nIntro line here.");
    expect(embedText(first as never, false)).toBe("Intro line here.");
  });

  it("keeps a block whose text alone fits but whose header pushes it over", () => {
    // Nine words of text under a two-word path: fits on text alone, not with the header.
    const page = "# Billing\n\n## Refunds\n\none two three four five six seven eight nine\n";
    for (const piece of chunk(page, 10)) {
      expect(words(embedText(piece, true))).toBeLessThanOrEqual(10);
    }
    expect(chunk(page, 10).length).toBeGreaterThan(1);
  });

  it("returns nothing for a document with no blocks", () => {
    expect(chunk("", 100)).toEqual([]);
  });
});
