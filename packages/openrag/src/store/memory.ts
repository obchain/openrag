import type { Chunk, Namespace, SearchHit, Snapshot, Store, StoreWrite } from "../types.js";
import { checkQueryVector, checkTopK, checkWrite } from "./shared.js";

/**
 * A store that keeps everything in the process, with no index structures.
 *
 * It exists to be obviously correct, not fast: every search walks every chunk.
 * That makes it the reference the real stores are checked against, and it makes
 * `new MemoryStore()` a working quick start with nothing to install and nothing
 * to run. A corpus large enough for the linear scan to hurt wants the SQLite
 * store instead.
 */
export class MemoryStore implements Store {
  /** One index per tenant. Isolation is the shape of this map, not a filter. */
  readonly #namespaces = new Map<Namespace, Index>();
  /** Width of every vector held, across all namespaces, or undefined if none. */
  #dimensions: number | undefined;

  async snapshot(namespace: Namespace): Promise<Snapshot> {
    const index = this.#namespaces.get(namespace);
    const documents = new Map<string, string>(index?.documents ?? []);
    // Seeded from the document rows so a document that holds no chunks still
    // has an entry. `planUpdate` reads a missing entry as a lost index and
    // re-chunks; an empty array is what tells it there was nothing to hold.
    const chunks = new Map<string, string[]>([...documents.keys()].map((docId) => [docId, []]));
    for (const stored of index?.chunks.values() ?? []) {
      const ids = chunks.get(stored.chunk.docId);
      if (ids === undefined) chunks.set(stored.chunk.docId, [stored.chunk.id]);
      else ids.push(stored.chunk.id);
    }
    return { documents, chunks };
  }

