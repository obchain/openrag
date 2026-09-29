import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, SqliteStore } from "../src/store/sqlite.js";
import type { Chunk, StoreWrite } from "../src/types.js";
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

  it("stays correct when a second connection is open on the same file", async () => {
    // WAL is on for every file-backed index, which is the journal mode whose
    // whole purpose is a second connection. One opened before any vector exists
    // used to believe that forever: its deletes skipped the vector table, the
    // freed row id went to the next insert, and the index became unwritable.
    const file = join(await mkdtemp(join(tmpdir(), "openrag-")), "index.db");
    const first = new SqliteStore({ file });
    const second = new SqliteStore({ file }); // opened before anything is indexed
    const third = new SqliteStore({ file }); // likewise, and its first call is a delete

    await first.apply("acme", write({ upsert: [{ chunk: chunk("a", { text: "alpha" }), vector: [1, 0] }] }));

    // `third` has never searched, so nothing has refreshed what it believes.
    // Deleting here has to take the vector row with it: leaving one behind
    // wedges the file, because the next insert is handed the freed row id.
    await third.apply("acme", write({ removeChunks: ["a"] }));
    await first.apply("acme", write({ upsert: [{ chunk: chunk("a", { text: "alpha" }), vector: [1, 0] }] }));
    third.close();

    // The connection that was already open has to see it, both ways.
    expect((await second.snapshot("acme")).chunks.get("doc-1")).toEqual(["a"]);
    expect(await second.lexicalSearch("acme", "alpha", 5)).toHaveLength(1);
    expect(await second.vectorSearch("acme", [1, 0], 5)).toHaveLength(1);
    await expect(second.vectorSearch("acme", [1, 0, 0], 5)).rejects.toThrow(/dimension/i);

    // And its deletes have to take the vector with them.
    await second.apply("acme", write({ removeChunks: ["a"] }));
    await first.apply("acme", write({ upsert: [{ chunk: chunk("b", { text: "beta" }), vector: [0, 1] }] }));
    expect((await first.vectorSearch("acme", [0, 1], 5)).map((hit) => hit.chunk.id)).toEqual(["b"]);

    // A re-index at another width, from the other connection, is seen too.
    await second.apply(
      "acme",
      write({
        removeDocuments: ["doc-1"],
        upsert: [{ chunk: chunk("c", { docId: "doc-2" }), vector: [1, 0, 0] }],
      }),
    );
    expect(await first.vectorSearch("acme", [1, 0, 0], 5)).toHaveLength(1);

    first.close();
    second.close();
  });

  it("stamps the schema version it wrote, not just refuses a newer one", async () => {
    // Only reading the version means a build that forgot to write one leaves
    // every index at 0, and the next bump cannot tell an old file from a new.
    const file = join(await mkdtemp(join(tmpdir(), "openrag-")), "index.db");
    new SqliteStore({ file }).close();

    const raw = new DatabaseSync(file);
    const { user_version } = raw.prepare("pragma user_version").get() as { user_version: number };
    raw.close();
    expect(Number(user_version)).toBe(SCHEMA_VERSION);
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

const write = (overrides: Partial<StoreWrite> = {}): StoreWrite => ({
  upsert: [],
  restate: [],
  removeChunks: [],
  removeDocuments: [],
  documents: [{ docId: "doc-1", contentHash: "h" }],
  ...overrides,
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
