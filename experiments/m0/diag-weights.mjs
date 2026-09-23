// Raasta B: does a vector-heavy weighted RRF fix what equal-weight RRF broke?
import fs from "node:fs";
import { loadCorpus, norm } from "./lib/corpus.mjs";
import { CHUNKERS } from "./lib/chunk.mjs";
import { loadEmbedder, loadReranker } from "./lib/embed.mjs";
import { sqliteStore } from "./lib/stores.mjs";

const chunkName = "heading-256";
const chunks = CHUNKERS[chunkName](loadCorpus("corpus/plausible"));
const match = chunks.map((c) => norm(`${c.path.join(" ")}\n${c.text}`));
const qs = JSON.parse(fs.readFileSync("questions.json", "utf8")).questions;
const ans = qs.filter((q) => q.evidence);
const TYPES = ["exact", "paraphrase", "hinglish"];

const wrrf = (kw, vec, wk, wv, k = 60) => {
  const m = new Map();
  kw.forEach((h, r) => m.set(h.idx, (m.get(h.idx) ?? 0) + wk / (k + r + 1)));
  vec.forEach((h, r) => m.set(h.idx, (m.get(h.idx) ?? 0) + wv / (k + r + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([idx, score]) => ({ idx, score }));
};
const rankOf = (list, q) => {
  for (let i = 0; i < Math.min(list.length, 10); i++) if (q.evidence.some((e) => match[list[i].idx].includes(norm(e)))) return i + 1;
  return null;
};
const pct = (x) => `${Math.round(x * 100)}%`.padStart(5);
const stat = (ranks) => ({
  hit1: ranks.filter((r) => r.rank === 1).length / ranks.length,
  hit5: ranks.filter((r) => r.rank && r.rank <= 5).length / ranks.length,
  mrr: ranks.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / ranks.length,
});
const row = (label, ranks) => {
  const a = stat(ranks);
  const t = TYPES.map((t) => pct(stat(ranks.filter((r) => r.q.type === t)).hit5)).join(" ");
  console.log(`${label.padEnd(30)}  ${pct(a.hit1)}  ${pct(a.hit5)}  ${a.mrr.toFixed(2).padStart(5)} │ ${t}`);
};

const rr = await loadReranker("ms-marco-minilm", { dtype: "q8" });
for (const embName of ["bge-small-en", "embeddinggemma-300m"]) {
  const { vecs } = JSON.parse(fs.readFileSync(`results/cache/${embName}__${chunkName}.json`, "utf8"));
  const store = sqliteStore(chunks, vecs);
  const emb = await loadEmbedder(embName, { dtype: "q8" });
  const lists = [];
  for (const q of qs) lists.push({ q, kw: store.keyword(q.q, 20), vec: store.vector(await emb.embedQuery(q.q), 20) });

  console.log(`\n${embName} (chunker ${chunkName})`);
  console.log(`${"".padEnd(30)}  hit@1  hit@5    MRR │ exact paraph hingl`);
  row("keyword only", lists.filter((l) => l.q.evidence).map((l) => ({ q: l.q, rank: rankOf(l.kw, l.q) })));
  row("meaning only", lists.filter((l) => l.q.evidence).map((l) => ({ q: l.q, rank: rankOf(l.vec, l.q) })));
  const weights = [[1, 1], [0.5, 1], [0.3, 1], [0.2, 1], [0.1, 1]];
  let best = null;
  for (const [wk, wv] of weights) {
    const ranks = lists.filter((l) => l.q.evidence).map((l) => ({ q: l.q, rank: rankOf(wrrf(l.kw, l.vec, wk, wv), l.q) }));
    row(`mix keyword ${wk} : meaning ${wv}`, ranks);
    const s = stat(ranks);
    if (!best || s.mrr > best.mrr) best = { wk, wv, ...s };
  }
  // does reranking still help on top of the best weighting?
  const ranks = [];
  for (const l of lists.filter((x) => x.q.evidence)) {
    const fused = wrrf(l.kw, l.vec, best.wk, best.wv).slice(0, 20);
    const sc = await rr.score(l.q.q, fused.map((h) => chunks[h.idx].embedText));
    ranks.push({ q: l.q, rank: rankOf(fused.map((h, i) => ({ idx: h.idx, score: sc[i] })).sort((a, b) => b.score - a.score), l.q) });
  }
  row(`best mix (${best.wk}:${best.wv}) + rerank`, ranks);
  store.close();
}
