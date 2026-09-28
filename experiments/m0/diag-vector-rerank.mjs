// Close the loop: rerank over meaning-only candidates, vs the other pipelines.
import fs from "node:fs";
import { loadCorpus, norm } from "./lib/corpus.mjs";
import { CHUNKERS } from "./lib/chunk.mjs";
import { loadEmbedder, loadReranker } from "./lib/embed.mjs";
import { sqliteStore } from "./lib/stores.mjs";

const chunks = CHUNKERS["heading-256"](loadCorpus("corpus/plausible"));
const match = chunks.map((c) => norm(`${c.path.join(" ")}\n${c.text}`));
const qs = JSON.parse(fs.readFileSync("questions.json", "utf8")).questions.filter((q) => q.evidence);
const TYPES = ["exact", "paraphrase", "hinglish"];
const wrrf = (kw, vec, wk, wv, k = 60) => {
  const m = new Map();
  kw.forEach((h, r) => m.set(h.idx, (m.get(h.idx) ?? 0) + wk / (k + r + 1)));
  vec.forEach((h, r) => m.set(h.idx, (m.get(h.idx) ?? 0) + wv / (k + r + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([idx]) => ({ idx }));
};
const rankOf = (list, q) => { for (let i = 0; i < Math.min(list.length, 10); i++) if (q.evidence.some((e) => match[list[i].idx].includes(norm(e)))) return i + 1; return null; };
const pct = (x) => `${Math.round(x * 100)}%`.padStart(5);
const stat = (r) => ({ hit1: r.filter((x) => x.rank === 1).length / r.length, hit5: r.filter((x) => x.rank && x.rank <= 5).length / r.length, mrr: r.reduce((s, x) => s + (x.rank ? 1 / x.rank : 0), 0) / r.length });
const row = (l, r) => { const a = stat(r); console.log(`${l.padEnd(34)}  ${pct(a.hit1)}  ${pct(a.hit5)}  ${a.mrr.toFixed(2).padStart(5)} │ ${TYPES.map((t) => pct(stat(r.filter((x) => x.q.type === t)).hit5)).join(" ")}`); };

const rr = await loadReranker("ms-marco-minilm", { dtype: "q8" });
for (const embName of ["bge-small-en", "embeddinggemma-300m"]) {
  const { vecs } = JSON.parse(fs.readFileSync(`results/cache/${embName}__heading-256.json`, "utf8"));
  const store = sqliteStore(chunks, vecs);
  const emb = await loadEmbedder(embName, { dtype: "q8" });
  const L = [];
  for (const q of qs) L.push({ q, kw: store.keyword(q.q, 20), vec: store.vector(await emb.embedQuery(q.q), 20) });
  const rerank = async (pick) => {
    const out = [];
    for (const l of L) {
      const cands = pick(l).slice(0, 20);
      const sc = await rr.score(l.q.q, cands.map((h) => chunks[h.idx].embedText));
      out.push({ q: l.q, rank: rankOf(cands.map((h, i) => ({ idx: h.idx, s: sc[i] })).sort((a, b) => b.s - a.s), l.q) });
    }
    return out;
  };
  console.log(`\n${embName}`);
  console.log(`${"".padEnd(34)}  hit@1  hit@5    MRR │ exact paraph hingl`);
  row("meaning only", L.map((l) => ({ q: l.q, rank: rankOf(l.vec, l.q) })));
  row("meaning only + rerank", await rerank((l) => l.vec));
  row("mix 0.1:1 + rerank", await rerank((l) => wrrf(l.kw, l.vec, 0.1, 1)));
  row("mix 1:1 + rerank", await rerank((l) => wrrf(l.kw, l.vec, 1, 1)));
  store.close();
}