  async apply(namespace: Namespace, write: StoreWrite): Promise<void> {
    const index = this.#namespaces.get(namespace) ?? { documents: new Map(), chunks: new Map() };

    // Everything is checked before anything is written, which is how a store
    // with no transactions keeps its half of the bargain: a rejected write
    // leaves the index exactly as it was.
    checkWrite(namespace, write);
    check(namespace, write, index, this.#namespaces.values());

    const removed = new Set(write.removeDocuments);
    for (const docId of removed) index.documents.delete(docId);
    for (const [id, stored] of index.chunks) if (removed.has(stored.chunk.docId)) index.chunks.delete(id);
    for (const id of write.removeChunks) index.chunks.delete(id);

    for (const chunk of write.restate) {
      const held = index.chunks.get(chunk.id);
      if (held === undefined) throw new Error(`store: restate checked but lost chunk ${chunk.id}`);
      // Its vector is the thing worth keeping; the row around it is rewritten.
      index.chunks.set(chunk.id, { ...held, ...lexical(chunk), chunk: copy(chunk) });
    }
    for (const { chunk, vector } of write.upsert) {
      // Copied, not referenced. A store that keeps the caller's array hands them
      // a way to change what is indexed after the fact, and the norm cached
      // beside it would no longer belong to the vector — cosine would keep
      // returning numbers, just wrong ones. A backend that writes to disk is
      // immune by accident; this one has to mean it.
      index.chunks.set(chunk.id, {
        chunk: copy(chunk),
        vector: [...vector],
        norm: norm(vector),
        ...lexical(chunk),
      });
    }

    for (const { docId, contentHash } of write.documents) index.documents.set(docId, contentHash);

    this.#namespaces.set(namespace, index);
    // Kept so a namespace holding nothing still knows what shape a query must
    // be: the width belongs to the index, not to one tenant.
    const width = write.upsert[0]?.vector.length;
    if (width !== undefined) this.#dimensions = width;
  }

  async vectorSearch(namespace: Namespace, vector: number[], topK: number): Promise<SearchHit[]> {
    checkTopK(topK);
    checkQueryVector(vector);
    if (this.#dimensions !== undefined && vector.length !== this.#dimensions) {
      throw new Error(
        `store: query has ${vector.length} dimensions, the index was written with ${this.#dimensions}. ` +
          "The query and the index need the same embedder.",
      );
    }

    const index = this.#namespaces.get(namespace);
    if (topK === 0 || index === undefined || index.chunks.size === 0) return [];

    const queryNorm = norm(vector);
    const hits: SearchHit[] = [];
    for (const stored of index.chunks.values()) {
      let dot = 0;
      for (let i = 0; i < vector.length; i++) dot += (vector[i] as number) * (stored.vector[i] as number);
      hits.push({ chunk: stored.chunk, score: dot / (queryNorm * stored.norm) });
    }
    return rank(hits, topK);
  }

  async lexicalSearch(namespace: Namespace, query: string, topK: number): Promise<SearchHit[]> {
    checkTopK(topK);
    const index = this.#namespaces.get(namespace);
    if (topK === 0 || index === undefined) return [];

    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];

    // One pass gathers what BM25 needs: how often each term appears in each
    // chunk, how many chunks hold it at all, and how long a chunk usually is.
    const documentFrequency = new Map<string, number>();
    const candidates: { stored: Stored; matches: [string, number][] }[] = [];
    let totalLength = 0;
    for (const stored of index.chunks.values()) {
      totalLength += stored.length;
      const matches: [string, number][] = [];
      for (const term of terms) {
        const frequency = stored.terms.get(term);
        if (frequency === undefined) continue;
        matches.push([term, frequency]);
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
      if (matches.length > 0) candidates.push({ stored, matches });
    }
    if (candidates.length === 0) return [];

    const count = index.chunks.size;
    const averageLength = totalLength / count;
    const hits = candidates.map(({ stored, matches }) => {
      let score = 0;
      for (const [term, frequency] of matches) {
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
        const saturated = frequency * (K1 + 1);
        const scaled = frequency + K1 * (1 - B + (B * stored.length) / averageLength);
        score += idf * (saturated / scaled);
      }
      return { chunk: stored.chunk, score };
    });
    return rank(hits, topK);
  }
}

/** BM25's term-saturation and length-normalisation constants, at their usual values. */
const K1 = 1.2;
const B = 0.75;

interface Stored {
  chunk: Chunk;
  vector: number[];
  /** Kept with the vector so cosine does not recompute it on every query. */
  norm: number;
  /** Term to how often it occurs, over the same text a keyword index would hold. */
  terms: Map<string, number>;
  length: number;
}

interface Index {
  /** Document id to content fingerprint. */
  documents: Map<string, string>;
  chunks: Map<string, Stored>;
}

/**
 * What can only be decided against what the index already holds. Everything a
 * backend can judge on its own has been checked by `checkWrite` already.
 *
 * Nothing is written until all of it passes, which is how a store with no
 * transactions keeps its half of the bargain.
 */
function check(namespace: Namespace, write: StoreWrite, index: Index, everything: Iterable<Index>): void {
  const dimensions = write.upsert[0]?.vector.length;
  const goneChunks = new Set(write.removeChunks);
  const goneDocuments = new Set(write.removeDocuments);
  // A write only deletes inside the namespace it was addressed to.
  const survives = (stored: Stored) =>
    stored.chunk.namespace !== namespace ||
    (!goneChunks.has(stored.chunk.id) && !goneDocuments.has(stored.chunk.docId));

  if (dimensions !== undefined) {
    // One index, one embedder — across every namespace, not just this one. A
    // store backed by a single vector table cannot do anything else, and two
    // widths in one index make the two tenants' scores incomparable anyway.
    // Every vector already held is the same width, so the first survivor settles
    // whether this write agrees with the index it is joining.
    for (const other of everything) {
      let decided = false;
      for (const stored of other.chunks.values()) {
        if (!survives(stored)) continue;
        if (stored.vector.length !== dimensions) {
          throw new Error(
            `store: writing ${dimensions}-dimension vectors into an index that holds ` +
              `${stored.vector.length}. Re-index after changing embedder.`,
          );
        }
        decided = true;
        break;
      }
      if (decided) break;
    }
  }

  for (const chunk of write.restate) {
    const held = index.chunks.get(chunk.id);
    // Restating is a promise that the vector is already paid for. If it is not,
    // the piece would be written without one and never match a vector search.
    if (held === undefined || !survives(held)) {
      throw new Error(`store: cannot restate ${chunk.id}, ${namespace} does not hold it. Embed it instead.`);
    }
  }
}

/**
 * What keyword search reads: the piece, plus the path that leads to it.
 *
 * The heading words are part of it for the same reason they are part of what
 * gets embedded — a section called "Refunds" is often the only place the word
 * appears (D-016).
 */
function lexical(chunk: Chunk): { terms: Map<string, number>; length: number } {
  const tokens = tokenize([chunk.title, ...chunk.headingPath, chunk.text].join(" "));
  const terms = new Map<string, number>();
  for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
  return { terms, length: tokens.length };
}

/**
 * Letters and digits, folded to lower case. No stemming and no stop-word list:
 * the SQLite store gets those from FTS5, and this one stays the plain baseline
 * so a difference between the two is visible rather than hidden.
 */
const tokenize = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** A chunk the caller can no longer reach into, arrays included. */
const copy = (chunk: Chunk): Chunk => ({ ...chunk, headingPath: [...chunk.headingPath] });

function norm(vector: number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

/** Best first, and only as many as were asked for. */
const rank = (hits: SearchHit[], topK: number): SearchHit[] =>
  hits.sort((a, b) => b.score - a.score).slice(0, topK);
