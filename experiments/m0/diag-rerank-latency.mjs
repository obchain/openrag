// How long does reranking 20 candidates take per question on this CPU?
import fs from "node:fs";
import { loadCorpus } from "./lib/corpus.mjs";
import { CHUNKERS } from "./lib/chunk.mjs";
import { loadReranker } from "./lib/embed.mjs";
const chunks = CHUNKERS["heading-256"](loadCorpus("corpus/plausible"));
const qs = JSON.parse(fs.readFileSync("questions.json", "utf8")).questions;
const rr = await loadReranker("ms-marco-minilm");
await rr.score("warm up", [chunks[0].embedText]);
const times = [];
for (const [i, q] of qs.entries()) {
  const cands = Array.from({ length: 20 }, (_, k) => chunks[(i * 37 + k * 53) % chunks.length].embedText);
  const t = performance.now();
  await rr.score(q.q, cands);
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(`rerank 20 candidates: median ${Math.round(times[times.length >> 1])} ms, p90 ${Math.round(times[Math.floor(times.length * 0.9)])} ms`);
