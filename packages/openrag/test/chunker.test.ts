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
  it("never mixes two sections into one chunk", () => {
    for (const piece of chunk(PAGE, 100)) {
      expect(piece.text.split("\n\n").length).toBeGreaterThan(0);
    }
    expect(chunk(PAGE, 100).map((piece) => piece.headingPath)).toEqual([
      [],
      ["Refunds"],
      ["Refunds", "International"],
    ]);
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
      expect(words(embedText(piece))).toBeLessThanOrEqual(12);
    }
  });

  it("carries the document's identity onto every chunk", () => {
    const [first] = chunk(PAGE, 100);
    expect(first?.docId).toBe("doc1");
    expect(first?.namespace).toBe("acme");
    expect(first?.uri).toBe("docs/refunds.md");
    expect(first?.title).toBe("Billing"); // the page's own h1, not the file name
    expect(first?.id).toBe("doc1-0");
    expect(first?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads back from the source at the offsets it reports", () => {
    for (const piece of chunk(PAGE, 100)) {
      expect(PAGE.slice(piece.charStart, piece.charEnd)).toContain(piece.text.split("\n\n")[0]);
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
    expect(embedText(first as never)).toBe("Billing\nIntro line here.");
    expect(embedText(first as never, false)).toBe("Intro line here.");
  });

  it("keeps a block whose text alone fits but whose header pushes it over", () => {
    // Nine words of text under a two-word path: fits on text alone, not with the header.
    const page = "# Billing\n\n## Refunds\n\none two three four five six seven eight nine\n";
    for (const piece of chunk(page, 10)) {
      expect(words(embedText(piece))).toBeLessThanOrEqual(10);
    }
    expect(chunk(page, 10).length).toBeGreaterThan(1);
  });

  it("returns nothing for a document with no blocks", () => {
    expect(chunk("", 100)).toEqual([]);
  });
});
