// Re-run the M0 retrieval measurement with the package chunker. Throwaway.
import fs from "node:fs";
import { AutoTokenizer } from "@huggingface/transformers";
import {
  loadFiles,
  parseMarkdown,
  parseHtml,
  chunkDocument,
  embedText,
  DEFAULT_MAX_TOKENS,
} from "../../packages/openrag/dist/index.js";
import { norm } from "./lib/corpus.mjs";
import { loadEmbedder, loadReranker } from "./lib/embed.mjs";
import { sqliteStore, rrf } from "./lib/stores.mjs";

const tok = await AutoTokenizer.from_pretrained("Xenova/bge-small-en-v1.5");
const countTokens = (text) => tok.encode(text).length;

const { documents } = await loadFiles("corpus/plausible");
const chunks = [];
for (const d of documents) {
  // Same sniff as scripts/try.mjs: the default include list accepts html too.
  const parsed = /^\s*</.test(d.text) ? parseHtml(d.text, { url: d.uri }) : parseMarkdown(d.text);
  chunks.push(...chunkDocument(d, parsed, { countTokens }));
}
console.log(`${chunks.length} chunks (run \`pnpm build\` first: this reads the built package)`);

// The headline claim of section 6, checked rather than described. One pass, and
// the budget comes from the package so changing it cannot leave this behind.
const texts = chunks.map((c) => embedText(c, true));
let largest = 0;
let over = 0;
for (const text of texts) {
  const tokens = countTokens(text);
  if (tokens > largest) largest = tokens;
  if (tokens > DEFAULT_MAX_TOKENS) over++;
}
console.log(`largest chunk ${largest} tokens, over budget: ${over}`);
if (over > 0) {
  console.error(`FAIL: ${over} chunks are over the ${DEFAULT_MAX_TOKENS} token budget`);
  process.exit(1); // the retrieval numbers below would be measured on invalid chunks
}

const embedder = await loadEmbedder("bge-small-en", { dtype: "q8" });
const reranker = await loadReranker("ms-marco-minilm");
let t = performance.now();
const vecs = await embedder.embedDocs(texts);
console.log(`embedded in ${Math.round((performance.now() - t) / 1000)} s`);

const store = sqliteStore(texts.map((text) => ({ embedText: text })), vecs);
const match = chunks.map((c) => norm(`${[c.title, ...c.headingPath].join(" ")}\n${c.text}`));
const { questions } = JSON.parse(fs.readFileSync("questions.json", "utf8"));

const rankOf = (list, q) => {
  for (let i = 0; i < Math.min(list.length, 10); i++)
    if (q.evidence.some((e) => match[list[i].idx].includes(norm(e)))) return i + 1;
  return null;
};

const rows = [];
for (const q of questions) {
  if (!q.evidence) continue;
  const qv = await embedder.embedQuery(q.q);
  const hyb = rrf([await store.keyword(q.q, 20), await store.vector(qv, 20)]).slice(0, 20);
  const scores = await reranker.score(q.q, hyb.map((h) => texts[h.idx]));
  const ranked = hyb.map((h, i) => ({ idx: h.idx, score: scores[i] })).sort((a, b) => b.score - a.score);
  rows.push({ q, rank: rankOf(ranked, q) });
}

const stat = (rs) => ({
  hit1: (rs.filter((r) => r.rank === 1).length / rs.length * 100).toFixed(0) + "%",
  hit5: (rs.filter((r) => r.rank && r.rank <= 5).length / rs.length * 100).toFixed(0) + "%",
  mrr: (rs.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rs.length).toFixed(2),
});
console.log("\n                 hit@1  hit@5   MRR");
const all = stat(rows);
console.log("package chunker ", all.hit1.padStart(5), all.hit5.padStart(6), all.mrr.padStart(5));
console.log("M0 heading-256  ", "  74%", "   90%", " 0.81");
for (const type of ["exact", "paraphrase", "hinglish"]) {
  const s = stat(rows.filter((r) => r.q.type === type));
  console.log(`  ${type.padEnd(14)}`, s.hit1.padStart(5), s.hit5.padStart(6), s.mrr.padStart(5));
}
console.log("missed:", rows.filter((r) => !r.rank || r.rank > 5).map((r) => r.q.id).join(", "));
