// Run the real corpus through both package stores and check they still retrieve
// as well as the M0 measurement did. Exits non-zero when a claim stops holding.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutoTokenizer } from "@huggingface/transformers";
import {
  chunkDocument,
  embedText,
  fuse,
  FUSION_WEIGHTS,
  loadFiles,
  MemoryStore,
  parseDocument,
  planUpdate,
  SqliteStore,
} from "../../packages/openrag/dist/index.js";
import { norm } from "./lib/corpus.mjs";
import { loadEmbedder, loadReranker } from "./lib/embed.mjs";

const NAMESPACE = "default"; // what loadFiles stamps on a document by default
const tok = await AutoTokenizer.from_pretrained("Xenova/bge-small-en-v1.5");
const countTokens = (text) => tok.encode(text).length;

const load = await loadFiles("corpus/plausible");
const chunkOf = (document) => chunkDocument(document, parseDocument(document), { countTokens });

const embedder = await loadEmbedder("bge-small-en", { dtype: "q8" });
const reranker = await loadReranker("ms-marco-minilm");

// Embedding is the slow part, and both stores are fed exactly the same vectors,
// so a text is only ever paid for once.
const vectors = new Map();
async function embedAll(texts) {
  const missing = texts.filter((text) => !vectors.has(text));
  if (missing.length > 0) {
    const fresh = await embedder.embedDocs(missing);
    missing.forEach((text, i) => vectors.set(text, fresh[i]));
  }
  return texts.map((text) => vectors.get(text));
}

const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/** The whole indexing loop, as a caller would write it. */
async function sync(store, documents = load.documents, readFailures = load.failures) {
  const plan = planUpdate({ documents, failures: readFailures }, await store.snapshot(NAMESPACE), chunkOf);
  const embedded = await embedAll(plan.embed.map((chunk) => embedText(chunk, true)));
  await store.apply(NAMESPACE, {
    upsert: plan.embed.map((chunk, i) => ({ chunk, vector: embedded[i] })),
    restate: plan.restate,
    removeChunks: plan.remove,
    removeDocuments: plan.removedDocuments,
    documents: plan.indexedDocuments,
  });
  return plan;
}

// The text each chunk is matched by, for scoring evidence against retrieved hits.
const chunkTexts = new Map();
for (const document of load.documents) {
  for (const chunk of chunkOf(document)) chunkTexts.set(chunk.id, embedText(chunk, true));
}
const matchable = new Map([...chunkTexts].map(([id, text]) => [id, norm(text)]));
const { questions } = JSON.parse(fs.readFileSync("questions.json", "utf8"));
const answerable = questions.filter((q) => q.evidence);

const rankOf = (hits, question) => {
  for (let i = 0; i < Math.min(hits.length, 10); i++) {
    const text = matchable.get(hits[i].chunk.id) ?? "";
    if (question.evidence.some((evidence) => text.includes(norm(evidence)))) return i + 1;
  }
  return null;
};

/** Retrieve every question through the package's own search and fusion. */
async function measure(store) {
  const rows = [];
  for (const question of answerable) {
    const vector = await embedder.embedQuery(question.q);
    const fused = fuse({
      lexical: await store.lexicalSearch(NAMESPACE, question.q, 20),
      vector: await store.vectorSearch(NAMESPACE, vector, 20),
    }, { weights: FUSION_WEIGHTS.withReranker });
    const scores = await reranker.score(
      question.q,
      fused.map((hit) => chunkTexts.get(hit.chunk.id)),
    );
    const ranked = fused
      .map((hit, i) => ({ chunk: hit.chunk, score: scores[i] }))
      .sort((a, b) => b.score - a.score);
    rows.push({ question, rank: rankOf(ranked, question) });
  }
  return {
    hit1: rows.filter((r) => r.rank === 1).length / rows.length,
    hit5: rows.filter((r) => r.rank && r.rank <= 5).length / rows.length,
    mrr: rows.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / rows.length,
  };
}

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const results = {};

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrag-"));
const indexFile = path.join(workDir, "index.db");

