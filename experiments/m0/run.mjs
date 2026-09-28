// M0 experiments. Usage:
//   node run.mjs A                                  chunkers (bge-small-en, sqlite)
//   node run.mjs B [chunker]                        embedders + rerankers
//   node run.mjs C [embedder] [chunker]             sqlite vs orama
//   node run.mjs D [embedder] [chunker] [reranker]  abstain signal
import fs from "node:fs";
import { loadCorpus, norm } from "./lib/corpus.mjs";
import { CHUNKERS } from "./lib/chunk.mjs";
import { EMBEDDERS, loadEmbedder, loadReranker } from "./lib/embed.mjs";
import { sqliteStore, oramaStore, rrf } from "./lib/stores.mjs";

const [phase = "A", ...args] = process.argv.slice(2);
const docs = loadCorpus("corpus/plausible");
const { questions } = JSON.parse(fs.readFileSync("questions.json", "utf8"));
const TYPES = ["exact", "paraphrase", "hinglish"];
fs.mkdirSync("results/cache", { recursive: true });

const log = (...a) => console.log(...a);
const pct = (x) => `${Math.round(x * 100)}%`.padStart(5);

// ---------- indexes (embeddings cached on disk) ----------
const embedders = new Map();
async function embedder(name) {
  if (!embedders.has(name)) {
    let e;
    for (const dtype of ["q8", "q4"]) { // no fp32 fallback: large downloads
      try {
        e = await loadEmbedder(name, { dtype });
        await e.embedQuery("warm up");
        e.dtype = dtype;
        break;
      } catch (err) {
        log(`  ${name} with ${dtype} failed: ${String(err.message).split("\n")[0]}`);
      }
    }
    embedders.set(name, e);
  }
  return embedders.get(name);
}

async function index(embName, chunkName) {
  const chunks = CHUNKERS[chunkName](docs);
  const f = `results/cache/${embName}__${chunkName}.json`;
  let cached = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  if (!cached) {
    const e = await embedder(embName);
    const t = performance.now();
    const vecs = await e.embedDocs(chunks.map((c) => c.embedText));
    cached = { vecs, embedMs: performance.now() - t, dtype: e.dtype };
    fs.writeFileSync(f, JSON.stringify(cached));
  }
  const match = chunks.map((c) => norm(`${c.path.join(" ")}\n${c.text}`));
  return { chunks, match, ...cached };
}

const qvecCache = new Map();
async function qvec(embName, q) {
  const key = `${embName}::${q}`;
  if (!qvecCache.has(key)) qvecCache.set(key, await (await embedder(embName)).embedQuery(q));
  return qvecCache.get(key);
}

// ---------- scoring ----------
const rankOf = (list, q, match) => {
  for (let i = 0; i < Math.min(list.length, 10); i++) if (q.evidence.some((e) => match[list[i].idx].includes(norm(e)))) return i + 1;
  return null;
};

function summarize(rows) {
  const ans = rows.filter((r) => r.q.evidence);
  const stat = (rs) => ({
    n: rs.length,
    hit1: rs.filter((r) => r.rank === 1).length / rs.length,
    hit5: rs.filter((r) => r.rank && r.rank <= 5).length / rs.length,
    mrr: rs.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rs.length,
  });
  const out = { all: stat(ans) };
  for (const t of TYPES) out[t] = stat(ans.filter((r) => r.q.type === t));
  out.missed = ans.filter((r) => !r.rank || r.rank > 5).map((r) => r.q.id);
  return out;
}

