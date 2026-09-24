import { describe, expect, it } from "vitest";
import { FUSION_WEIGHTS, fuse } from "../src/fusion.js";
import type { Chunk, SearchHit } from "../src/types.js";

const chunk = (id: string): Chunk => ({
  id,
  docId: "doc",
  namespace: "test",
  uri: "docs/test.md",
  title: "Test",
  headingPath: [],
  text: id,
  charStart: 0,
  charEnd: 1,
  tokens: 1,
  hash: id,
});

const list = (...ids: string[]): SearchHit[] => ids.map((id, i) => ({ chunk: chunk(id), score: 1 - i / 10 }));

describe("fuse", () => {
  it("ranks a chunk that both searches found above one only a single search found", () => {
    const fused = fuse({ lexical: list("a", "b"), vector: list("b", "c") });
    expect(fused[0]?.chunk.id).toBe("b");
  });

  it("ties when each search puts a different chunk first at equal weight", () => {
    const fused = fuse({ lexical: list("noise", "answer"), vector: list("answer", "noise") });
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? 0, 12);
  });

  it("breaks that tie for the vector list once keyword weight drops", () => {
    const fused = fuse(
      { lexical: list("noise", "answer"), vector: list("answer", "noise") },
      { weights: FUSION_WEIGHTS.withoutReranker },
    );
    expect(fused[0]?.chunk.id).toBe("answer");
  });

  it("keeps every chunk once and honours topK", () => {
    const fused = fuse({ lexical: list("a", "b", "c"), vector: list("c", "a") }, { topK: 2 });
    expect(fused).toHaveLength(2);
    expect(new Set(fused.map((h) => h.chunk.id)).size).toBe(2);
  });

  it("handles an empty list from one search", () => {
    const fused = fuse({ lexical: [], vector: list("a", "b") });
    expect(fused.map((h) => h.chunk.id)).toEqual(["a", "b"]);
  });
});