for (const [name, open] of [
  ["MemoryStore", () => new MemoryStore()],
  ["SqliteStore", () => new SqliteStore({ file: indexFile })],
]) {
  console.log(`\n${name}`);
  const store = open();

  const cached = vectors.size > 0;
  const started = performance.now();
  const first = await sync(store);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  // The second store is fed the vectors the first one paid for, so its time is
  // the write itself rather than the embedding that dominates a real run.
  const what = cached ? "written (vectors already embedded)" : "indexed";
  console.log(`  ${load.documents.length} documents, ${first.embed.length} chunks ${what} in ${seconds} s`);

  check("an unchanged run embeds nothing", (await sync(store)).embed.length === 0);

  const snapshot = await store.snapshot(NAMESPACE);
  const held = [...snapshot.chunks.values()].reduce((n, ids) => n + ids.length, 0);
  check(
    "snapshot accounts for every document and chunk",
    snapshot.documents.size === load.documents.length && held === first.embed.length,
    `${snapshot.documents.size} documents, ${held} chunks`,
  );

  const other = await store.lexicalSearch("other-tenant", "analytics", 10);
  check("another namespace sees nothing", other.length === 0 && (await store.snapshot("other-tenant")).chunks.size === 0);

  results[name] = await measure(store);
  const { hit1, hit5, mrr } = results[name];
  console.log(`  hit@1 ${pct(hit1)}   hit@5 ${pct(hit5)}   MRR ${mrr.toFixed(2)}      (M0: 79% / 90% / 0.83)`);
  check("hit@5 holds at the measured baseline", hit5 >= 0.88, pct(hit5));
  check("hit@1 holds at the measured baseline", hit1 >= 0.74, pct(hit1));

  // An edit re-embeds only what changed; everything else keeps its vector.
  const edited = { ...load.documents[0] };
  edited.text = `${edited.text}\n\n## Scratch\n\nA new paragraph about widget calibration.`;
  edited.contentHash = `${edited.contentHash}-edited`;
  const third = await sync(store, [edited, ...load.documents.slice(1)]);
  check(
    "an edit embeds only the new text",
    third.embed.length > 0 && third.embed.length < 10 && third.restate.length > 0,
    `${third.embed.length} embedded, ${third.restate.length} restated`,
  );
  check(
    "the new paragraph is searchable",
    (await store.lexicalSearch(NAMESPACE, "calibration", 5)).some((hit) => hit.chunk.text.includes("calibration")),
  );
  check("the rest of the index survived the edit", (await store.lexicalSearch(NAMESPACE, "analytics", 5)).length > 0);

  if (store.close) store.close();
}

// The file has to be worth keeping: the same answers from a cold open, no
// re-indexing, and a size in the range section 3 of RESULTS.md recorded.
console.log("\nSqliteStore, reopened");
const reopened = new SqliteStore({ file: indexFile });
const before = (await sync(reopened)).embed.length;
check("reopening embeds nothing", before === 0, `${before} embedded`);
const again = await measure(reopened);
check(
  "reopening returns the same rankings",
  again.hit1 === results.SqliteStore.hit1 && again.hit5 === results.SqliteStore.hit5,
  `hit@1 ${pct(again.hit1)}, hit@5 ${pct(again.hit5)}`,
);
reopened.close();

const megabytes = fs.statSync(indexFile).size / 1e6;
console.log(`  index file ${megabytes.toFixed(1)} MB (M0 measured 4.3 MB for 1102 chunks)`);
check("the index file stays small", megabytes < 10, `${megabytes.toFixed(1)} MB`);

// The two stores are interchangeable, which is the whole point of the interface.
console.log("\nboth stores");
check(
  "the two stores retrieve alike",
  Math.abs(results.MemoryStore.hit5 - results.SqliteStore.hit5) <= 0.04,
  `hit@5 ${pct(results.MemoryStore.hit5)} vs ${pct(results.SqliteStore.hit5)}`,
);

fs.rmSync(workDir, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
