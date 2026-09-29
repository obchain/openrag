import type { Chunk, IndexedDocument, Namespace, StoreWrite } from "../types.js";

/**
 * Checks every store makes, in the same order, with the same words.
 *
 * They are here rather than in each store because they have to happen *before*
 * a store looks at what it holds. A store that answers "nothing here" first
 * accepts a nonsense argument on an empty namespace and refuses the same
 * argument once a document lands, which makes a caller's bug appear to be about
 * the data.
 */

/**
 * The most hits any store will return from one search.
 *
 * It is the ceiling `sqlite-vec` puts on a single k-nearest query, and it is
 * the contract's rather than that store's so the two cannot disagree: capping
 * quietly would hand a caller a short vector list and a complete keyword one
 * and let them fuse the two as if they were the same depth.
 */
export const MAX_TOP_K = 4096;

export function checkTopK(topK: number): void {
  // `slice(0, -1)` quietly returns everything but the last hit, and SQLite
  // answers a fractional limit with "datatype mismatch". Neither is an answer
  // to the question that was asked.
  if (!Number.isInteger(topK) || topK < 0) {
    throw new Error(`store: topK must be a whole number and not negative, got ${topK}`);
  }
  if (topK > MAX_TOP_K) {
    throw new Error(`store: topK is limited to ${MAX_TOP_K}, got ${topK}. Retrieve in pages instead.`);
  }
}

export function checkQueryVector(vector: number[]): void {
  if (vector.length === 0) throw new Error("store: cannot search with an empty vector");
  if (!vector.every(Number.isFinite)) throw new Error("store: cannot search with a non-finite vector");
  // Cosine divides by the length of the vector, so an all-zero query is not a
  // bad result, it is a division by zero dressed up as one.
  if (!vector.some((value) => value !== 0)) throw new Error("store: cannot search with a zero vector");
}

/**
 * Everything a write has to be true for, whatever the backend.
 *
 * Returns the vector width the write brings, or undefined if it writes none.
 */
export function checkWrite(namespace: Namespace, write: StoreWrite): number | undefined {
  const dimensions = write.upsert[0]?.vector.length;

  for (const { chunk, vector } of write.upsert) {
    checkChunk(namespace, chunk);
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
  for (const chunk of write.restate) checkChunk(namespace, chunk);
  for (const document of write.documents) checkDocument(document);

  return dimensions;
}

function checkChunk(namespace: Namespace, chunk: Chunk): void {
  // A chunk written under the wrong tenant makes every citation it produces a lie.
  if (chunk.namespace !== namespace) {
    throw new Error(
      `store: chunk ${chunk.id} belongs to namespace ${chunk.namespace}, written to ${namespace}`,
    );
  }
  printable(chunk.id, `chunk ${JSON.stringify(chunk.id)}`, "id");
  printable(chunk.docId, `chunk ${chunk.id}`, "docId");
  printable(chunk.namespace, `chunk ${chunk.id}`, "namespace");
  printable(chunk.uri, `chunk ${chunk.id}`, "uri");
  printable(chunk.title, `chunk ${chunk.id}`, "title");
  printable(chunk.text, `chunk ${chunk.id}`, "text");
  printable(chunk.hash, `chunk ${chunk.id}`, "hash");
}

function checkDocument(document: IndexedDocument): void {
  printable(document.docId, `document ${JSON.stringify(document.docId)}`, "docId");
  printable(document.contentHash, `document ${document.docId}`, "contentHash");
}

/**
 * SQLite hands its text to C, which ends a string at the first `\0`: a 12
 * character `text` comes back 6 characters long, with nothing said. Truncating
 * an id is worse than truncating prose — `snapshot()` would then report a docId
 * that can never match the source again, so the document is re-chunked and
 * re-embedded on every run, for ever. It is refused rather than left to the
 * backend, so both stores behave alike.
 */
function printable(value: string, owner: string, field: string): void {
  if (value.includes("\u0000")) {
    throw new Error(`store: ${owner} has a null byte in its ${field}, which not every store can hold`);
  }
}
