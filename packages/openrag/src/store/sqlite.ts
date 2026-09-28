import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import type { Chunk, Namespace, SearchHit, Snapshot, Store, StoreWrite } from "../types.js";

/** Bumped when the tables change. A file written by a newer version is refused. */
export const SCHEMA_VERSION = 1;

export interface SqliteOptions {
  /**
   * Where the index lives. The default keeps it in this process only, which is
   * what tests and a quick look want; pass a path for an index that survives.
   */
  file?: string;
}

/**
 * The default store: one SQLite file holding the chunks, their vectors and a
 * keyword index, with no server to run.
 *
 * Measured against the pure-JavaScript alternative on the practice corpus: the
 * same vector results, keyword hit@5 of 76% against 43%, and an index file 3.5x
 * smaller (D-016). Vectors come from the `sqlite-vec` extension and keyword
 * search from FTS5, which SQLite already ships — so a write to both halves is
 * one transaction rather than two systems that can disagree.
 */
export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  /** Width of every vector in the file, or undefined until the first one lands. */
  #dimensions: number | undefined;
  #statements = new Map<string, StatementSync>();

  constructor(options: SqliteOptions = {}) {
    const file = options.file ?? ":memory:";
    this.#db = new DatabaseSync(file, { allowExtension: true });
    this.#db.enableLoadExtension(true);
    this.#db.loadExtension(sqliteVec.getLoadablePath());
    this.#db.enableLoadExtension(false); // nothing else has any business loading code

    const version = Number(
      (this.#db.prepare("pragma user_version").get() as { user_version: number }).user_version,
    );
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `store: ${file} was written by a newer version of openrag (schema ${version}, this build reads ${SCHEMA_VERSION})`,
      );
    }
    if (file !== ":memory:") this.#db.exec("pragma journal_mode = WAL");
    this.#db.exec(SCHEMA);
    this.#db.exec(`pragma user_version = ${SCHEMA_VERSION}`);

    // An existing file already knows its width, and its vector table is already
    // there. A new one finds out at its first write.
    this.#reloadDimensions();
  }

  /** Take the vector width from the file, which is the copy a rollback keeps true. */
  #reloadDimensions(): void {
    this.#statements.clear(); // a dropped `vec` leaves prepared statements naming it
    const held = this.#db.prepare("select value from meta where key = 'dimensions'").get() as
      | { value: string }
      | undefined;
    this.#dimensions = held === undefined ? undefined : Number(held.value);
  }

  /** Release the file. Nothing else may be called afterwards. */
  close(): void {
    this.#statements.clear();
    this.#db.close();
  }

  async snapshot(namespace: Namespace): Promise<Snapshot> {
    const documents = new Map<string, string>();
    for (const row of this.#sql("select doc_id, content_hash from documents where namespace = ?").all(
      namespace,
    )) {
      const { doc_id, content_hash } = row as { doc_id: string; content_hash: string };
      documents.set(doc_id, content_hash);
    }
    // Seeded from the document rows so a document that holds no chunks still has
    // an entry: `planUpdate` reads a missing entry as a lost index and re-chunks.
    const chunks = new Map<string, string[]>([...documents.keys()].map((docId) => [docId, []]));
    for (const row of this.#sql("select doc_id, id from chunks where namespace = ?").all(namespace)) {
      const { doc_id, id } = row as { doc_id: string; id: string };
      const ids = chunks.get(doc_id);
      if (ids === undefined) chunks.set(doc_id, [id]);
      else ids.push(id);
    }
    return { documents, chunks };
  }

  async apply(namespace: Namespace, write: StoreWrite): Promise<void> {
    // Cheap checks first, so an obviously bad write never opens a transaction.
    const dimensions = validate(namespace, write);

    this.#db.exec("begin immediate");
    try {
      this.#remove(namespace, write);
      if (dimensions !== undefined) this.#reconcileDimensions(dimensions);
      this.#restate(namespace, write.restate);
      this.#upsert(namespace, write.upsert);
      for (const { docId, contentHash } of write.documents) {
        this.#sql("insert or replace into documents (namespace, doc_id, content_hash) values (?, ?, ?)").run(
          namespace,
          docId,
          contentHash,
        );
      }
      this.#db.exec("commit");
    } catch (error) {
      // Half a write is how an index ends up indexed, current and unsearchable.
      this.#db.exec("rollback");
      // Creating or dropping the vector table is undone by that rollback, but
      // the width this object remembers is not: left alone it would go on
      // describing a table the file no longer has.
      this.#reloadDimensions();
      throw error;
    }
  }

  async vectorSearch(namespace: Namespace, vector: number[], topK: number): Promise<SearchHit[]> {
    if (topK < 0) throw new Error(`store: topK must not be negative, got ${topK}`);
    if (topK === 0 || this.#dimensions === undefined) return [];
    if (vector.length !== this.#dimensions) {
      throw new Error(
        `store: query has ${vector.length} dimensions, the index was written with ${this.#dimensions}. ` +
          "The query and the index need the same embedder.",
      );
    }
    if (!vector.some((value) => value !== 0)) throw new Error("store: cannot search with a zero vector");

    // The k limit lives inside the vector table, so the namespace has to be a
    // partition key rather than a filter applied afterwards: filtering later
    // would hand back the nearest k across every tenant and then throw most of
    // them away, leaving this tenant short of the topK it asked for.
    const rows = this.#sql(
      `select c.*, hit.distance as distance
         from (select chunk_rowid, distance from vec
                where namespace = ? and embedding match ? and k = ?) as hit
         join chunks c on c.seq = hit.chunk_rowid
        order by hit.distance`,
    ).all(namespace, serialise(vector), topK);

    // vec0 is asked for cosine distance, which is 1 - cosine similarity.
    return rows.map((row) => ({
      chunk: toChunk(row),
      score: 1 - Number((row as { distance: number }).distance),
    }));
  }

  async lexicalSearch(namespace: Namespace, query: string, topK: number): Promise<SearchHit[]> {
    if (topK < 0) throw new Error(`store: topK must not be negative, got ${topK}`);
    if (topK === 0) return [];

    const match = matchQuery(query);
    if (match === undefined) return [];

    // The limit sits on the outer query, after the namespace filter, so a tenant
    // asking for 10 gets 10 of its own rather than whatever survives a filter.
    const rows = this.#sql(
      `select c.*, bm25(fts) as rank
         from fts join chunks c on c.seq = fts.rowid
        where fts match ? and c.namespace = ?
        order by rank
        limit ?`,
    ).all(match, namespace, topK);

    // FTS5 reports bm25 as a negative number, best first. The contract is the
    // other way round: higher is better.
    return rows.map((row) => ({ chunk: toChunk(row), score: -Number((row as { rank: number }).rank) }));
  }

  /** Prepared once and kept, because every one of these runs per chunk. */
  #sql(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #remove(namespace: Namespace, write: StoreWrite): void {
    for (const docId of write.removeDocuments) {
      const rows = this.#sql("select seq from chunks where namespace = ? and doc_id = ?").all(
        namespace,
        docId,
      );
      for (const row of rows) this.#dropChunk(namespace, BigInt((row as { seq: number }).seq));
      this.#sql("delete from chunks where namespace = ? and doc_id = ?").run(namespace, docId);
      this.#sql("delete from documents where namespace = ? and doc_id = ?").run(namespace, docId);
    }
    for (const id of write.removeChunks) {
      const seq = this.#seqOf(namespace, id);
      if (seq === undefined) continue; // already gone is the state that was asked for
      this.#dropChunk(namespace, seq);
      this.#sql("delete from chunks where seq = ?").run(seq);
    }
  }

  /** Take a chunk out of both indexes. Its row in `chunks` is the caller's job. */
  #dropChunk(namespace: Namespace, seq: bigint): void {
    this.#sql("delete from fts where rowid = ?").run(seq);
    if (this.#dimensions !== undefined) {
      this.#sql("delete from vec where namespace = ? and chunk_rowid = ?").run(namespace, seq);
    }
  }

  #seqOf(namespace: Namespace, id: string): bigint | undefined {
    const row = this.#sql("select seq from chunks where namespace = ? and id = ?").get(namespace, id) as
      | { seq: number }
      | undefined;
    return row === undefined ? undefined : BigInt(row.seq);
  }

  /**
   * A vector table is created for one width and cannot change it, so a width
   * that disagrees is either a mistake or a re-index. It is a re-index only when
   * nothing is left to disagree with — checked after this write's deletes.
   */
  #reconcileDimensions(dimensions: number): void {
    if (this.#dimensions === dimensions) return;

    if (this.#dimensions !== undefined) {
      const { n } = this.#sql("select count(*) as n from chunks").get() as { n: number };
      if (n > 0) {
        throw new Error(
          `store: writing ${dimensions}-dimension vectors into an index that holds ${this.#dimensions}. ` +
            "Re-index after changing embedder.",
        );
      }
      this.#db.exec("drop table vec");
      this.#statements.clear(); // the prepared statements name a table that is gone
    }

    this.#db.exec(
      `create virtual table vec using vec0(
         namespace text partition key,
         chunk_rowid integer primary key,
         embedding float[${dimensions}] distance_metric=cosine
       )`,
    );
    this.#sql("insert or replace into meta (key, value) values ('dimensions', ?)").run(String(dimensions));
    this.#dimensions = dimensions;
  }

  #restate(namespace: Namespace, chunks: Chunk[]): void {
    for (const chunk of chunks) {
      const seq = this.#seqOf(namespace, chunk.id);
      // Restating is a promise that the vector is already paid for. Without one
      // the piece would be indexed and never match a vector search.
      if (seq === undefined) {
        throw new Error(
          `store: cannot restate ${chunk.id}, ${namespace} does not hold it. Embed it instead.`,
        );
      }
      this.#sql(
        `update chunks set doc_id = ?, uri = ?, title = ?, heading_path = ?, text = ?,
                           char_start = ?, char_end = ?, tokens = ?, hash = ?
          where seq = ?`,
      ).run(
        chunk.docId,
        chunk.uri,
        chunk.title,
        JSON.stringify(chunk.headingPath),
        chunk.text,
        chunk.charStart,
        chunk.charEnd,
        chunk.tokens,
        chunk.hash,
        seq,
      );
      // The vector stays; the keyword side is rewritten in case the path moved.
      this.#sql("delete from fts where rowid = ?").run(seq);
      this.#sql("insert into fts (rowid, text) values (?, ?)").run(seq, searchable(chunk));
    }
  }

  #upsert(namespace: Namespace, entries: { chunk: Chunk; vector: number[] }[]): void {
    for (const { chunk, vector } of entries) {
      // Writing an id the index already holds replaces it, rather than leaving
      // two rows that both claim to be the same piece.
      const existing = this.#seqOf(namespace, chunk.id);
      if (existing !== undefined) {
        this.#dropChunk(namespace, existing);
        this.#sql("delete from chunks where seq = ?").run(existing);
      }

      const { lastInsertRowid } = this.#sql(
        `insert into chunks (namespace, id, doc_id, uri, title, heading_path, text, char_start, char_end, tokens, hash)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        namespace,
        chunk.id,
        chunk.docId,
        chunk.uri,
        chunk.title,
        JSON.stringify(chunk.headingPath),
        chunk.text,
        chunk.charStart,
        chunk.charEnd,
        chunk.tokens,
        chunk.hash,
      );
      // vec0 refuses a primary key that is not an integer, and a JS number is a
      // double as far as it is concerned, so the key crosses as a BigInt.
      const seq = BigInt(lastInsertRowid);
      this.#sql("insert into fts (rowid, text) values (?, ?)").run(seq, searchable(chunk));
      this.#sql("insert into vec (namespace, chunk_rowid, embedding) values (?, ?, ?)").run(
        namespace,
        seq,
        serialise(vector),
      );
    }
  }
}

/**
 * `seq` is what ties the three tables together: the vector table and the
 * keyword table are both keyed by it, so a chunk is one row in each.
 *
 * The keyword table holds the same `title › headings › text` that gets embedded,
 * because a section called "Refunds" is often the only place the word appears.
 * Its `porter` tokenizer is why the SQLite store finds "refund" from "refunds"
 * where the in-memory one does not.
 */
const SCHEMA = `
create table if not exists meta (
  key text primary key,
  value text not null
) without rowid;

create table if not exists documents (
  namespace text not null,
  doc_id text not null,
  content_hash text not null,
  primary key (namespace, doc_id)
) without rowid;

create table if not exists chunks (
  seq integer primary key,
  namespace text not null,
  id text not null,
  doc_id text not null,
  uri text not null,
  title text not null,
  heading_path text not null,
  text text not null,
  char_start integer not null,
  char_end integer not null,
  tokens integer not null,
  hash text not null
);

create unique index if not exists chunks_by_id on chunks (namespace, id);
create index if not exists chunks_by_document on chunks (namespace, doc_id);

create virtual table if not exists fts using fts5(text, tokenize = 'porter unicode61');
`;

/** What can be decided without reading the database. Returns the width this write brings. */
function validate(namespace: Namespace, write: StoreWrite): number | undefined {
  const dimensions = write.upsert[0]?.vector.length;

  for (const { chunk, vector } of write.upsert) {
    sameNamespace(namespace, chunk);
    if (vector.length !== dimensions) {
      throw new Error(
        `store: chunk ${chunk.id} has ${vector.length} dimensions, ${dimensions} in the same write. ` +
          "One write comes from one embedder.",
      );
    }
    if (vector.length === 0) throw new Error(`store: chunk ${chunk.id} has an empty vector`);
    if (!vector.every(Number.isFinite)) {
      throw new Error(`store: chunk ${chunk.id} has a vector with a non-finite value`);
    }
    if (!vector.some((value) => value !== 0))
      throw new Error(`store: chunk ${chunk.id} has an all-zero vector`);
  }
  for (const chunk of write.restate) sameNamespace(namespace, chunk);

  return dimensions;
}

/** A chunk written under the wrong tenant makes every citation it produces a lie. */
function sameNamespace(namespace: Namespace, chunk: Chunk): void {
  if (chunk.namespace !== namespace) {
    throw new Error(
      `store: chunk ${chunk.id} belongs to namespace ${chunk.namespace}, written to ${namespace}`,
    );
  }
}

const searchable = (chunk: Chunk): string => [chunk.title, ...chunk.headingPath, chunk.text].join("\n");

/**
 * A question is not an FTS5 expression. Reducing it to bare words first means a
 * stray quote, `*` or `NEAR` is text to search for rather than syntax to run.
 */
function matchQuery(query: string): string | undefined {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term}"`).join(" OR ");
}

const serialise = (vector: number[]): Uint8Array => new Uint8Array(new Float32Array(vector).buffer);

function toChunk(row: unknown): Chunk {
  const r = row as {
    id: string;
    namespace: string;
    doc_id: string;
    uri: string;
    title: string;
    heading_path: string;
    text: string;
    char_start: number;
    char_end: number;
    tokens: number;
    hash: string;
  };
  return {
    id: r.id,
    docId: r.doc_id,
    namespace: r.namespace,
    uri: r.uri,
    title: r.title,
    headingPath: JSON.parse(r.heading_path) as string[],
    text: r.text,
    charStart: Number(r.char_start),
    charEnd: Number(r.char_end),
    tokens: Number(r.tokens),
    hash: r.hash,
  };
}
