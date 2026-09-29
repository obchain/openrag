// The whole pipeline on package code: load, parse, chunk (counted with the
// embedder's own tokenizer), plan, embed, store, search, fuse. Only the reranker
// still comes from this experiment. Exits non-zero when a claim stops holding.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalEmbedder } from "../../packages/local/dist/index.js";
import {
  chunkDocument,
  embedText,
  fuse,
  FUSION_WEIGHTS,
  loadFiles,
  parseDocument,
  planUpdate,
  SqliteStore,
} from "../../packages/openrag/dist/index.js";
import { norm } from "./lib/corpus.mjs";
import { loadReranker } from "./lib/embed.mjs";

const NAMESPACE = "default";
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

let lastFile = "";
const embedder = await LocalEmbedder.load({
  onProgress: (progress) => {
    if (progress.phase !== "download" || progress.file === lastFile) return;
    lastFile = progress.file;
    console.log(`  downloading ${progress.file}`);
  },
});
console.log(`${embedder.id}, ${embedder.dimensions} dimensions\n`);
check("the model reports the width the measurements were taken at", embedder.dimensions === 384);

// The budget is counted with the tokenizer the model was trained with, which is
// the whole reason the embedder carries one (D-020).
const load = await loadFiles("corpus/plausible");
const chunkOf = (document) =>
  chunkDocument(document, parseDocument(document), { countTokens: embedder.countTokens });

// Every call the store causes is counted, because "did it embed again?" is the
// question the incremental path exists to answer.
let embedCalls = 0;
const embedDocuments = async (texts) => {
  if (texts.length > 0) embedCalls++;
  return embedder.embedDocuments(texts);
};

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrag-"));
const indexFile = path.join(workDir, "index.db");
const store = new SqliteStore({ file: indexFile });

async function sync(documents = load.documents) {
  const plan = planUpdate({ documents, failures: load.failures }, await store.snapshot(NAMESPACE), chunkOf);
  const vectors = await embedDocuments(plan.embed.map((chunk) => embedText(chunk, true)));
  await store.apply(NAMESPACE, {
    upsert: plan.embed.map((chunk, i) => ({ chunk, vector: vectors[i] })),
    restate: plan.restate,
    removeChunks: plan.remove,
    removeDocuments: plan.removedDocuments,
    documents: plan.indexedDocuments,
  });
  return plan;
}

const started = performance.now();
const first = await sync();
const seconds = (performance.now() - started) / 1000;
const perChunk = (seconds * 1000) / first.embed.length;
console.log(`\n${load.documents.length} documents, ${first.embed.length} chunks in ${seconds.toFixed(0)} s`);
console.log(`  ${perChunk.toFixed(0)} ms per chunk (M0 measured 43 s for 1102, so 39 ms)\n`);
// Generous, because this is a laptop CPU and the point is the order of
// magnitude: a chunk costs tens of milliseconds, not seconds.
check("embedding runs at the rate that was measured", perChunk < 120, `${perChunk.toFixed(0)} ms per chunk`);

// Re-embedding an unchanged corpus has to cost nothing. That is not a cache in
// the embedder: `planUpdate` compares fingerprints and hands it an empty list,
// which also skips the parsing and chunking a cache would still pay for.
const callsAfterFirst = embedCalls;
const second = await sync();
check(
  "an unchanged corpus is never embedded twice",
  second.embed.length === 0 && embedCalls === callsAfterFirst,
  `${second.embed.length} chunks, ${embedCalls - callsAfterFirst} extra calls`,
);

// A repeated passage costs one forward pass. Measured here it saves nothing:
// every chunk is embedded under its own `page > heading` header (D-016), so two
// chunks are identical only if their page titles are too. It is insurance for a
// caller that turns headers off, not a win this corpus shows.
const texts = [];
for (const document of load.documents) for (const chunk of chunkOf(document)) texts.push(embedText(chunk, true));
const unique = new Set(texts).size;
console.log(`  ${texts.length} chunks, ${unique} distinct texts`);

// The store was created at this embedder's width, and anything else is loud.
let mismatch = "";
try {
  await store.vectorSearch(NAMESPACE, new Array(768).fill(0.1), 5);
} catch (error) {
  mismatch = error.message;
}
check(
  "a query from a different embedder is refused, not scored",
  mismatch.includes("768") && mismatch.includes("384"),
  mismatch.slice(0, 96),
);

// And the whole thing still retrieves as well as the measurement it replaces.
const reranker = await loadReranker("ms-marco-minilm");
// Two maps, deliberately. The reranker reads the real text; `norm` exists only
// to match evidence phrases, and feeding its output to a model costs accuracy.
const chunkTexts = new Map();
const matchable = new Map();
for (const document of load.documents) {
  for (const chunk of chunkOf(document)) {
    const text = embedText(chunk, true);
    chunkTexts.set(chunk.id, text);
    matchable.set(chunk.id, norm(text));
  }
}
const { questions } = JSON.parse(fs.readFileSync("questions.json", "utf8"));
const answerable = questions.filter((q) => q.evidence);

const rows = [];
for (const question of answerable) {
  const vector = await embedder.embedQuery(question.q);
  const hits = fuse({
    lexical: await store.lexicalSearch(NAMESPACE, question.q, 20),
    vector: await store.vectorSearch(NAMESPACE, vector, 20),
  }, { weights: FUSION_WEIGHTS.withReranker });
  const scores = await reranker.score(
    question.q,
    hits.map((hit) => chunkTexts.get(hit.chunk.id)),
  );
  const ranked = hits.map((hit, i) => ({ chunk: hit.chunk, score: scores[i] })).sort((a, b) => b.score - a.score);
  let rank = null;
  for (let i = 0; i < Math.min(ranked.length, 10); i++) {
    const text = matchable.get(ranked[i].chunk.id) ?? "";
    if (question.evidence.some((evidence) => text.includes(norm(evidence)))) {
      rank = i + 1;
      break;
    }
  }
  rows.push(rank);
}

const pct = (n) => `${((n / rows.length) * 100).toFixed(0)}%`;
const hit1 = rows.filter((r) => r === 1).length;
const hit5 = rows.filter((r) => r && r <= 5).length;
const mrr = rows.reduce((sum, r) => sum + (r ? 1 / r : 0), 0) / rows.length;
console.log(`\n  hit@1 ${pct(hit1)}   hit@5 ${pct(hit5)}   MRR ${mrr.toFixed(2)}      (M0: 79% / 90% / 0.83)`);
check("the package pipeline retrieves as well as the measurement", hit5 / rows.length >= 0.88, pct(hit5));
check("top-1 holds too", hit1 / rows.length >= 0.74, pct(hit1));

store.close();
fs.rmSync(workDir, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