async function evaluate({ embName, chunkName, store, reranker, idx }) {
  const modes = { keyword: [], vector: [], hybrid: [], ...(reranker ? { "hybrid+rerank": [] } : {}) };
  const signals = [];
  for (const q of questions) {
    const qv = await qvec(embName, q.q);
    const kw = await store.keyword(q.q, 20);
    const vec = await store.vector(qv, 20);
    const hyb = rrf([kw, vec]).slice(0, 20);
    const lists = { keyword: kw, vector: vec, hybrid: hyb };
    let topRerank = null;
    if (reranker) {
      const s = await reranker.score(q.q, hyb.map((h) => idx.chunks[h.idx].embedText));
      lists["hybrid+rerank"] = hyb.map((h, i) => ({ idx: h.idx, score: s[i] })).sort((a, b) => b.score - a.score);
      topRerank = lists["hybrid+rerank"][0]?.score ?? null;
    }
    for (const m of Object.keys(modes)) modes[m].push({ q, rank: q.evidence ? rankOf(lists[m], q, idx.match) : null });
    signals.push({ id: q.id, type: q.type, answerable: !!q.evidence, topVector: vec[0]?.score ?? 0, topRerank });
  }
  return { modes: Object.fromEntries(Object.entries(modes).map(([m, rows]) => [m, summarize(rows)])), signals };
}

const table = (title, rows) => {
  log(`\n${title}`);
  log(`${"".padEnd(34)}  hit@1  hit@5    MRR │ exact paraph hingl`);
  for (const [label, s] of rows)
    log(`${label.padEnd(34)}  ${pct(s.all.hit1)}  ${pct(s.all.hit5)}  ${s.all.mrr.toFixed(2).padStart(5)} │ ${pct(s.exact.hit5)} ${pct(s.paraphrase.hit5)} ${pct(s.hinglish.hit5)}`);
};

const save = (name, data) => fs.writeFileSync(`results/phase-${name}.json`, JSON.stringify(data, null, 1));

// ---------- phases ----------
if (phase === "A") {
  const embName = "bge-small-en";
  const reranker = await loadReranker("ms-marco-minilm");
  const out = {};
  const rows = [];
  for (const chunkName of Object.keys(CHUNKERS)) {
    const idx = await index(embName, chunkName);
    const store = sqliteStore(idx.chunks, idx.vecs);
    const r = await evaluate({ embName, chunkName, store, reranker, idx });
    out[chunkName] = { pieces: idx.chunks.length, embedMs: Math.round(idx.embedMs), ...r.modes };
    for (const [m, s] of Object.entries(r.modes)) rows.push([`${chunkName} · ${m}`, s]);
    log(`${chunkName}: ${idx.chunks.length} pieces, embedded in ${(idx.embedMs / 1000).toFixed(1)} s`);
  }
  table("Phase A: chunkers (embedder bge-small-en, store sqlite, reranker ms-marco)", rows);
  save("A", out);
}

if (phase === "B") {
  const chunkName = args[0] ?? "heading-256";
  const rerankers = [await loadReranker("ms-marco-minilm"), await loadReranker("bge-reranker-base")];
  const out = {};
  const rows = [];
  const embList = (process.env.EMBEDDERS ?? Object.keys(EMBEDDERS).join(",")).split(",");
  for (const embName of embList) {
    const idx = await index(embName, chunkName);
    const store = sqliteStore(idx.chunks, idx.vecs);
    out[embName] = { dtype: idx.dtype, embedMs: Math.round(idx.embedMs) };
    for (const rr of rerankers) {
      const r = await evaluate({ embName, chunkName, store, reranker: rr, idx });
      out[embName][rr.name] = r.modes;
      for (const m of ["vector", "hybrid", "hybrid+rerank"]) {
        if (m !== "hybrid+rerank" && rr !== rerankers[0]) continue;
        rows.push([`${embName} · ${m === "hybrid+rerank" ? `rerank ${rr.name}` : m}`, r.modes[m]]);
      }
    }
    log(`${embName} (${idx.dtype}): embedded ${idx.chunks.length} pieces in ${(idx.embedMs / 1000).toFixed(1)} s`);
  }
  table(`Phase B: embedders + rerankers (chunker ${chunkName}, store sqlite)`, rows);
  save("B", out);
}

