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

  it("gives a repeated text its own array, not a shared one", async () => {
    // An earlier version embedded each distinct text once and handed the same
    // array back for every copy. On the practice corpus that saved nothing —
    // every chunk carries its own `page > heading` header, so 1215 chunks were
    // 1215 distinct texts — and it meant a caller scaling one vector in place
    // silently rewrote the others.
    const backend = fake();
    const embedder = await LocalEmbedder.load({ backend, batchSize: 10 });
    const vectors = await embedder.embedDocuments(["same", "other", "same"]);

    expect(asked(backend)).toEqual([["same", "other", "same"]]);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(vectors[2]);
    expect(vectors[0]).not.toBe(vectors[2]);
    expect(vectors[0]).not.toEqual(vectors[1]);
  });

  it("counts a document with the prefix the model will actually be fed", async () => {
    // The budget the chunker spends is this count. If the prefix is added after
    // the text was measured, a full-budget chunk loses its tail in the model's
    // window, silently.
    const plain = await LocalEmbedder.load({ backend: fake() });
    const prefixed = await LocalEmbedder.load({ backend: fake(), model: "Xenova/multilingual-e5-small" });
    expect(plain.countTokens("one two three")).toBe(3);
    expect(prefixed.countTokens("one two three")).toBe(4); // "passage: one two three"
  });

  it("calls the backend's counter rather than copying it off", async () => {
    // A backend written as a class is the natural shape, and a copied method
    // loses its receiver: it either throws or returns undefined, and undefined
    // compares under every budget the chunker tries.
    class Counting {
      readonly #scale = 2;
      countTokens(text: string): number {
        return text.split(/\s+/).filter(Boolean).length * this.#scale;
      }
      async run(texts: string[]): Promise<number[][]> {
        return texts.map(() => [1, 2, 3]);
      }
    }
    const embedder = await LocalEmbedder.load({ backend: new Counting() });
    expect(embedder.countTokens("one two three")).toBe(6);
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

  it.each([
    ["nothing at all", [] as number[][]],
    ["a vector of no width", [[]] as number[][]],
  ])("refuses a model that returns %s", async (_case, result) => {
    // A width of 0 is not caught here but far downstream, when the store
    // refuses the write, by which point the cause is out of sight.
    await expect(
      LocalEmbedder.load({ backend: { countTokens: () => 0, run: async () => result } }),
    ).rejects.toThrow(/returned no vector/);
  });

  it("refuses a query the model answered with no vector", async () => {
    const backend = fake();
    const embedder = await LocalEmbedder.load({ backend });
    backend.run = async () => [];
    await expect(embedder.embedQuery("anything")).rejects.toThrow(/no vector for the query/);
  });

  it("batches in the measured size when it is not told one", async () => {
    // 16 is what the timings in the class doc were taken at; every other test
    // passes a size, so nothing else holds the default.
    const backend = fake();
    const embedder = await LocalEmbedder.load({ backend });
    await embedder.embedDocuments(Array.from({ length: 17 }, (_, i) => `text ${i}`));
    expect(asked(backend).map((batch) => batch.length)).toEqual([16, 1]);
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
    // The budget the chunker spends has to be this model's own count (D-020),
    // not a stand-in. A characters-for-tokens swap passes `> 0` and leaves 140
    // of 1102 chunks over the budget they claim to fit, which is the measurement
    // that put `countTokens` on the interface in the first place.
    const sentence = "a refund takes five working days";
    expect(embedder.countTokens(sentence)).toBe(9); // 7 words + the model's two markers
    expect(embedder.countTokens(sentence)).toBeLessThan(sentence.length / 2);

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
