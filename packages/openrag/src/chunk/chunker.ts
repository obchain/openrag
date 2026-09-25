import { sha256 } from "../hash.js";
import type { ParsedDocument } from "../parse/markdown.js";
import type { Chunk, SourceDocument } from "../types.js";
import { split } from "./split.js";
import { type CountTokens, estimateTokens } from "./tokens.js";

/** Measured on the practice corpus: 128 and 512 both scored worse (RESULTS.md, section 1). */
export const DEFAULT_MAX_TOKENS = 256;

export interface ChunkOptions {
  maxTokens?: number;
  /**
   * Prepend `page › heading` to the text that gets embedded. Measured: dropping
   * it cost 7 points of hit@5, and code-mixed questions fell from 100% to 83%.
   */
  header?: boolean;
  /** The embedder's own tokenizer. Without one, pieces are only estimated. */
  countTokens?: CountTokens;
}

/** What the embedder reads: the piece, under the path that leads to it. */
export function embedText(chunk: Pick<Chunk, "title" | "headingPath" | "text">, header = true): string {
  return header ? `${[chunk.title, ...chunk.headingPath].join(" › ")}\n${chunk.text}` : chunk.text;
}

/**
 * Pack a parsed document into retrievable pieces.
 *
 * Breaks at the document's own headings first, then packs neighbouring blocks
 * under the same heading until the budget is spent. A block too large on its own
 * is split on sentence boundaries before packing.
 */
export function chunkDocument(
  document: SourceDocument,
  parsed: ParsedDocument,
  options: ChunkOptions = {},
): Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const header = options.header ?? true;
  const count = options.countTokens ?? estimateTokens;
  const title = parsed.title ?? document.title;
  /** What a piece may hold once its header has taken its share of the budget. */
  const budgetFor = (headingPath: string[]) =>
    Math.max(1, maxTokens - count(embedText({ title, headingPath, text: "" }, header)));

  const chunks: Chunk[] = [];
  let pending: Piece[] = [];

  /** The budget covers what the embedder actually reads, header included. */
  const fits = (pieces: Piece[]) =>
    count(embedText({ title, headingPath: pieces[0]?.headingPath ?? [], text: join(pieces) }, header)) <=
    maxTokens;

  const flush = () => {
    if (pending.length === 0) return;
    const first = pending[0] as Piece;
    const last = pending[pending.length - 1] as Piece;
    const text = join(pending);
    chunks.push({
      id: `${document.id}-${chunks.length}`,
      docId: document.id,
      namespace: document.namespace,
      uri: document.uri,
      title,
      headingPath: first.headingPath,
      text,
      charStart: first.charStart,
      charEnd: last.charEnd,
      tokens: count(embedText({ title, headingPath: first.headingPath, text }, header)),
      hash: sha256(text),
    });
    pending = [];
  };

  for (const piece of pieces(parsed, budgetFor, count)) {
    const sameSection = pending[0]?.headingPath.join("\u0000") === piece.headingPath.join("\u0000");
    if (pending.length > 0 && (!sameSection || !fits([...pending, piece]))) flush();
    pending.push(piece);
  }
  flush();

  return chunks;
}

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
      if (at === -1) continue;
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

/**
 * Blocks are joined as the document had them, one blank line apart. A chunk's
 * span therefore covers its blocks, and anything dropped as noise in between is
 * absent from the text while still lying inside the span.
 */
const join = (pieces: readonly Piece[]) => pieces.map((piece) => piece.text).join("\n\n");