if (phase === "C") {
  const embName = args[0] ?? "bge-small-en";
  const chunkName = args[1] ?? "heading-256";
  const idx = await index(embName, chunkName);
  const out = {};
  const rows = [];
  for (const make of [
    async () => sqliteStore(idx.chunks, idx.vecs, { file: "results/store-test.sqlite" }),
    async () => oramaStore(idx.chunks, idx.vecs),
  ]) {
    let t = performance.now();
    const store = await make();
    const buildMs = performance.now() - t;
    const r = await evaluate({ embName, chunkName, store, idx });
    const lat = { keyword: [], vector: [] };
    for (const q of questions) {
      const qv = await qvec(embName, q.q);
      t = performance.now(); await store.keyword(q.q, 20); lat.keyword.push(performance.now() - t);
      t = performance.now(); await store.vector(qv, 20); lat.vector.push(performance.now() - t);
    }
    const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
    let native = null;
    if (store.hybridNative) {
      const rows2 = [];
      for (const q of questions) rows2.push({ q, rank: q.evidence ? rankOf(await store.hybridNative(q.q, await qvec(embName, q.q), 20), q, idx.match) : null });
      native = summarize(rows2);
      rows.push([`${store.name} · native hybrid`, native]);
    }
    out[store.name] = { buildMs: Math.round(buildMs), sizeBytes: await store.sizeBytes(), medianMs: { keyword: med(lat.keyword), vector: med(lat.vector) }, ...r.modes, native };
    for (const m of ["keyword", "vector", "hybrid"]) rows.push([`${store.name} · ${m}`, r.modes[m]]);
    log(`${store.name}: build ${Math.round(buildMs)} ms, size ${((await store.sizeBytes()) / 1e6).toFixed(1)} MB, median query keyword ${med(lat.keyword).toFixed(2)} ms / vector ${med(lat.vector).toFixed(2)} ms`);
    store.close();
  }
  table(`Phase C: stores (embedder ${embName}, chunker ${chunkName})`, rows);
  save("C", out);
}

if (phase === "D") {
  const embName = args[0] ?? "bge-small-en";
  const chunkName = args[1] ?? "heading-256";
  const reranker = await loadReranker(args[2] ?? "ms-marco-minilm");
  const idx = await index(embName, chunkName);
  const store = sqliteStore(idx.chunks, idx.vecs);
  const { signals } = await evaluate({ embName, chunkName, store, reranker, idx });
  const out = {};
  for (const key of ["topVector", "topRerank"]) {
    const pos = signals.filter((s) => s.answerable).map((s) => s[key]);
    const neg = signals.filter((s) => !s.answerable).map((s) => s[key]);
    const cands = [...pos, ...neg].sort((a, b) => a - b);
    let best = null;
    for (const th of cands) {
      // abstain when score < th
      const tpr = neg.filter((x) => x < th).length / neg.length; // unanswerable correctly refused
      const tnr = pos.filter((x) => x >= th).length / pos.length; // answerable correctly kept
      const bal = (tpr + tnr) / 2;
      if (!best || bal > best.bal) best = { th, bal, refusedUnanswerable: tpr, keptAnswerable: tnr };
    }
    const f = (a) => a.sort((x, y) => x - y);
    out[key] = { best, answerable: f(pos), unanswerable: f(neg) };
    // conservative gate: highest cut-off that still keeps >= 95% of answerable questions
    const keep95 = f([...pos])[Math.floor(pos.length * 0.05)];
    const safe = { th: keep95, refusedUnanswerable: neg.filter((x) => x < keep95).length / neg.length, keptAnswerable: pos.filter((x) => x >= keep95).length / pos.length };
    out[key].safe = safe;
    log(`  ${key} safe cut-off ${keep95.toFixed(2)}: keeps ${pct(safe.keptAnswerable)} of answerable, refuses ${pct(safe.refusedUnanswerable)} of unanswerable`);
    const m = (a) => a[a.length >> 1].toFixed(2);
    log(`${key}: answerable median ${m(pos)} (min ${Math.min(...pos).toFixed(2)}), unanswerable median ${m(neg)} (max ${Math.max(...neg).toFixed(2)}) → best cut-off ${best.th.toFixed(2)}: refuses ${pct(best.refusedUnanswerable)} of unanswerable, keeps ${pct(best.keptAnswerable)} of answerable`);
  }
  out.signals = signals;
  save(`D-${embName}`, out);
}
