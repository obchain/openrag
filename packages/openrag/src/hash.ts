import { createHash } from "node:crypto";

/** Hex sha256. Used for both content fingerprints and derived ids. */
export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Stable document id: the same namespace and uri always produce the same id, on
 * every run and on every machine. Incremental indexing compares against these
 * ids, so anything volatile here (a timestamp, a counter) would make every run
 * look like a fresh corpus.
 */
export function documentId(namespace: string, uri: string): string {
  return sha256(`${namespace}\u0000${uri}`).slice(0, 16);
}
