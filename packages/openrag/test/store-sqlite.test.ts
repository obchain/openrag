import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, SqliteStore } from "../src/store/sqlite.js";
import type { Chunk } from "../src/types.js";
import { conformance } from "./store-conformance.js";

conformance("SqliteStore", () => new SqliteStore());

describe("SqliteStore", () => {
  it("keeps the remembered vector width in step with a rolled-back write", async () => {
    // The vector table is created inside the transaction. If that write is
    // refused, the table goes with it, and a width remembered in the object
    // would describe a table the file no longer has.
    const store = new SqliteStore();
    await expect(
      store.apply("acme", {
        upsert: [
          { chunk: chunk("a"), vector: [1, 0] },
          { chunk: chunk("b"), vector: [0, 0] }, // refused: all zero
        ],
        restate: [],
        removeChunks: [],
        removeDocuments: [],
        documents: [],
      }),
    ).rejects.toThrow();

    expect(await store.vectorSearch("acme", [1, 0], 10)).toEqual([]);
    // And the store still works afterwards, at whatever width comes next.
    await store.apply("acme", {
      upsert: [{ chunk: chunk("c"), vector: [1, 0, 0] }],
      restate: [],
      removeChunks: [],
      removeDocuments: [],
      documents: [{ docId: "doc-1", contentHash: "h" }],
    });
    expect(await store.vectorSearch("acme", [1, 0, 0], 10)).toHaveLength(1);
    store.close();
  });

  it("returns the same results after the file is reopened", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "openrag-")), "index.db");
    const first = new SqliteStore({ file });
    await first.apply("acme", {
      upsert: [{ chunk: chunk("a", { text: "refunds take five working days" }), vector: [1, 0] }],
      restate: [],
      removeChunks: [],
      removeDocuments: [],
      documents: [{ docId: "doc-1", contentHash: "h" }],
    });
    const before = await first.lexicalSearch("acme", "refund", 10);
    first.close();

    const second = new SqliteStore({ file });
    expect((await second.snapshot("acme")).documents.get("doc-1")).toBe("h");
    expect(await second.lexicalSearch("acme", "refund", 10)).toEqual(before);
    expect(await second.vectorSearch("acme", [1, 0], 10)).toHaveLength(1);
    second.close();
  });

  it("refuses a file written by a newer schema", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "openrag-")), "index.db");
    new SqliteStore({ file }).close();
    const raw = new DatabaseSync(file);
    raw.exec(`pragma user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();

    expect(() => new SqliteStore({ file })).toThrow(/newer version/);
  });

  it("finds a stemmed word, which the in-memory store does not", async () => {
    const store = new SqliteStore();
    await store.apply("acme", {
      upsert: [{ chunk: chunk("a", { text: "a refund takes five days" }), vector: [1, 0] }],
      restate: [],
      removeChunks: [],
      removeDocuments: [],
      documents: [{ docId: "doc-1", contentHash: "h" }],
    });
    expect(await store.lexicalSearch("acme", "refunds", 10)).toHaveLength(1);
    store.close();
  });

  it("treats an FTS5 operator in a question as a word to search for", async () => {
    const store = new SqliteStore();
    await store.apply("acme", {
      upsert: [{ chunk: chunk("a", { text: "the refund window" }), vector: [1, 0] }],
      restate: [],
      removeChunks: [],
      removeDocuments: [],
      documents: [{ docId: "doc-1", contentHash: "h" }],
    });
    // Each of these is a syntax error if it reaches MATCH unescaped.
    for (const query of ['refund "', "refund*", "refund NEAR window", "refund AND (", "refund^2"]) {
      expect(await store.lexicalSearch("acme", query, 10)).toHaveLength(1);
    }
    store.close();
  });
});

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
