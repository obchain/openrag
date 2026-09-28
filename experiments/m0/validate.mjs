// Check that every evidence phrase exists in the cleaned corpus, and report where.
import fs from "node:fs";
import { loadCorpus, norm } from "./lib/corpus.mjs";
import { CHUNKERS } from "./lib/chunk.mjs";

const docs = loadCorpus("corpus/plausible");
const { questions } = JSON.parse(fs.readFileSync("questions.json", "utf8"));
const normDocs = docs.map((d) => ({ id: d.id, t: norm(`${d.title}\n${d.text}`) }));
let bad = 0;
for (const q of questions.filter((q) => q.evidence)) {
  const found = normDocs.filter((d) => q.evidence.some((e) => d.t.includes(norm(e)))).map((d) => d.id);
  if (!found.length) bad++;
  console.log(`${q.id} ${found.length ? "ok " : "MISSING"} ${found.join(", ")}`);
}
console.log(`\n${docs.length} docs, ${questions.length} questions, ${bad} evidence problems`);
for (const [name, fn] of Object.entries(CHUNKERS)) {
  const cs = fn(docs);
  const tok = cs.map((c) => c.tokens).sort((a, b) => a - b);
  const miss = questions.filter((q) => q.evidence && !cs.some((c) => q.evidence.some((e) => norm(`${c.path.join(" ")}\n${c.text}`).includes(norm(e)))));
  console.log(`${name.padEnd(22)} ${String(cs.length).padStart(5)} pieces, median ${tok[tok.length >> 1]} tokens, max ${tok.at(-1)}, evidence split across pieces: ${miss.map((q) => q.id).join(" ") || "none"}`);
}
