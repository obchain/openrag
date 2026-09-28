// Run the real corpus through the package store and check it still retrieves as
// well as the M0 measurement did. Exits non-zero when a claim stops holding.
import fs from "node:fs";
import { AutoTokenizer } from "@huggingface/transformers";
import {
  chunkDocument,
  embedText,
  fuse,
  loadFiles,
  MemoryStore,
  parseDocument,
  planUpdate,
} from "../../packages/openrag/dist/index.js";
import { norm } from "./lib/corpus.mjs";
import { loadEmbedder, loadReranker } from "./lib/embed.mjs";

const NAMESPACE = "default"; // what loadFiles stamps on a document by default
const tok = await AutoTokenizer.from_pretrained("Xenova/bge-small-en-v1.5");
const countTokens = (text) => tok.encode(text).length;

const load = await loadFiles("corpus/plausible");
const chunkOf = (document) => chunkDocument(document, parseDocument(document), { countTokens });

const store = new MemoryStore();
const embedder = await loadEmbedder("bge-small-en", { dtype: "q8" });
const reranker = await loadReranker("ms-marco-minilm");

// The whole indexing loop, as a caller would write it: read what the index
// holds, work out the difference, pay for the new text only, write it back.
async function sync() {
  const plan = planUpdate(load, await store.snapshot(NAMESPACE), chunkOf);
  const vectors = await embedder.embedDocs(plan.embed.map((chunk) => embedText(chunk, true)));
  await store.apply(NAMESPACE, {
    upsert: plan.embed.map((chunk, i) => ({ chunk, vector: vectors[i] })),
    restate: plan.restate,
    removeChunks: plan.remove,
    removeDocuments: plan.removedDocuments,
    documents: plan.indexedDocuments,
  });
  return plan;
}

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

let t = performance.now();
const first = await sync();
const seconds = Math.round((performance.now() - t) / 1000);
console.log(`${load.documents.length} documents, ${first.embed.length} chunks embedded in ${seconds} s\n`);

// 1. A second run over unchanged sources must cost nothing.
const second = await sync();
check("an unchanged run embeds nothing", second.embed.length === 0, `${second.embed.length} embedded`);

// 2. The snapshot has to describe exactly what was written, or the next run
//    re-chunks documents it already holds.
const snapshot = await store.snapshot(NAMESPACE);
const held = [...snapshot.chunks.values()].reduce((n, ids) => n + ids.length, 0);
check(
  "snapshot accounts for every document and chunk",
  snapshot.documents.size === load.documents.length && held === first.embed.length,
  `${snapshot.documents.size} documents, ${held} chunks`,
);

// 3. Tenant isolation, on a store that actually holds something.
const other = await store.lexicalSearch("other-tenant", "analytics", 10);
const otherSnapshot = await store.snapshot("other-tenant");
check("another namespace sees nothing", other.length === 0 && otherSnapshot.chunks.size === 0);

// Retrieval, through the package's own search and fusion rather than the
// experiment's copies, so this measures what ships.
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

const rows = [];
for (const question of answerable) {
  const vector = await embedder.embedQuery(question.q);
  const fused = fuse({
    lexical: await store.lexicalSearch(NAMESPACE, question.q, 20),
    vector: await store.vectorSearch(NAMESPACE, vector, 20),
  });
  const scores = await reranker.score(
    question.q,
    fused.map((hit) => chunkTexts.get(hit.chunk.id)),
  );
  const ranked = fused
    .map((hit, i) => ({ chunk: hit.chunk, score: scores[i] }))
    .sort((a, b) => b.score - a.score);
  rows.push({ question, rank: rankOf(ranked, question) });
}

const pct = (n) => `${((n / rows.length) * 100).toFixed(0)}%`;
const hit1 = rows.filter((r) => r.rank === 1).length;
const hit5 = rows.filter((r) => r.rank && r.rank <= 5).length;
const mrr = rows.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / rows.length;

console.log("\n                hit@1  hit@5   MRR");
console.log("MemoryStore    ", pct(hit1).padStart(5), pct(hit5).padStart(6), mrr.toFixed(2).padStart(5));
console.log("M0 SQLite      ", "  79%", "   90%", " 0.83");

// 4. The store is the reference implementation, so it has to retrieve as well as
//    the measured baseline. Its keyword half has no stemming, which is the one
//    place it is allowed to trail SQLite.
check("hit@5 holds at the measured baseline", hit5 / rows.length >= 0.88, pct(hit5));
check("hit@1 holds at the measured baseline", hit1 / rows.length >= 0.74, pct(hit1));

// 5. An edit re-embeds only what changed, and the pieces that merely moved keep
//    their vectors and still come back.
const edited = load.documents[0];
const before = await store.lexicalSearch(NAMESPACE, "analytics", 5);
edited.text = `${edited.text}\n\n## Scratch\n\nA new paragraph about widget calibration.`;
edited.contentHash = `${edited.contentHash}-edited`;
const third = await sync();
check(
  "an edit embeds only the new text",
  third.embed.length > 0 && third.embed.length < 10 && third.restate.length > 0,
  `${third.embed.length} embedded, ${third.restate.length} restated`,
);
const after = await store.lexicalSearch(NAMESPACE, "calibration", 5);
check("the new paragraph is searchable", after.some((hit) => hit.chunk.text.includes("calibration")));
check("the rest of the index survived the edit", before.length === 0 || (await store.lexicalSearch(NAMESPACE, "analytics", 5)).length > 0);

console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
