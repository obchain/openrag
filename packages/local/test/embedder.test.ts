import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, type EmbeddingBackend, LocalEmbedder } from "../src/embedder.js";

/** A model that records what it was asked, so batching and prefixes are visible. */
function fake(width = 3): EmbeddingBackend & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    countTokens: (text) => text.split(/\s+/).filter(Boolean).length,
    run: async (texts) => {
      calls.push(texts);
      // Deterministic and different per text, so a mix-up is visible.
      return texts.map((text) => Array.from({ length: width }, (_, i) => text.length + i));
    },
  };
}

/** The probe `load()` makes to find the width is not part of what a test asked for. */
const asked = (backend: { calls: string[][] }) => backend.calls.slice(1);

describe("LocalEmbedder", () => {
  it("asks the model how wide its vectors are instead of assuming", async () => {
    const embedder = await LocalEmbedder.load({ backend: fake(7) });
    expect(embedder.dimensions).toBe(7);
    expect(embedder.id).toBe(DEFAULT_MODEL);
  });

  it("carries the model's own tokenizer, which the chunk budget needs", async () => {
    const backend = fake();
    const embedder = await LocalEmbedder.load({ backend });
    expect(embedder.countTokens("one two three")).toBe(3);
  });

  it("embeds in batches of the size it was given", async () => {
    const backend = fake();
    const embedder = await LocalEmbedder.load({ backend, batchSize: 2 });
    const vectors = await embedder.embedDocuments(["a", "bb", "ccc", "dddd", "eeeee"]);

    expect(asked(backend).map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(vectors).toHaveLength(5);
    expect(vectors[0]).not.toEqual(vectors[1]);
  });

  it("pays for a repeated text once and still answers for every one", async () => {
    // Docs sites repeat boilerplate across pages; the caller should not have to
    // notice, and the duplicates must still come back in their own positions.
    const backend = fake();
    const embedder = await LocalEmbedder.load({ backend, batchSize: 10 });
    const vectors = await embedder.embedDocuments(["same", "other", "same"]);

    expect(asked(backend)).toEqual([["same", "other"]]);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(vectors[2]);
    expect(vectors[0]).not.toEqual(vectors[1]);
  });

  it("reports progress up to the number of texts it actually embeds", async () => {
    const seen: { done: number; total: number }[] = [];
    const embedder = await LocalEmbedder.load({
      backend: fake(),
      batchSize: 2,
      onProgress: (progress) => {
        if (progress.phase === "embed") seen.push({ done: progress.done, total: progress.total });
      },
    });
    await embedder.embedDocuments(["a", "b", "c", "d", "e"]);

    expect(seen).toEqual([
      { done: 2, total: 5 },
      { done: 4, total: 5 },
      { done: 5, total: 5 },
    ]);
  });

  it("puts the search instruction on a question and not on a passage", async () => {
    // bge was trained with a prefix on queries only. Embedding a passage with it
    // still returns a vector, just a worse one, so nothing would complain.
    const backend = fake();
    const embedder = await LocalEmbedder.load({ backend });
    await embedder.embedDocuments(["a refund takes five days"]);
    await embedder.embedQuery("how long do refunds take");

    expect(asked(backend)[0]).toEqual(["a refund takes five days"]);
    expect(asked(backend)[1]).toEqual([
      "Represent this sentence for searching relevant passages: how long do refunds take",
    ]);
  });

  it("uses the prefixes the chosen model was trained with", async () => {
    const backend = fake();
    const embedder = await LocalEmbedder.load({ backend, model: "Xenova/multilingual-e5-small" });
    await embedder.embedDocuments(["a refund takes five days"]);
    await embedder.embedQuery("kitne din");

    expect(asked(backend)[0]).toEqual(["passage: a refund takes five days"]);
    expect(asked(backend)[1]).toEqual(["query: kitne din"]);
  });

  it("leaves an unknown model's text alone rather than guessing a prefix", async () => {
    const backend = fake();
    const embedder = await LocalEmbedder.load({ backend, model: "some/other-model" });
    await embedder.embedQuery("plain");
    expect(asked(backend)[0]).toEqual(["plain"]);
  });

  it("refuses a model that returns the wrong number of vectors", async () => {
    const backend = fake();
    const embedder = await LocalEmbedder.load({ backend, batchSize: 10 });
    backend.run = async () => [[1, 2, 3]];
    await expect(embedder.embedDocuments(["a", "b"])).rejects.toThrow(/returned 1 vectors for 2 texts/);
  });

  it("refuses a model that returns nothing at all", async () => {
    await expect(
      LocalEmbedder.load({ backend: { countTokens: () => 0, run: async () => [] } }),
    ).rejects.toThrow(/returned no vector/);
  });
});

describe("LocalEmbedder, with the real model", () => {
  it("says what to do when a model cannot be fetched", async () => {
    await expect(LocalEmbedder.load({ model: "openrag/definitely-not-a-model" })).rejects.toThrow(
      /could not load the model .*downloaded on first use/s,
    );
  }, 60_000);

  it("embeds text into unit vectors that put like with like", async () => {
    const embedder = await LocalEmbedder.load();
    expect(embedder.dimensions).toBe(384);
    // The budget the chunker spends has to be this model's own count (D-020).
    expect(embedder.countTokens("a refund takes five working days")).toBeGreaterThan(0);

    const [refund, shipping] = await embedder.embedDocuments([
      "A refund takes five working days.",
      "Shipping is free above 500.",
    ]);
    const question = await embedder.embedQuery("how long until I get my money back?");

    for (const vector of [refund, shipping, question]) {
      expect(vector).toHaveLength(384);
      expect(Math.hypot(...(vector as number[]))).toBeCloseTo(1, 3);
    }
    // Not a claim about absolute scores, only that the right one is nearer.
    expect(cosine(question, refund as number[])).toBeGreaterThan(cosine(question, shipping as number[]));
  }, 120_000);
});

const cosine = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * (b[i] as number), 0);
