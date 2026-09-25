import { sha256 } from "../hash.js";
import type { ParsedDocument } from "../parse/markdown.js";
import type { Chunk, SourceDocument } from "../types.js";
import { split } from "./split.js";
import type { CountTokens } from "./tokens.js";

/** Measured on the practice corpus: 128 and 512 both scored worse (RESULTS.md, section 1). */
export const DEFAULT_MAX_TOKENS = 256;

export interface ChunkOptions {
  /**
   * How a piece is measured. Required, and required to be the same counter the
   * embedder uses, because a budget counted with another ruler is a guess.
   * `estimateTokens` is available for a run where no tokenizer is at hand, but
   * it has to be asked for by name.
   */
  countTokens: CountTokens;
  maxTokens?: number;
  /**
   * Prepend `page › heading` to the text that gets embedded. Measured: dropping
   * it cost 7 points of hit@5, and code-mixed questions fell from 100% to 83%.
   *
   * Whatever is chosen here has to be passed to `embedText` as well, or the
   * pieces are packed to one budget and embedded against another.
   */
  header?: boolean;
}

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
  const title = parsed.title ?? document.title;
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
      budget = maxTokens - count(embedText({ title, headingPath, text: "" }, header));
      if (budget < 1) {
        throw new Error(
          `chunk: the header "${[title, ...headingPath].join(" › ")}" needs more than the whole ` +
            `${maxTokens} token budget. Raise maxTokens or chunk with header: false.`,
        );
      }
      budgets.set(key, budget);
    }
    return budget;
  };

  const chunks: Chunk[] = [];
  let pending: Piece[] = [];
  let pendingText = "";

  /** The budget covers what the embedder actually reads, header included. */
  const fits = (headingPath: string[], text: string) =>
    count(embedText({ title, headingPath, text }, header)) <= maxTokens;

  const seen = new Map<string, number>();

  const flush = () => {
    if (pending.length === 0) return;
    const first = pending[0] as Piece;
    const last = pending[pending.length - 1] as Piece;
    const headingPath = [...first.headingPath]; // never share one array between chunks
    const text = pendingText;
    const embedded = embedText({ title, headingPath, text }, header);

    // The fingerprint covers everything the embedder reads, so two chunks that
    // share a paragraph under different headings stay distinct.
    const hash = sha256(embedded);
    // Derived from content, not from position: inserting a paragraph higher up
    // must not renumber every chunk below it and force a full re-embed.
    const repeat = seen.get(hash) ?? 0;
    seen.set(hash, repeat + 1);

    chunks.push({
      id: `${document.id}-${hash.slice(0, 12)}${repeat === 0 ? "" : `-${repeat}`}`,
      docId: document.id,
      namespace: document.namespace,
      uri: document.uri,
      title,
      headingPath,
      text,
      charStart: first.charStart,
      charEnd: last.charEnd,
      tokens: count(embedded),
      hash,
    });
    pending = [];
    pendingText = "";
  };

  for (const piece of pieces(parsed, budgetFor, count)) {
    const sameSection = pending[0]?.headingPath.join("\u0000") === piece.headingPath.join("\u0000");
    const merged = pendingText === "" ? piece.text : `${pendingText}\n\n${piece.text}`;
    if (pending.length > 0 && (!sameSection || !fits(piece.headingPath, merged))) flush();
    pending.push(piece);
    pendingText = pendingText === "" ? piece.text : `${pendingText}\n\n${piece.text}`;
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
