import type { CountTokens } from "./chunk/tokens.js";

export type { CountTokens };

/**
 * Core interfaces. Every layer is an interface with one default implementation,
 * so any part can be swapped. An interface here is settled only once the layer
 * that implements it ships; the rest are still drafts.
 */

/** A tenant boundary. Every store call is scoped to one (D-006). */
export type Namespace = string;

export interface SourceDocument {
  id: string;
  namespace: Namespace;
  /** Where it came from: a file path or a URL. */
  uri: string;
  title: string;
  text: string;
  /** Fingerprint of the raw content; unchanged fingerprint means unchanged document. */
  contentHash: string;
  metadata?: Record<string, unknown>;
  indexedAt?: Date;
}

/** A source that could not be read. Always reported, never silently dropped. */
export interface LoadFailure {
  uri: string;
  reason: string;
}

/**
 * What a loader returns. The failures travel with the documents, because a
 * partial index that looks complete is worse than a loud error.
 */
export interface LoadResult {
  documents: SourceDocument[];
  failures: LoadFailure[];
}

/**
 * One piece of a document.
 *
 * `text` is always `ParsedDocument.text.slice(charStart, charEnd)`. Cleaning
 * happens by dropping whole blocks, never by editing inside one, so a citation
 * can always point at a real span of the text that was indexed.
 */
export interface Block {
  /** Section this block sits under, e.g. ["Billing", "Refunds"]. */
  headingPath: string[];
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ParsedDocument {
  /** Front matter `title` if the page declares one, else its first heading. */
  title?: string;
  /** The text the offsets refer to. Markdown keeps its source; HTML is converted first. */
  text: string;
  blocks: Block[];
}

export interface ChunkOptions {
  /**
   * How a piece is measured. Required, and required to be the same counter the
   * embedder uses, because a budget counted with another ruler is a guess.
   * `estimateTokens` is available for a run where no tokenizer is at hand, but
   * it has to be asked for by name.
   */
  countTokens: CountTokens;
  maxTokens?: number;
  /**
   * Prepend `page › heading` to the text that gets embedded. Measured: dropping
   * it cost 7 points of hit@5, and code-mixed questions fell from 100% to 83%.
   *
   * Whatever is chosen here has to be passed to `embedText` as well, or the
   * pieces are packed to one budget and embedded against another.
   */
  header?: boolean;
}

/** One piece of a document. Search runs over these, not whole files. */
export interface Chunk {
  id: string;
  docId: string;
  namespace: Namespace;
  uri: string;
  title: string;
  /** Section path inside the document, e.g. ["Refunds", "International"]. */
  headingPath: string[];
  text: string;
  /**
   * Where the chunk sits in the parsed text it came from: Markdown keeps the
   * file, HTML keeps the text the page was converted to, and an index has to
   * store that same text for this to resolve.
   *
   * It is a span, not the text itself. A chunk packed from several blocks runs
   * from the first to the last, so anything dropped as noise in between lies
   * inside the span while being absent from `text`. Quote `text`; use the span
   * to point at the source.
   */
  charStart: number;
  charEnd: number;
  tokens: number;
  hash: string;
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
}

export interface Citation {
  uri: string;
  title: string;
  heading: string;
  charStart: number;
  charEnd: number;
  score: number;
}

/** Result of `retrieve()`: no LLM call is made (D-006). */
export interface RetrieveResult {
  hits: SearchHit[];
  citations: Citation[];
  /**
   * Weak signal, not a guarantee: retrieval scores overlap heavily between
   * answerable and unanswerable questions (D-018). Treat false as "probably not
   * in the docs" and let an LLM decide.
   */
  grounded: boolean;
  reason?: string;
  trace: Trace;
}

export interface Chunker {
  chunk(document: SourceDocument, parsed: ParsedDocument, options: ChunkOptions): Chunk[];
}

export interface Embedder {
  readonly id: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export interface Reranker {
  readonly id: string;
  rerank(query: string, hits: SearchHit[], topK: number): Promise<SearchHit[]>;
}

/** Any backend that can do these four things inside a namespace can be the store. */
export interface Store {
  upsert(namespace: Namespace, chunks: Chunk[], vectors: number[][]): Promise<void>;
  /** Write chunks whose vectors the index already holds, after an edit moved them. */
  restate(namespace: Namespace, chunks: Chunk[]): Promise<void>;
  deleteDocuments(namespace: Namespace, docIds: string[]): Promise<void>;
  /** Incremental re-indexing removes pieces, not only whole documents. */
  deleteChunks(namespace: Namespace, chunkIds: string[]): Promise<void>;
  vectorSearch(namespace: Namespace, vector: number[], topK: number): Promise<SearchHit[]>;
  lexicalSearch(namespace: Namespace, query: string, topK: number): Promise<SearchHit[]>;
}

export type Role = "system" | "user" | "assistant";
export interface Message {
  role: Role;
  content: string;
}

/** Streamed pieces of an answer. */
export type LLMChunk =
  | { type: "text"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

/**
 * Our own small surface for talking to a model, so the package never depends
 * directly on one provider's SDK (D-013).
 */
export interface LLM {
  readonly id: string;
  stream(messages: Message[], options?: { signal?: AbortSignal }): AsyncIterable<LLMChunk>;
  /** Structured output, used by the planner. */
  object<T>(messages: Message[], schema: unknown, options?: { signal?: AbortSignal }): Promise<T>;
}

/** One decision per turn, from a single structured call (D-007). */
export type PlannerAction = "ANSWER" | "RETRIEVE" | "CLARIFY";
export interface PlannerResult {
  action: PlannerAction;
  /** The message rewritten so it makes sense on its own. */
  standaloneQuery: string;
  topicShift: boolean;
}

/** What the caller sees while a turn runs (D-009). */
export type ChatEvent =
  | { type: "action"; action: PlannerAction | "ABSTAIN" }
  | { type: "token"; text: string }
  | { type: "citation"; citation: Citation }
  | { type: "done"; trace: Trace };

/** Step-by-step record of a turn. Versioned so tool calls and approvals can be added later (D-010). */
export interface TraceStep {
  step: string;
  ms?: number;
  [detail: string]: unknown;
}

export interface Trace {
  version: 1;
  turnId: string;
  action?: PlannerAction | "ABSTAIN";
  steps: TraceStep[];
  citations: string[];
}

export interface Tracer {
  record(trace: Trace): void | Promise<void>;
}
