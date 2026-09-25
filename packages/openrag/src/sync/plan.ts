import type { Chunk, SourceDocument } from "../types.js";

/**
 * What the index already holds. The least a plan can be made from, so any store
 * can answer it: two lookups, no vectors and no text.
 */
export interface Snapshot {
  /** Document id to the content fingerprint it was indexed at. */
  documents: ReadonlyMap<string, string>;
  /** Document id to the chunk ids currently held for it. */
  chunks: ReadonlyMap<string, readonly string[]>;
}

/** What to do to bring the index level with the source. */
export interface UpdatePlan {
  /** New or changed text. Only these are embedded, which is the whole point. */
  embed: Chunk[];
  /** Already indexed and unchanged: their vectors are reused as they are. */
  keep: string[];
  /** Chunk ids to remove, from the vectors and from the keyword index alike. */
  remove: string[];
  /** Documents that are gone from the source. */
  removedDocuments: string[];
  summary: UpdateSummary;
}

export interface UpdateSummary {
  added: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

/**
 * Work out what has to change, without doing any of it.
 *
 * Documents are compared by their content fingerprint first: an unchanged one is
 * never parsed or chunked, let alone embedded. A changed one is chunked, and
 * only the chunks whose text actually moved are handed back for embedding —
 * editing one paragraph of a long page leaves the rest of it alone.
 *
 * `chunkOf` is called only for the documents that need it, so the caller can
 * pass the real parse-and-chunk step and pay for it only where it matters.
 */
export function planUpdate(
  documents: readonly SourceDocument[],
  snapshot: Snapshot,
  chunkOf: (document: SourceDocument) => Chunk[],
): UpdatePlan {
  const embed: Chunk[] = [];
  const keep: string[] = [];
  const remove: string[] = [];
  const summary: UpdateSummary = { added: 0, updated: 0, unchanged: 0, deleted: 0 };
  const present = new Set<string>();

  for (const document of documents) {
    present.add(document.id);
    const indexedHash = snapshot.documents.get(document.id);
    const indexedChunks = snapshot.chunks.get(document.id);

    // Unchanged, and the index still holds its pieces: nothing to do at all.
    // A document whose pieces are missing is treated as changed rather than
    // trusted, or an index that lost rows would stay short of them for good.
    if (indexedHash === document.contentHash && indexedChunks && indexedChunks.length > 0) {
      keep.push(...indexedChunks);
      summary.unchanged++;
      continue;
    }

    const chunks = chunkOf(document);
    const held = new Set(indexedChunks ?? []);
    const current = new Set<string>();

    for (const chunk of chunks) {
      current.add(chunk.id);
      // The id carries the fingerprint of what gets embedded, so an id the
      // index already holds is text it has already paid for.
      if (held.has(chunk.id)) keep.push(chunk.id);
      else embed.push(chunk);
    }

    for (const id of held) if (!current.has(id)) remove.push(id);

    if (indexedHash === undefined) summary.added++;
    else summary.updated++;
  }

  const removedDocuments: string[] = [];
  for (const id of snapshot.documents.keys()) {
    if (present.has(id)) continue;
    removedDocuments.push(id);
    remove.push(...(snapshot.chunks.get(id) ?? []));
    summary.deleted++;
  }

  return { embed, keep, remove, removedDocuments, summary };
}
