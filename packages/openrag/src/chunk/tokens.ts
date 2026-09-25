/**
 * How a piece is measured against the budget.
 *
 * The only count that means anything is the one the embedder itself makes,
 * because the budget exists so a piece fits that model. The embedder ships its
 * own tokenizer, so indexing passes that in; this type is how it arrives.
 */
export type CountTokens = (text: string) => number;

/**
 * The fallback when nothing better is available, for a chunker used on its own.
 *
 * Measured against the real tokenizer over 1102 chunks of the practice corpus:
 * the median is 1.16× and p95 1.35×, but the tail reaches 2.47×. Close enough to
 * keep a run going, not close enough to be trusted as a budget.
 */
export const estimateTokens: CountTokens = (text) => Math.ceil(text.length / 4);
