// Local embedders (ONNX via transformers.js) and a local cross-encoder reranker.
import { pipeline, AutoTokenizer, AutoModel, AutoModelForSequenceClassification } from "@huggingface/transformers";

export const EMBEDDERS = {
  "bge-small-en": {
    model: "Xenova/bge-small-en-v1.5",
    pooling: "cls",
    query: (s) => `Represent this sentence for searching relevant passages: ${s}`,
    doc: (s) => s,
  },
  "e5-small-multilingual": {
    model: "Xenova/multilingual-e5-small",
    pooling: "mean",
    query: (s) => `query: ${s}`,
    doc: (s) => `passage: ${s}`,
  },
  "embeddinggemma-300m": {
    model: "onnx-community/embeddinggemma-300m-ONNX",
    sentenceEmbedding: true,
    query: (s) => `task: search result | query: ${s}`,
    doc: (s) => `title: none | text: ${s}`,
  },
};

const l2 = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};

export async function loadEmbedder(name, { dtype = "q8", batch = 16 } = {}) {
  const cfg = EMBEDDERS[name];
  let run;
  if (cfg.sentenceEmbedding) {
    const tok = await AutoTokenizer.from_pretrained(cfg.model);
    const model = await AutoModel.from_pretrained(cfg.model, { dtype });
    run = async (texts) => {
      const inputs = await tok(texts, { padding: true, truncation: true, max_length: 1024 });
      const { sentence_embedding } = await model(inputs);
      return sentence_embedding.tolist().map(l2);
    };
  } else {
    const pipe = await pipeline("feature-extraction", cfg.model, { dtype });
    run = async (texts) => (await pipe(texts, { pooling: cfg.pooling, normalize: true })).tolist();
  }
  const embedMany = async (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += batch) out.push(...(await run(texts.slice(i, i + batch))));
    return out;
  };
  return {
    name,
    embedDocs: (texts) => embedMany(texts.map(cfg.doc)),
    embedQuery: async (q) => (await run([cfg.query(q)]))[0],
  };
}

export const RERANKERS = {
  "ms-marco-minilm": "Xenova/ms-marco-MiniLM-L-6-v2",
  "bge-reranker-base": "Xenova/bge-reranker-base",
};

export async function loadReranker(name, { dtype = "q8" } = {}) {
  const id = RERANKERS[name];
  const tok = await AutoTokenizer.from_pretrained(id);
  const model = await AutoModelForSequenceClassification.from_pretrained(id, { dtype });
  return {
    name,
    // returns one relevance score per text, same order
    score: async (query, texts) => {
      const scores = [];
      for (let i = 0; i < texts.length; i += 8) {
        const part = texts.slice(i, i + 8);
        const inputs = tok(new Array(part.length).fill(query), { text_pair: part, padding: true, truncation: true, max_length: 512 });
        const { logits } = await model(inputs);
        scores.push(...logits.tolist().map((r) => r[0]));
      }
      return scores;
    },
  };
}
