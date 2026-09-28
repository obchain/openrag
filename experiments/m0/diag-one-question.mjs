// Show, for one question, what each search actually returns and how RRF mixes them.
import fs from "node:fs";
import { loadCorpus, norm } from "./lib/corpus.mjs";
import { CHUNKERS } from "./lib/chunk.mjs";
import { loadEmbedder, loadReranker } from "./lib/embed.mjs";
import { sqliteStore, rrf } from "./lib/stores.mjs";

const docs = loadCorpus("corpus/plausible");
const chunks = CHUNKERS["heading-256"](docs);
const { vecs } = JSON.parse(fs.readFileSync("results/cache/bge-small-en__heading-256.json", "utf8"));
const store = sqliteStore(chunks, vecs);
const emb = await loadEmbedder("bge-small-en", { dtype: "q8" });
const rr = await loadReranker("ms-marco-minilm", { dtype: "q8" });
const match = chunks.map((c) => norm(`${c.path.join(" ")}\n${c.text}`));
const qs = JSON.parse(fs.readFileSync("questions.json", "utf8")).questions;

const label = (i) => `${chunks[i].docId} › ${chunks[i].path.join(" › ") || "(top)"}`.slice(0, 68);
const mark = (i, q) => (q.evidence?.some((e) => match[i].includes(norm(e))) ? "✅" : "  ");

for (const id of ["P04", "E01"]) {
  const q = qs.find((x) => x.id === id);
  const qv = await emb.embedQuery(q.q);
  const kw = store.keyword(q.q, 20);
  const vec = store.vector(qv, 20);
  const hyb = rrf([kw, vec]).slice(0, 20);
  const sc = await rr.score(q.q, hyb.map((h) => chunks[h.idx].embedText));
  const rrk = hyb.map((h, i) => ({ idx: h.idx, score: sc[i] })).sort((a, b) => b.score - a.score);
  console.log(`\n================ ${id}: "${q.q}"`);
  for (const [name, list] of [["KEYWORD", kw], ["MEANING", vec], ["HYBRID (RRF)", hyb], ["AFTER RERANK", rrk]]) {
    console.log(`  ${name}`);
    list.slice(0, 5).forEach((h, r) => console.log(`   ${r + 1}. ${mark(h.idx, q)} ${label(h.idx)}  [score ${h.score.toFixed(3)}]`));
  }
}
