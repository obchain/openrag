import type { CountTokens } from "./tokens.js";

const SENTENCES = new Intl.Segmenter("en", { granularity: "sentence" });

/**
 * A url the segmenter has cut into: it treats `?` as the end of a sentence, so
 * `…/details?id=abc` becomes two pieces. Measured on the practice corpus, this
 * one guard removes 27 of its 29 wrong cuts.
 *
 * `en` and `hi` segment the code-mixed questions identically, so the locale is
 * fixed rather than configurable.
 */
const OPEN_URL = /(https?:\/\/|www\.)\S*$/;

/**
 * Cut a long stretch of text into pieces that each fit the budget, preferring
 * sentence ends, and falling back to word ends only for a sentence that is
 * itself too long.
 */
export function split(text: string, maxTokens: number, count: CountTokens): string[] {
  const pieces: string[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.trim() !== "") pieces.push(buffer.trim());
    buffer = "";
  };

  for (const { segment } of SENTENCES.segment(text)) {
    if (buffer !== "" && count(buffer + segment) > maxTokens && !OPEN_URL.test(buffer)) flush();
    buffer += segment;
  }
  flush();

  return pieces.flatMap((piece) => (count(piece) > maxTokens ? splitWords(piece, maxTokens, count) : piece));
}

/** A sentence longer than the whole budget. Pack its words instead. */
function splitWords(sentence: string, maxTokens: number, count: CountTokens): string[] {
  const pieces: string[] = [];
  let buffer = "";

  for (const word of sentence.split(/(\s+)/)) {
    if (buffer.trim() !== "" && count(buffer + word) > maxTokens) {
      pieces.push(buffer.trim());
      buffer = "";
    }
    buffer += word;
  }
  if (buffer.trim() !== "") pieces.push(buffer.trim());

  // One word over the budget on its own: a long url, a base64 blob, a hash.
  return pieces.flatMap((piece) => (count(piece) > maxTokens ? splitHard(piece, maxTokens, count) : piece));
}

/** Last resort: cut by characters, shrinking until the count fits. */
function splitHard(piece: string, maxTokens: number, count: CountTokens): string[] {
  const pieces: string[] = [];
  let rest = piece;
  // One count of the whole run gives characters-per-token; re-counting the
  // remainder every round would tokenize a large blob over and over.
  const perToken = piece.length / Math.max(1, count(piece));

  while (rest !== "") {
    let take = Math.min(rest.length, Math.max(1, Math.floor(perToken * maxTokens)));
    while (take > 1 && count(rest.slice(0, take)) > maxTokens) take = Math.floor(take * 0.9);
    pieces.push(rest.slice(0, take));
    rest = rest.slice(take);
  }

  return pieces;
}
