import type { Chunk, LoadResult, SourceDocument } from "../types.js";

/**
 * What the index already holds, for one namespace. The store answers for the
 * tenant it was asked about, so nothing here carries a namespace of its own.
 */
export interface Snapshot {
  /** Document id to the content fingerprint it was indexed at. */
  documents: ReadonlyMap<string, string>;
  /** Document id to the chunk ids currently held for it. */
  chunks: ReadonlyMap<string, readonly string[]>;
}

/** A document row the caller has to write, or the next run repeats this work. */
export interface IndexedDocument {
  docId: string;
  contentHash: string;
}

/** What to do to bring the index level with the source. */
export interface UpdatePlan {
  /** New or changed text. Only these are embedded, which is the whole point. */
  embed: Chunk[];
  /**
   * The same text in a new place: its vector still stands, but its row has to be
   * written again because the edit above it moved the span a citation points at.
   */
  restate: Chunk[];
  /** Chunks that stay as they are: untouched documents, and any held back. */
  keep: string[];
  /** Chunk ids to remove, from the vectors and from the keyword index alike. */
  remove: string[];
  /** Documents that are gone from the source. */
  removedDocuments: string[];
  /** Document rows to write, so an unchanged run next time really is unchanged. */
  indexedDocuments: IndexedDocument[];
  summary: UpdateSummary;
}

export interface UpdateSummary {
  added: number;
  updated: number;
  unchanged: number;
  deleted: number;
  /** Documents missing from this run that were kept because the read was partial. */
  held: number;
}

/**
 * Work out what has to change, without doing any of it.
 *
 * Documents are compared by their content fingerprint first: an unchanged one is
 * never parsed or chunked, let alone embedded. A changed one is chunked, and
 * only the pieces whose text actually moved are handed back for embedding —
 * editing one paragraph of a long page leaves the rest of it alone.
 *
 * `chunkOf` is called only for the documents that need it, so the caller can
 * pass the real parse-and-chunk step and pay for it only where it matters.
 *
 * The whole `LoadResult` is taken, failures included, because absence only means
 * deletion when the read was complete.
 */
export function planUpdate(
  load: LoadResult,
  snapshot: Snapshot,
  chunkOf: (document: SourceDocument) => Chunk[],
): UpdatePlan {
  const embed: Chunk[] = [];
  const restate: Chunk[] = [];
  const keep: string[] = [];
  const remove: string[] = [];
  const indexedDocuments: IndexedDocument[] = [];
  const summary: UpdateSummary = { added: 0, updated: 0, unchanged: 0, deleted: 0, held: 0 };
  const present = new Set<string>();

  for (const document of load.documents) {
    if (present.has(document.id)) continue; // the same document twice is still one document
    present.add(document.id);

    const indexedHash = snapshot.documents.get(document.id);
    const indexedChunks = snapshot.chunks.get(document.id);

    // Unchanged, and the index still knows its pieces: nothing to do at all.
    // A document the index has no record of pieces for is treated as changed
    // rather than trusted, or an index that lost rows would stay short of them
    // for good. An empty record is a record: a page with nothing to index has
    // no pieces, and must not be re-chunked on every run because of it.
    if (indexedHash === document.contentHash && indexedChunks !== undefined) {
      keep.push(...indexedChunks);
      summary.unchanged++;
      continue;
    }

    const chunks = chunkOf(document);
    const held = new Set(indexedChunks ?? []);
    const current = new Set<string>();

    for (const chunk of chunks) {
      current.add(chunk.id);
      // The id carries the fingerprint of what gets embedded, so an id the index
      // already holds is text it has already paid for. Its position may still
      // have moved, so the chunk itself goes back, not just its id.
      if (held.has(chunk.id)) restate.push(chunk);
      else embed.push(chunk);
    }

    for (const id of held) if (!current.has(id)) remove.push(id);

    indexedDocuments.push({ docId: document.id, contentHash: document.contentHash });
    if (indexedHash === undefined) summary.added++;
    else summary.updated++;
  }

  // A document missing from a run that could not read everything may simply be
  // the one that failed. Deleting on a partial read empties an index whenever a
  // folder is briefly unreachable, so deletions wait for a clean run.
  const readWasComplete = load.failures.length === 0;

  const removedDocuments: string[] = [];
  for (const docId of new Set([...snapshot.documents.keys(), ...snapshot.chunks.keys()])) {
    if (present.has(docId)) continue;
    if (!readWasComplete) {
      // Its pieces stay in the index, so they belong in `keep`: a caller
      // rebuilding from keep + embed + restate must not lose them.
      keep.push(...(snapshot.chunks.get(docId) ?? []));
      summary.held++;
      continue;
    }
    // A docId known only to the chunk map is an orphan from a half-written run.
    // Sweeping both key sets is what keeps those pieces from being searchable
    // for ever with no document to delete them by.
    removedDocuments.push(docId);
    remove.push(...(snapshot.chunks.get(docId) ?? []));
    summary.deleted++;
  }

  return { embed, restate, keep, remove, removedDocuments, indexedDocuments, summary };
}
