import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store/memory.js";
import { conformance } from "./store-conformance.js";

conformance("MemoryStore", () => new MemoryStore());

/**
 * What is true of this store in particular, and is not asked of every store.
 */
describe("MemoryStore keyword search", () => {
  const indexed = async (text: string) => {
    const store = new MemoryStore();
    await store.apply("acme", {
      upsert: [
        {
          chunk: {
            id: "a",
            docId: "doc-1",
            namespace: "acme",
            uri: "doc-1.md",
            title: "Handbook",
            headingPath: [],
            text,
            charStart: 0,
            charEnd: text.length,
            tokens: 1,
            hash: "a",
          },
          vector: [1, 0],
        },
      ],
      restate: [],
      removeChunks: [],
      removeDocuments: [],
      documents: [{ docId: "doc-1", contentHash: "h" }],
    });
    return store;
  };

  it("matches whole words only: it does not stem", async () => {
    // The SQLite store does stem, through FTS5's porter tokenizer, so this is a
    // real difference between the two and the reason stemming is not contract.
    const store = await indexed("a refund takes five days");
    expect(await store.lexicalSearch("acme", "refund", 10)).toHaveLength(1);
    expect(await store.lexicalSearch("acme", "refunds", 10)).toEqual([]);
  });

  it("keeps no stop-word list, so a common word still matches", async () => {
    const store = await indexed("the refund window");
    expect(await store.lexicalSearch("acme", "the", 10)).toHaveLength(1);
  });

  it("matches across scripts and digits", async () => {
    const store = await indexed("रिफंड 30 दिन में");
    expect(await store.lexicalSearch("acme", "रिफंड", 10)).toHaveLength(1);
    expect(await store.lexicalSearch("acme", "30", 10)).toHaveLength(1);
  });
});
