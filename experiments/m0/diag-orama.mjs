// Is Orama's weak keyword score a config problem? Try several configs, keyword-only (no embeddings needed).
import fs from "node:fs";
import { create, insertMultiple, search } from "@orama/orama";
import { loadCorpus, norm } from "./lib/corpus.mjs";
import { CHUNKERS } from "./lib/chunk.mjs";
import { sqliteStore, terms } from "./lib/stores.mjs";

const docs = loadCorpus("corpus/plausible");
const chunks = CHUNKERS["heading-256"](docs);
const match = chunks.map((c) => norm(`${c.path.join(" ")}\n${c.text}`));
const qs = JSON.parse(fs.readFileSync("questions.json", "utf8")).questions.filter((q) => q.evidence);
const hit5 = (list, q) => list.slice(0, 5).some((h) => q.evidence.some((e) => match[h].includes(norm(e))));

const fake = chunks.map(() => [0, 0, 1]);
const sq = sqliteStore(chunks, fake);
let n = 0;
for (const q of qs) if (hit5(sq.keyword(q.q, 5).map((h) => h.idx), q)) n++;
console.log(`sqlite fts5 (porter, stopwords removed)        ${Math.round((100 * n) / qs.length)}%`);

const configs = {
  "orama defaults, full question": { comp: {}, query: (q) => q.q, opts: {} },
  "orama defaults, stopwords removed": { comp: {}, query: (q) => terms(q.q).join(" "), opts: {} },
  "orama stemming, stopwords removed": { comp: { tokenizer: { stemming: true } }, query: (q) => terms(q.q).join(" "), opts: {} },
  "orama stemming, threshold 1": { comp: { tokenizer: { stemming: true } }, query: (q) => terms(q.q).join(" "), opts: { threshold: 1 } },
  "orama stemming, threshold 0.5": { comp: { tokenizer: { stemming: true } }, query: (q) => terms(q.q).join(" "), opts: { threshold: 0.5 } },
};
for (const [name, c] of Object.entries(configs)) {
  const db = create({ schema: { idx: "number", text: "string" }, components: c.comp });
  await insertMultiple(db, chunks.map((ch, i) => ({ idx: i, text: ch.embedText })), 500);
  let h = 0;
  for (const q of qs) {
    const r = await search(db, { term: c.query(q), properties: ["text"], limit: 5, ...c.opts });
    if (hit5(r.hits.map((x) => x.document.idx), q)) h++;
  }
  console.log(`${name.padEnd(46)} ${Math.round((100 * h) / qs.length)}%`);
}
