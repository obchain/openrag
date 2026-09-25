/**
 * Core interfaces. Every layer is an interface with one default implementation,
 * so any part can be swapped (D-012). Nothing here is implemented yet.
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
  /** Position in the source document, so a citation can highlight the exact span. */
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
  chunk(doc: SourceDocument): Chunk[];
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
  deleteDocuments(namespace: Namespace, docIds: string[]): Promise<void>;
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
