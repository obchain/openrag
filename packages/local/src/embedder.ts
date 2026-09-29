import { AutoTokenizer, env, pipeline } from "@huggingface/transformers";
import type { CountTokens, Embedder } from "openrag";

/**
 * Measured on the practice corpus (`experiments/m0/RESULTS.md`, section 2):
 * 88% hit@5 on its own, 90% with the reranker, and 1102 pieces in 43 seconds.
 * A 325 MB multilingual model scored 93% but indexed about 32x slower, which is
 * hours for a mid-sized knowledge base on a laptop, so it is an opt-in rather
 * than the default.
 */
export const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";

/**
 * What each model wants done to the text before it sees it.
 *
 * A model trained with an instruction prefix scores worse without it, and the
 * prefix differs between a passage and a question. Getting this wrong is silent:
 * the vectors are still vectors, just worse ones.
 */
const MODELS: Record<string, ModelRecipe> = {
  "Xenova/bge-small-en-v1.5": {
    pooling: "cls",
    query: (text) => `Represent this sentence for searching relevant passages: ${text}`,
    megabytes: 33,
  },
  "Xenova/multilingual-e5-small": {
    pooling: "mean",
    query: (text) => `query: ${text}`,
    document: (text) => `passage: ${text}`,
    megabytes: 129,
  },
};

interface ModelRecipe {
  pooling: "cls" | "mean";
  query?: (text: string) => string;
  document?: (text: string) => string;
  megabytes?: number;
}

/** Where a long wait is coming from, so a caller can say so. */
export type LocalProgress =
  | { phase: "download"; file: string; loaded: number; total: number }
  | { phase: "embed"; done: number; total: number };

export interface LocalEmbedderOptions {
  /** A model id transformers.js can load. Anything outside the known list gets no prefix. */
  model?: string;
  /** Weight precision. `q8` is what the measurements above were taken with. */
  dtype?: "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4";
  /** Texts per forward pass. Bigger is faster until it is slower; 16 was measured. */
  batchSize?: number;
  onProgress?: (progress: LocalProgress) => void;
  /**
   * Where downloaded weights are kept. The default is inside the installed
   * `@huggingface/transformers` package, which means a clean install or a fresh
   * container downloads them again — point this somewhere durable to avoid that.
   */
  cacheDir?: string;
  /**
   * Supply the model instead of loading one. Tests use it so they do not
   * download 33 MB to check that batching counts correctly.
   */
  backend?: EmbeddingBackend;
}

/** The model, reduced to the two things an embedder needs from it. */
export interface EmbeddingBackend {
  countTokens: CountTokens;
  run(texts: string[]): Promise<number[][]>;
}

/**
 * Turns text into vectors on this machine: no API key, no per-document cost,
 * and nothing leaves the process.
 *
 * Loading downloads the model on first use and caches it, so `load()` is async
 * and the constructor is private — `dimensions` and `countTokens` are real
 * values by the time anyone can see them, which is what the `Embedder` contract
 * promises.
 */
export class LocalEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  readonly countTokens: CountTokens;
  readonly #backend: EmbeddingBackend;
  readonly #recipe: ModelRecipe;
  readonly #batchSize: number;
  readonly #onProgress: ((progress: LocalProgress) => void) | undefined;

  private constructor(
    id: string,
    dimensions: number,
    backend: EmbeddingBackend,
    recipe: ModelRecipe,
    options: LocalEmbedderOptions,
  ) {
    this.id = id;
    this.dimensions = dimensions;
    // Called through the backend, not copied off it: a backend written as a
    // class would lose its `this` and either throw or, worse, return undefined,
    // which `chunkDocument` compares against its budget and always finds under.
    // Counted with the document prefix on, because that is the text the model
    // is handed — a budget that measures something shorter gets its tail
    // truncated without a word.
    this.countTokens = (text) => backend.countTokens(recipe.document?.(text) ?? text);
    this.#backend = backend;
    this.#recipe = recipe;
    this.#batchSize = options.batchSize ?? 16;
    this.#onProgress = options.onProgress;
  }

  static async load(options: LocalEmbedderOptions = {}): Promise<LocalEmbedder> {
    const model = options.model ?? DEFAULT_MODEL;
    const recipe = MODELS[model] ?? { pooling: "mean" };
    const backend = options.backend ?? (await openModel(model, recipe, options));

    // The width is asked of the model rather than looked up, so a model swapped
    // for one of another size cannot quietly disagree with the index.
    const [probe] = await backend.run(["dimension probe"]);
    if (probe === undefined || probe.length === 0) {
      throw new Error(`local: ${model} returned no vector for a test input`);
    }

    return new LocalEmbedder(model, probe.length, backend, recipe, options);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const prepared = texts.map((text) => this.#recipe.document?.(text) ?? text);
    const vectors: number[][] = [];

    // A first version embedded each distinct text once and handed the same
    // array back for every copy. Measured on the practice corpus it saved
    // nothing — 1215 chunks, 1215 distinct texts, because each carries its own
    // `page > heading` header — and it meant a caller who scaled one vector in
    // place silently rewrote the others. The cross-run cache is `planUpdate`,
    // which skips parsing and chunking too.
    for (let i = 0; i < prepared.length; i += this.#batchSize) {
      const batch = prepared.slice(i, i + this.#batchSize);
      const embedded = await this.#backend.run(batch);
      if (embedded.length !== batch.length) {
        throw new Error(`local: ${this.id} returned ${embedded.length} vectors for ${batch.length} texts`);
      }
      vectors.push(...embedded);
      this.#onProgress?.({ phase: "embed", done: vectors.length, total: prepared.length });
    }

    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.#backend.run([this.#recipe.query?.(text) ?? text]);
    if (vector === undefined) throw new Error(`local: ${this.id} returned no vector for the query`);
    return vector;
  }
}

/** Download (or find in the cache) the model, and say something useful if it fails. */
async function openModel(
  model: string,
  recipe: ModelRecipe,
  options: LocalEmbedderOptions,
): Promise<EmbeddingBackend> {
  const dtype = options.dtype ?? "q8";
  // transformers.js reads no environment variable for this, so the only way to
  // move the cache is to set it here.
  if (options.cacheDir !== undefined) env.cacheDir = options.cacheDir;
  const progress_callback = options.onProgress
    ? (event: unknown) => {
        const e = event as { status?: string; file?: string; loaded?: number; total?: number };
        if (e.status !== "progress") return;
        options.onProgress?.({
          phase: "download",
          file: e.file ?? model,
          loaded: e.loaded ?? 0,
          total: e.total ?? 0,
        });
      }
    : undefined;

  try {
    const [tokenizer, embed] = await Promise.all([
      AutoTokenizer.from_pretrained(model, { progress_callback }),
      pipeline("feature-extraction", model, { dtype, progress_callback }),
    ]);
    return {
      countTokens: (text) => tokenizer.encode(text).length,
      run: async (texts) => (await embed(texts, { pooling: recipe.pooling, normalize: true })).tolist(),
    };
  } catch (cause) {
    const size = recipe.megabytes === undefined ? "" : ` (about ${recipe.megabytes} MB)`;
    throw new Error(
      `local: could not load the model ${model}${size}. It is downloaded on first use and cached, ` +
        `so this needs network access and disk space the first time. The cache is at ${env.cacheDir}; ` +
        "pass `cacheDir` to put it somewhere that survives a clean install. " +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
