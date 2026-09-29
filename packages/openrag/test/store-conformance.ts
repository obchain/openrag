import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/hash.js";
import { MAX_TOP_K } from "../src/store/shared.js";
import { planUpdate } from "../src/sync/plan.js";
import type { Chunk, SourceDocument, Store, StoreWrite } from "../src/types.js";

/**
 * What every store has to do, whatever it is built on.
 *
 * Run against each implementation, so a backend is checked against the contract
 * rather than against tests written to fit it. A store that passes can be swapped
 * in without reading its source.
 *
 * Deliberately **not** in here, because they are properties of a backend rather
 * than of the contract:
 *
 * - **Stemming and stop words.** SQLite's FTS5 finds "refund" from "refunds";
 *   the in-memory store matches whole words only. Both are honest keyword
 *   search, and asserting either way would force the other to fake it.
 * - **Score scales.** Cosine is comparable across stores, BM25 is not. Only the
 *   order and the "higher is better" direction are contract.
 * - **Recall of an approximate index.** Nothing here is large enough to make a
 *   store fall back on approximation, and exact recall is not promised.
 * - **The order of equally-scoring hits.** A tie is a tie; which one comes first
 *   is whatever the backend's own sort does.
 * - **The order of a `Snapshot`'s entries.** They are maps to look things up in,
 *   and nothing in `planUpdate` reads them in order.
 * - **How rare a word is reckoned to be.** The SQLite store gets that from FTS5,
 *   which counts over the whole file rather than one namespace, so another
 *   tenant's documents shift its scores. Measured on the practice corpus with a
 *   second tenant holding an identical copy of it, **not one of 42 questions
 *   changed rank**, so this is a difference in the numbers and not in the
 *   answers. Which rows come back is filtered by namespace either way.
 */
