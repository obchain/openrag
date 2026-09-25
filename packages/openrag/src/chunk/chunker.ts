import { sha256 } from "../hash.js";
import type { Chunk, ChunkOptions, ParsedDocument, SourceDocument } from "../types.js";
import { split } from "./split.js";
import type { CountTokens } from "./tokens.js";

/** Measured on the practice corpus: 128 and 512 both scored worse (RESULTS.md, section 1). */
export const DEFAULT_MAX_TOKENS = 256;

/** What the embedder reads: the piece, under the path that leads to it. */
export function embedText(chunk: Pick<Chunk, "title" | "headingPath" | "text">, header: boolean): string {
  return header ? `${[chunk.title, ...chunk.headingPath].join(" › ")}\n${chunk.text}` : chunk.text;
}

/**
 * Pack a parsed document into retrievable pieces.
 *
 * Breaks at the document's own headings first, then packs neighbouring blocks
 * under the same heading until the budget is spent. A block too large on its own
 * is split on sentence boundaries before packing.
 *
 * `charStart` and `charEnd` index `parsed.text`, which for Markdown is the file
 * itself and for HTML is the text the page was converted to. Whatever is indexed
 * has to store that same text for a citation to resolve.
 */
export function chunkDocument(
  document: SourceDocument,
  parsed: ParsedDocument,
  options: ChunkOptions,
): Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const header = options.header ?? true;
  const count = options.countTokens;
  // A parser returns "" for a heading that holds only an image, and `??` would
  // keep it, embedding every chunk under a header that starts with a separator.
  const title = named(parsed.title) ?? named(document.title) ?? "";

  /** What the embedder reads for a piece, and what the budget is spent on. */
  const countFor = (headingPath: string[], text: string) =>
    count(embedText({ title, headingPath, text }, header));

  /**
   * What a piece may hold once its header has taken its share of the budget.
   * Memoised: the header is the same for every block of a section, and counting
   * it with a real tokenizer is the expensive part of chunking.
   */
  const budgets = new Map<string, number>();
  const budgetFor = (headingPath: string[]) => {
    const key = headingPath.join("\u0000");
    let budget = budgets.get(key);
    if (budget === undefined) {
      budget = maxTokens - countFor(headingPath, "");
      if (budget < 1) {
        throw new Error(
          `chunk: in ${document.uri}, the header "${[title, ...headingPath].join(" › ")}" needs more ` +
            `than the whole ${maxTokens} token budget. Raise maxTokens or chunk with header: false.`,
        );
      }
      budgets.set(key, budget);
    }
    return budget;
  };

  const chunks: Chunk[] = [];
  const seen = new Set<string>();
  let pending: Piece[] = [];
  let pendingText = "";
  let pendingTokens = 0;

  const flush = () => {
    if (pending.length === 0) return;
    const first = pending[0] as Piece;
    const last = pending[pending.length - 1] as Piece;
    const headingPath = [...first.headingPath]; // never share one array between chunks

    // The fingerprint covers everything the embedder reads, so two chunks that
    // share a paragraph under different headings stay distinct.
    const embedded = embedText({ title, headingPath, text: pendingText }, header);
    const hash = sha256(embedded);

    // A document that repeats a line verbatim under the same heading has nothing
    // to add the second time: the same text would compete with itself for a slot,
    // and numbering the copies would make ids depend on position again.
    if (!seen.has(hash)) {
      seen.add(hash);
      chunks.push({
        id: `${document.id}-${hash.slice(0, 12)}`,
        docId: document.id,
        namespace: document.namespace,
        uri: document.uri,
        title,
        headingPath,
        text: pendingText,
        charStart: first.charStart,
        charEnd: last.charEnd,
        tokens: count(embedded),
        hash,
      });
    }

    pending = [];
    pendingText = "";
    pendingTokens = 0;
  };

  const start = (piece: Piece, tokens: number) => {
    pending = [piece];
    pendingText = piece.text;
    pendingTokens = tokens;
  };

  for (const piece of pieces(parsed, budgetFor, count)) {
    if (pending.length === 0) {
      start(piece, count(piece.text));
      continue;
    }
    const sameSection = (pending[0] as Piece).headingPath.join("\u0000") === piece.headingPath.join("\u0000");
    if (!sameSection) {
      flush();
      start(piece, count(piece.text));
      continue;
    }

    /**
     * Counting the whole packed text again for every block tokenizes a document
     * many times over. Adding the counts instead can only overstate the total —
     * joining two pieces may merge tokens at the seam but never splits one, and
     * a tokenizer that adds its own markers adds them once per call rather than
     * once per chunk. So while the sum still fits, the real count certainly
     * does, and only a sum that overflows is worth an exact recount.
     */
    // Counted with the blank line that joins it on, or the separators add up
    // into a chunk a token or two over budget.
    const sum = pendingTokens + count(`\n\n${piece.text}`);
    if (sum <= budgetFor(piece.headingPath)) {
      pending.push(piece);
      pendingText = `${pendingText}\n\n${piece.text}`;
      pendingTokens = sum;
      continue;
    }

    const merged = `${pendingText}\n\n${piece.text}`;
    const mergedTokens = count(merged);
    if (mergedTokens <= budgetFor(piece.headingPath)) {
      pending.push(piece);
      pendingText = merged;
      pendingTokens = mergedTokens;
    } else {
      flush();
      start(piece, count(piece.text));
    }
  }
  flush();

  return chunks;
}

/**
 * Blocks are packed one blank line apart, as the document had them. A chunk's
 * span therefore covers its blocks, and anything dropped as noise in between is
 * absent from the text while still lying inside the span.
 */
interface Piece {
  headingPath: string[];
  text: string;
  charStart: number;
  charEnd: number;
}

/** Blocks, with any oversized one already cut down to size. */
function* pieces(
  parsed: ParsedDocument,
  budgetFor: (headingPath: string[]) => number,
  count: CountTokens,
): Generator<Piece> {
  for (const block of parsed.blocks) {
    const budget = budgetFor(block.headingPath);
    if (count(block.text) <= budget) {
      yield block;
      continue;
    }
    // Locate each part in the block it came from, so offsets stay true.
    let cursor = 0;
    for (const part of split(block.text, budget, count)) {
      const at = block.text.indexOf(part, cursor);
      if (at === -1) {
        // Splitting only ever cuts, so a part must be findable. Dropping it here
        // would lose text from the index without a word.
        throw new Error(
          `chunk: split produced text that is not in its block: ${JSON.stringify(part.slice(0, 40))}`,
        );
      }
      cursor = at + part.length;
      yield {
        headingPath: block.headingPath,
        text: part,
        charStart: block.charStart + at,
        charEnd: block.charStart + at + part.length,
      };
    }
  }
}

/** A title that is only whitespace is no title at all. */
const named = (value: string | undefined) => (value?.trim() ? value : undefined);
