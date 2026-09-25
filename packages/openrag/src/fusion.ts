import type { SearchHit } from "./types.js";

/**
 * Reciprocal-rank fusion of ranked lists.
 *
 * Each list contributes `weight / (k + rank)` per hit, so only positions matter,
 * not the two searches' very different score scales.
 *
 * Weights are not cosmetic. Measured on the M0 practice corpus, fusing keyword and
 * vector lists at equal weight *hurt* reworded questions (87% -> 67% hit@5) because
 * keyword noise ties with the right answer. A reranker repairs it, so the defaults
 * are: reranker on -> equal weight, reranker off -> lean on vector (D-017).
 */
export const FUSION_WEIGHTS = {
  withReranker: { lexical: 1, vector: 1 },
  withoutReranker: { lexical: 0.2, vector: 1 },
} as const;

export interface FuseInput {
  lexical: SearchHit[];
  vector: SearchHit[];
}

export interface FuseOptions {
  weights?: { lexical: number; vector: number };
  /** Rank smoothing constant. 60 is the value the original RRF paper uses. */
  k?: number;
  topK?: number;
}

export function fuse(input: FuseInput, options: FuseOptions = {}): SearchHit[] {
  const { weights = FUSION_WEIGHTS.withReranker, k = 60, topK = 20 } = options;
  const scores = new Map<string, number>();
  const hits = new Map<string, SearchHit>();

  const add = (list: SearchHit[], weight: number) => {
    list.forEach((hit, index) => {
      const id = hit.chunk.id;
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + index + 1));
      if (!hits.has(id)) hits.set(id, hit);
    });
  };
  add(input.lexical, weights.lexical);
  add(input.vector, weights.vector);

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => {
      const hit = hits.get(id);
      if (!hit) throw new Error(`fuse: missing hit for chunk ${id}`);
      return { chunk: hit.chunk, score };
    });
}