export function conformance(name: string, create: () => Store | Promise<Store>): void {
  const open: Store[] = [];
  const fresh = async () => {
    const store = await create();
    open.push(store);
    return store;
  };
  afterEach(async () => {
    // A backend holding a file or a connection gets to let go of it.
    for (const store of open.splice(0)) {
      const close = (store as { close?: () => unknown }).close;
      if (typeof close === "function") await close.call(store);
    }
  });

  describe(`${name}: snapshot`, () => {
    it("reports nothing for a namespace that was never written", async () => {
      const store = await fresh();
      const snapshot = await store.snapshot("acme");
      expect(snapshot.documents.size).toBe(0);
      expect(snapshot.chunks.size).toBe(0);
    });

    it("groups chunks under their document", async () => {
      const store = await fresh();
      await store.apply(
        "acme",
        write({
          upsert: [
            { chunk: chunk("a", { docId: "doc-1" }), vector: [1, 0] },
            { chunk: chunk("b", { docId: "doc-1" }), vector: [0, 1] },
            { chunk: chunk("c", { docId: "doc-2" }), vector: [1, 1] },
          ],
          documents: [
            { docId: "doc-1", contentHash: "h1" },
            { docId: "doc-2", contentHash: "h2" },
          ],
        }),
      );

      const snapshot = await store.snapshot("acme");
      expect(snapshot.documents.get("doc-1")).toBe("h1");
      expect([...(snapshot.chunks.get("doc-1") ?? [])].sort()).toEqual(["a", "b"]);
      expect(snapshot.chunks.get("doc-2")).toEqual(["c"]);
    });

    it("keeps an entry for a document that produced no chunks", async () => {
      // planUpdate re-chunks a document it has no chunk record for, so an empty
      // page has to come back as an empty list rather than as nothing at all.
      const store = await fresh();
      await store.apply("acme", write({ documents: [{ docId: "empty", contentHash: "h" }] }));

      const snapshot = await store.snapshot("acme");
      expect(snapshot.chunks.has("empty")).toBe(true);
      expect(snapshot.chunks.get("empty")).toEqual([]);
    });
  });

  describe(`${name}: namespaces`, () => {
    it("never returns another tenant's chunk", async () => {
      const store = await fresh();
      await store.apply("acme", one("secret", [1, 0], { text: "quarterly revenue" }));

      expect(await store.vectorSearch("other", [1, 0], 10)).toEqual([]);
      expect(await store.lexicalSearch("other", "quarterly revenue", 10)).toEqual([]);
      expect((await store.snapshot("other")).chunks.size).toBe(0);
    });

    it("keeps two tenants' identical documents apart", async () => {
      // Same uri, same text, same document id: only the namespace separates them.
      const store = await fresh();
      for (const namespace of ["acme", "other"]) {
        await store.apply(
          namespace,
          write({
            upsert: [{ chunk: chunk("shared", { namespace, text: "refund window" }), vector: [1, 0] }],
            documents: [{ docId: "doc-1", contentHash: "h" }],
          }),
        );
      }
      await store.apply("acme", write({ removeDocuments: ["doc-1"] }));

      expect(await store.lexicalSearch("acme", "refund", 10)).toEqual([]);
      expect(await store.lexicalSearch("other", "refund", 10)).toHaveLength(1);
    });

    it("refuses a chunk whose own namespace disagrees with the call", async () => {
      const store = await fresh();
      await expect(
        store.apply(
          "acme",
          write({ upsert: [{ chunk: chunk("a", { namespace: "other" }), vector: [1, 0] }] }),
        ),
      ).rejects.toThrow(/namespace/);
    });
  });

  describe(`${name}: write validation`, () => {
    it("refuses two vector widths in one write", async () => {
      const store = await fresh();
      await expect(
        store.apply(
          "acme",
          write({
            upsert: [
              { chunk: chunk("a"), vector: [1, 0] },
              { chunk: chunk("b"), vector: [1, 0, 0] },
            ],
          }),
        ),
      ).rejects.toThrow(/dimension/i);
    });

    it("refuses a width the namespace does not already use", async () => {
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0]));
      await expect(store.apply("acme", one("b", [1, 0, 0]))).rejects.toThrow(/dimension/i);
    });

    it("refuses a different width in another namespace", async () => {
      // One index, one embedder. A single vector table cannot hold two widths,
      // and scores from two embedders would not be comparable if it could.
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0]));
      await expect(
        store.apply(
          "other",
          write({
            upsert: [{ chunk: chunk("b", { namespace: "other" }), vector: [1, 0, 0] }],
            documents: [{ docId: "doc-1", contentHash: "h" }],
          }),
        ),
      ).rejects.toThrow(/dimension/i);
    });

    it("accepts a new width once the old chunks are going", async () => {
      // Changing embedder is legitimate; it just means re-indexing the namespace.
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0]));
      await store.apply(
        "acme",
        write({
          removeDocuments: ["doc-1"],
          upsert: [{ chunk: chunk("b", { docId: "doc-2" }), vector: [1, 0, 0] }],
          documents: [{ docId: "doc-2", contentHash: "h" }],
        }),
      );
      expect(await store.vectorSearch("acme", [1, 0, 0], 10)).toHaveLength(1);
    });

    it.each([
      ["an all-zero vector", [0, 0], /all-zero/],
      ["a non-finite value", [1, Number.NaN], /non-finite/],
      ["an empty vector", [], /empty vector/],
    ])("refuses %s", async (_case, vector, message) => {
      // Each names its own message. A bare `toThrow()` is satisfied by whichever
      // guard fires first, which lets a dead one sit there looking covered:
      // `[].some(v => v !== 0)` is false, so the all-zero check would answer for
      // the empty case too.
      const store = await fresh();
      await expect(store.apply("acme", one("a", vector))).rejects.toThrow(message);
    });

    it.each([
      ["a chunk id", { id: "a\u0000b" }],
      ["a docId", { docId: "doc\u00001" }],
      ["a uri", { uri: "docs/a\u0000.md" }],
      ["the text", { text: "before\u0000after" }],
      ["the title", { title: "Hand\u0000book" }],
      ["the hash", { hash: "ab\u0000cd" }],
    ])("refuses a null byte in %s", async (_case, overrides) => {
      // SQLite hands its text to C, which stops at the first null: a 12
      // character field comes back 6 characters long with nothing said. In an
      // id that is permanent — `snapshot()` then reports something the source
      // can never match, so the document re-embeds on every run, for ever.
      const store = await fresh();
      await expect(store.apply("acme", one("a", [1, 0], overrides))).rejects.toThrow(/null byte/);
    });

    it("refuses a null byte in a document fingerprint", async () => {
      const store = await fresh();
      await expect(
        store.apply("acme", write({ documents: [{ docId: "doc-1", contentHash: "h\u0000x" }] })),
      ).rejects.toThrow(/null byte/);
    });

    it("replaces a chunk id it already holds rather than doubling it", async () => {
      // Every id in the suite comes from content, so an edit always makes a new
      // one and this path is never walked by accident.
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0], { text: "first version" }));
      await store.apply("acme", one("a", [0, 1], { text: "second version" }));

      expect((await store.snapshot("acme")).chunks.get("doc-1")).toEqual(["a"]);
      expect(await store.lexicalSearch("acme", "first", 10)).toEqual([]);
      const hits = await store.vectorSearch("acme", [0, 1], 10);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.chunk.text).toBe("second version");
    });

    it("accepts a write that only deletes, against an index holding no vectors", async () => {
      // `planUpdate` emits exactly this when a run finds only deletions, and a
      // store given no vector yet may have no vector table to delete from.
      const store = await fresh();
      await expect(
        store.apply("acme", write({ removeChunks: ["nothing"], removeDocuments: ["gone"] })),
      ).resolves.toBeUndefined();
    });

    it("refuses a new width even when this write empties the other tenant", async () => {
      // Two tenants sharing a docId, and a write to one that removes it: the
      // chunks it clears belong to this namespace only, so the other tenant's
      // vectors still stand and still decide the width.
      const store = await fresh();
      for (const namespace of ["acme", "other"]) {
        await store.apply(
          namespace,
          write({
            upsert: [{ chunk: chunk("shared", { namespace }), vector: [1, 0] }],
            documents: [{ docId: "doc-1", contentHash: "h" }],
          }),
        );
      }
      await expect(
        store.apply(
          "acme",
          write({
            removeDocuments: ["doc-1"],
            upsert: [{ chunk: chunk("new", { docId: "doc-2" }), vector: [1, 0, 0] }],
            documents: [{ docId: "doc-2", contentHash: "h" }],
          }),
        ),
      ).rejects.toThrow(/dimension/i);
    });

    it("leaves the index untouched when a write is refused", async () => {
      const store = await fresh();
      await store.apply("acme", one("good", [1, 0], { text: "kept" }));

      await expect(
        store.apply(
          "acme",
          write({
            removeChunks: ["good"],
            removeDocuments: ["doc-1"],
            upsert: [{ chunk: chunk("bad"), vector: [0, 0] }],
            documents: [{ docId: "doc-1", contentHash: "new" }],
          }),
        ),
      ).rejects.toThrow();

      // The deletes in that write must not have happened either: half a write is
      // how an index ends up indexed, current, and unsearchable.
      const snapshot = await store.snapshot("acme");
      expect(snapshot.chunks.get("doc-1")).toEqual(["good"]);
      expect(snapshot.documents.get("doc-1")).toBe("hash-good");
      expect(await store.lexicalSearch("acme", "kept", 10)).toHaveLength(1);
    });
  });

  describe(`${name}: restate`, () => {
    it("moves a span without touching the vector", async () => {
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0], { charStart: 0, charEnd: 13, text: "refund window" }));
      await store.apply(
        "acme",
        write({ restate: [chunk("a", { charStart: 120, charEnd: 133, text: "refund window" })] }),
      );

      const [hit] = await store.vectorSearch("acme", [1, 0], 10);
      expect(hit?.chunk.charStart).toBe(120);
      expect(hit?.chunk.charEnd).toBe(133);
      expect(hit?.score).toBeCloseTo(1);
    });

    it("refuses to restate a chunk from another tenant", async () => {
      // Restating writes the row again, so a foreign chunk would overwrite this
      // tenant's uri, title and text and every citation drawn from them.
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0]));
      await expect(
        store.apply("acme", write({ restate: [chunk("a", { namespace: "other" })] })),
      ).rejects.toThrow(/namespace/);
    });

    it("moves the keyword index too, not only the row", async () => {
      // A restated chunk keeps its vector, but its heading path may have moved.
      // Leaving the keyword side alone makes a renamed section findable only by
      // the name it no longer has.
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0], { headingPath: ["Billing"], text: "five working days" }));
      await store.apply(
        "acme",
        write({ restate: [chunk("a", { headingPath: ["Chargebacks"], text: "five working days" })] }),
      );

      expect(await store.lexicalSearch("acme", "chargebacks", 10)).toHaveLength(1);
      expect(await store.lexicalSearch("acme", "billing", 10)).toEqual([]);
    });

    it("refuses to restate a chunk it does not hold", async () => {
      // Without a vector the piece would be indexed and never match a search.
      const store = await fresh();
      await expect(store.apply("acme", write({ restate: [chunk("ghost")] }))).rejects.toThrow(/restate/);
    });

    it("refuses to restate a chunk the same write deletes, and keeps it", async () => {
      // Throwing is not enough. A store that only notices while applying has
      // already run the delete, so the refusal has to come first.
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0], { text: "kept" }));
      await expect(
        store.apply("acme", write({ removeChunks: ["a"], restate: [chunk("a")] })),
      ).rejects.toThrow(/restate/);

      expect((await store.snapshot("acme")).chunks.get("doc-1")).toEqual(["a"]);
      expect(await store.lexicalSearch("acme", "kept", 10)).toHaveLength(1);
    });

    it("leaves the index untouched when the restate is the part that is wrong", async () => {
      // The refusal has to come before the deletes in the same write, not after.
      // A store that throws while applying has still applied half of it.
      const store = await fresh();
      await store.apply("acme", one("keeper", [1, 0], { text: "kept" }));

      await expect(
        store.apply("acme", write({ removeDocuments: ["doc-1"], restate: [chunk("ghost")] })),
      ).rejects.toThrow();

      const snapshot = await store.snapshot("acme");
      expect(snapshot.documents.get("doc-1")).toBe("hash-keeper");
      expect(snapshot.chunks.get("doc-1")).toEqual(["keeper"]);
      expect(await store.lexicalSearch("acme", "kept", 10)).toHaveLength(1);
    });
  });

  describe(`${name}: deletion`, () => {
    it("drops a chunk from both searches", async () => {
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0], { text: "refund window is thirty days" }));
      await store.apply("acme", write({ removeChunks: ["a"] }));

      expect(await store.vectorSearch("acme", [1, 0], 10)).toEqual([]);
      expect(await store.lexicalSearch("acme", "refund", 10)).toEqual([]);
      expect((await store.snapshot("acme")).chunks.get("doc-1")).toEqual([]);
    });

    it("can index a new chunk after deleting the last one", async () => {
      // A store that keys its indexes by position, and leaves a row behind when
      // a chunk goes, fails here rather than at delete time: SQLite hands the
      // freed rowid to the next insert. Deleting a chunk that is not the last
      // one hides it, which is why this deletes the only one there is.
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0], { text: "first" }));
      await store.apply("acme", write({ removeChunks: ["a"] }));
      await store.apply("acme", one("b", [0, 1], { text: "second" }));

      const hits = await store.vectorSearch("acme", [0, 1], 5);
      expect(hits.map((hit) => hit.chunk.id)).toEqual(["b"]);
      expect(hits[0]?.score).toBeCloseTo(1, 3);
      expect(await store.lexicalSearch("acme", "first", 10)).toEqual([]);
      expect(await store.lexicalSearch("acme", "second", 10)).toHaveLength(1);
    });

    it("can index a new document after deleting the last one", async () => {
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0], { text: "first" }));
      await store.apply("acme", write({ removeDocuments: ["doc-1"] }));
      await store.apply("acme", one("b", [0, 1], { docId: "doc-2", text: "second" }));

      expect((await store.vectorSearch("acme", [0, 1], 5)).map((hit) => hit.chunk.id)).toEqual(["b"]);
      expect(await store.lexicalSearch("acme", "first", 10)).toEqual([]);
    });

    it("takes a document's chunks with it", async () => {
      const store = await fresh();
      await store.apply(
        "acme",
        write({
          upsert: [
            { chunk: chunk("a", { docId: "doc-1" }), vector: [1, 0] },
            { chunk: chunk("b", { docId: "doc-2" }), vector: [0, 1] },
          ],
          documents: [
            { docId: "doc-1", contentHash: "h1" },
            { docId: "doc-2", contentHash: "h2" },
          ],
        }),
      );
      await store.apply("acme", write({ removeDocuments: ["doc-1"] }));

      const snapshot = await store.snapshot("acme");
      expect(snapshot.documents.has("doc-1")).toBe(false);
      expect(snapshot.chunks.has("doc-1")).toBe(false);
      // A vector search returns the nearest k however far they are, so what
      // proves the deletion is who is left rather than an empty list.
      const hits = await store.vectorSearch("acme", [1, 0], 10);
      expect(hits.map((hit) => hit.chunk.id)).toEqual(["b"]);
    });
  });

  describe(`${name}: vectorSearch`, () => {
    it("ranks by direction, not by length", async () => {
      const store = await fresh();
      await store.apply(
        "acme",
        write({
          upsert: [
            { chunk: chunk("aligned-short"), vector: [0.1, 0] },
            { chunk: chunk("orthogonal-long"), vector: [0, 900] },
            { chunk: chunk("between"), vector: [1, 1] },
          ],
        }),
      );

      const hits = await store.vectorSearch("acme", [1, 0], 3);
      expect(hits.map((hit) => hit.chunk.id)).toEqual(["aligned-short", "between", "orthogonal-long"]);
      // Cosine similarity, so the numbers themselves mean the same in any store.
      expect(hits[0]?.score).toBeCloseTo(1, 3);
      expect(hits[1]?.score).toBeCloseTo(Math.SQRT1_2, 3);
      expect(hits[2]?.score).toBeCloseTo(0, 3);
    });

    it("keeps what it was given, even if the caller reuses the array", async () => {
      // An embedder that pools its output buffers would otherwise rewrite the
      // index from a distance, and a norm cached beside the vector would stop
      // belonging to it: cosine keeps returning numbers, just wrong ones.
      const store = await fresh();
      const vector = [1, 0];
      const original = chunk("a", { headingPath: ["Billing"] });
      await store.apply("acme", write({ upsert: [{ chunk: original, vector }] }));

      vector[0] = 0;
      vector[1] = 1;
      original.headingPath.push("Refunds");

      const [hit] = await store.vectorSearch("acme", [1, 0], 1);
      expect(hit?.score).toBeCloseTo(1, 3);
      expect(hit?.chunk.headingPath).toEqual(["Billing"]);
    });

    it("returns the whole chunk, not only its id", async () => {
      // Citations are built from these fields, so a store that stored less than
      // it was given would be found here rather than in a wrong quote.
      const store = await fresh();
      const original = chunk("a", {
        headingPath: ["Billing", "Refunds"],
        text: "A refund takes five working days.",
        charStart: 40,
        charEnd: 73,
        tokens: 9,
      });
      await store.apply("acme", write({ upsert: [{ chunk: original, vector: [1, 0] }] }));

      const [hit] = await store.vectorSearch("acme", [1, 0], 1);
      expect(hit?.chunk).toEqual(original);
    });

    it("returns at most topK", async () => {
      const store = await fresh();
      await store.apply(
        "acme",
        write({
          upsert: [
            { chunk: chunk("a"), vector: [1, 0] },
            { chunk: chunk("b"), vector: [1, 1] },
          ],
        }),
      );
      expect(await store.vectorSearch("acme", [1, 0], 1)).toHaveLength(1);
      expect(await store.vectorSearch("acme", [1, 0], 0)).toHaveLength(0);
      await expect(store.vectorSearch("acme", [1, 0], -1)).rejects.toThrow();
    });

    it.each([
      ["a negative topK", -1],
      ["a fractional topK", 2.5],
      ["a topK that is not a number at all", Number.NaN],
    ])("refuses %s before it looks at what it holds", async (_case, topK) => {
      // On a namespace that was never written, a store that answers "nothing
      // here" first accepts a nonsense argument now and refuses it once a
      // document lands, which makes a caller's bug look like a data problem.
      const store = await fresh();
      await expect(store.vectorSearch("never-written", [1, 0], topK)).rejects.toThrow(/topK/);
      await expect(store.lexicalSearch("never-written", "anything", topK)).rejects.toThrow(/topK/);
    });

    it.each([
      ["an all-zero query vector", [0, 0]],
      ["an empty query vector", []],
      ["a non-finite query vector", [1, Number.NaN]],
    ])("refuses %s before it looks at what it holds", async (_case, vector) => {
      const store = await fresh();
      await expect(store.vectorSearch("never-written", vector, 10)).rejects.toThrow();
    });

    it("refuses a topK past the ceiling rather than quietly shortening the list", async () => {
      // The vector index has a hard ceiling on one query. Capping silently would
      // hand a caller a short vector list and a complete keyword one, and let
      // them fuse the two as though they were the same depth.
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0]));
      await expect(store.vectorSearch("acme", [1, 0], MAX_TOP_K + 1)).rejects.toThrow(/limited to/);
      await expect(store.lexicalSearch("acme", "a", MAX_TOP_K + 1)).rejects.toThrow(/limited to/);
      expect(await store.vectorSearch("acme", [1, 0], MAX_TOP_K)).toHaveLength(1);
    });

    it("returns everything it has when topK is larger than the index", async () => {
      const store = await fresh();
      await store.apply(
        "acme",
        write({
          upsert: [
            { chunk: chunk("a"), vector: [1, 0] },
            { chunk: chunk("b"), vector: [0, 1] },
          ],
        }),
      );
      expect(await store.vectorSearch("acme", [1, 0], 1000)).toHaveLength(2);
      expect(await store.lexicalSearch("acme", "a b", 1000)).toHaveLength(2);
    });

    it("refuses a query of the wrong width", async () => {
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0]));
      await expect(store.vectorSearch("acme", [1, 0, 0], 10)).rejects.toThrow(/dimension/i);
    });

    it("refuses a zero query vector", async () => {
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0]));
      await expect(store.vectorSearch("acme", [0, 0], 10)).rejects.toThrow();
    });
  });

  describe(`${name}: lexicalSearch`, () => {
    it("finds a chunk by a word in its text", async () => {
      const store = await fresh();
      await store.apply(
        "acme",
        write({
          upsert: [
            { chunk: chunk("refunds", { text: "A refund takes five working days." }), vector: [1, 0] },
            { chunk: chunk("shipping", { text: "Shipping is free above 500." }), vector: [0, 1] },
          ],
        }),
      );

      const hits = await store.lexicalSearch("acme", "refund", 10);
      expect(hits.map((hit) => hit.chunk.id)).toEqual(["refunds"]);
      expect(Number.isFinite(hits[0]?.score)).toBe(true);
    });

    it("finds a chunk by a word that appears only in its heading", async () => {
      // "Refunds" is often the section title and nowhere in the prose, which is
      // exactly the word a reader searches for.
      const store = await fresh();
      await store.apply(
        "acme",
        one("a", [1, 0], { headingPath: ["Billing", "Refunds"], text: "It takes five working days." }),
      );
      expect(await store.lexicalSearch("acme", "refunds", 10)).toHaveLength(1);
    });

    it("prefers the rarer word when a query holds both", async () => {
      const store = await fresh();
      await store.apply(
        "acme",
        write({
          upsert: [
            { chunk: chunk("rare", { text: "the policy covers chargebacks" }), vector: [1, 0] },
            { chunk: chunk("common-1", { text: "the policy is here" }), vector: [0, 1] },
            { chunk: chunk("common-2", { text: "the policy is there" }), vector: [1, 1] },
          ],
        }),
      );

      const hits = await store.lexicalSearch("acme", "policy chargebacks", 10);
      expect(hits[0]?.chunk.id).toBe("rare");
    });

    it("returns best first", async () => {
      const store = await fresh();
      await store.apply(
        "acme",
        write({
          upsert: [
            { chunk: chunk("many", { text: "refund refund refund policy" }), vector: [1, 0] },
            {
              chunk: chunk("one", { text: "refund policy and a great many other words here" }),
              vector: [0, 1],
            },
          ],
        }),
      );

      const scores = (await store.lexicalSearch("acme", "refund", 10)).map((hit) => hit.score);
      expect(scores).toHaveLength(2);
      expect(scores[0]).toBeGreaterThanOrEqual(scores[1] as number);
    });

    it("returns at most topK", async () => {
      const store = await fresh();
      await store.apply(
        "acme",
        write({
          upsert: [
            { chunk: chunk("a", { text: "refund one" }), vector: [1, 0] },
            { chunk: chunk("b", { text: "refund two" }), vector: [0, 1] },
            { chunk: chunk("c", { text: "refund three" }), vector: [1, 1] },
          ],
        }),
      );
      expect(await store.lexicalSearch("acme", "refund", 1)).toHaveLength(1);
      expect(await store.lexicalSearch("acme", "refund", 2)).toHaveLength(2);
      expect(await store.lexicalSearch("acme", "refund", 0)).toEqual([]);
    });

    it("finds a word in any script, and a number", async () => {
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0], { text: "रिफंड 30 दिन में" }));
      expect(await store.lexicalSearch("acme", "रिफंड", 10)).toHaveLength(1);
      expect(await store.lexicalSearch("acme", "30", 10)).toHaveLength(1);
    });

    it("returns nothing for a query with no indexed word", async () => {
      const store = await fresh();
      await store.apply("acme", one("a", [1, 0], { text: "refund window" }));
      expect(await store.lexicalSearch("acme", "helicopter", 10)).toEqual([]);
      expect(await store.lexicalSearch("acme", "!!! ???", 10)).toEqual([]);
    });
  });

  describe(`${name}: with planUpdate`, () => {
    /** Same text in, same vector out, so a re-run is genuinely comparable. */
    const embed = (text: string): number[] => [
      (text.match(/refund/g) ?? []).length + 1,
      (text.match(/shipping/g) ?? []).length + 1,
      (text.length % 7) + 1,
    ];

    const source = (id: string, text: string): SourceDocument => ({
      id,
      namespace: "acme",
      uri: `${id}.md`,
      title: id,
      text,
      contentHash: `hash:${text}`,
    });

    /** One paragraph per chunk, with ids derived from the text as the chunker does. */
    const chunkOf = (document: SourceDocument): Chunk[] => {
      let cursor = 0;
      return document.text.split("\n\n").map((text) => {
        const charStart = document.text.indexOf(text, cursor);
        cursor = charStart + text.length;
        return chunk(`${document.id}-${sha256(text).slice(0, 12)}`, {
          docId: document.id,
          uri: document.uri,
          title: document.id,
          text,
          charStart,
          charEnd: charStart + text.length,
        });
      });
    };

    /** The glue an indexing run does: a plan plus its vectors is one write. */
    const sync = async (
      store: Store,
      documents: SourceDocument[],
      failures: { uri: string; reason: string }[] = [],
    ) => {
      const plan = planUpdate({ documents, failures }, await store.snapshot("acme"), chunkOf);
      await store.apply("acme", {
        upsert: plan.embed.map((piece) => ({ chunk: piece, vector: embed(piece.text) })),
        restate: plan.restate,
        removeChunks: plan.remove,
        removeDocuments: plan.removedDocuments,
        documents: plan.indexedDocuments,
      });
      return plan;
    };

    it("indexes, skips unchanged work, follows an edit, and forgets a deletion", async () => {
      const store = await fresh();
      const handbook = source("doc-1", "refund window is thirty days\n\nshipping is free above 500");
      const faq = source("doc-2", "how do I contact support");

      const first = await sync(store, [handbook, faq]);
      expect(first.embed).toHaveLength(3);
      expect(first.summary).toMatchObject({ added: 2, updated: 0, unchanged: 0, deleted: 0 });
      expect((await store.lexicalSearch("acme", "refund", 10))[0]?.chunk.docId).toBe("doc-1");

      // Nothing changed, so nothing is embedded again.
      const second = await sync(store, [handbook, faq]);
      expect(second.embed).toEqual([]);
      expect(second.summary.unchanged).toBe(2);

      // Edit the first paragraph. The second one only moves.
      const edited = source("doc-1", "refund window is now fourteen days\n\nshipping is free above 500");
      const third = await sync(store, [edited, faq]);
      expect(third.embed).toHaveLength(1);
      expect(third.restate).toHaveLength(1);
      expect(third.remove).toHaveLength(1);

      expect(await store.lexicalSearch("acme", "fourteen", 10)).toHaveLength(1);
      expect(await store.lexicalSearch("acme", "thirty", 10)).toEqual([]);
      const shipping = await store.lexicalSearch("acme", "shipping", 10);
      expect(shipping[0]?.chunk.charStart).toBe(edited.text.indexOf("shipping"));

      // Drop the FAQ from the source entirely.
      const fourth = await sync(store, [edited]);
      expect(fourth.removedDocuments).toEqual(["doc-2"]);
      expect(await store.lexicalSearch("acme", "support", 10)).toEqual([]);
      expect((await store.snapshot("acme")).documents.size).toBe(1);
    });

    it("holds a document back when the run could not read everything", async () => {
      const store = await fresh();
      await sync(store, [source("doc-2", "how do I contact support")]);

      const plan = await sync(store, [], [{ uri: "doc-2.md", reason: "timed out" }]);
      expect(plan.summary.held).toBe(1);
      expect(await store.lexicalSearch("acme", "support", 10)).toHaveLength(1);
    });
  });
}

const chunk = (id: string, overrides: Partial<Chunk> = {}): Chunk => ({
  id,
  docId: "doc-1",
  namespace: "acme",
  uri: "doc-1.md",
  title: "Handbook",
  headingPath: [],
  text: id,
  charStart: 0,
  charEnd: id.length,
  tokens: 1,
  hash: id,
  ...overrides,
});

const write = (overrides: Partial<StoreWrite> = {}): StoreWrite => ({
  upsert: [],
  restate: [],
  removeChunks: [],
  removeDocuments: [],
  documents: [],
  ...overrides,
});

/** One chunk, its vector, and the document row that owns it. */
const one = (id: string, vector: number[], overrides: Partial<Chunk> = {}) =>
  write({
    upsert: [{ chunk: chunk(id, overrides), vector }],
    documents: [{ docId: overrides.docId ?? "doc-1", contentHash: `hash-${id}` }],
  });
