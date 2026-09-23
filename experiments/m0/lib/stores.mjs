// Two candidate default stores behind the same small surface: keyword(), vector(), sizeBytes().
import fs from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { create, insertMultiple, search, save } from "@orama/orama";

const STOP = new Set(
  "a an and are as at be but by can could do does did for from has have how i if in into is it its me my of on or our so that the their them then there these they this to up us was we what when where which who why will with would you your".split(" "),
);
export const terms = (q) =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));

// SQLite: sqlite-vec for vectors + FTS5 (BM25, porter stemming) for keywords, in one file.
export function sqliteStore(chunks, vecs, { file = ":memory:" } = {}) {
  if (file !== ":memory:" && fs.existsSync(file)) fs.rmSync(file);
  const db = new Database(file);
  sqliteVec.load(db);
  const dim = vecs[0].length;
  db.exec(`create virtual table vec using vec0(embedding float[${dim}]);
           create virtual table fts using fts5(text, tokenize='porter unicode61');`);
  const iv = db.prepare("insert into vec(rowid, embedding) values (?, ?)");
  const it = db.prepare("insert into fts(rowid, text) values (?, ?)");
  db.transaction(() => {
    chunks.forEach((c, i) => {
      iv.run(BigInt(i + 1), new Float32Array(vecs[i]));
      it.run(BigInt(i + 1), c.embedText);
    });
  })();
  const kq = db.prepare("select rowid, bm25(fts) as s from fts where fts match ? order by s limit ?");
  const vq = db.prepare("select rowid, distance from vec where embedding match ? and k = ?");
  return {
    name: "sqlite",
    keyword(q, k) {
      const t = terms(q);
      if (!t.length) return [];
      return kq.all(t.map((w) => `"${w}"`).join(" OR "), k).map((r) => ({ idx: Number(r.rowid) - 1, score: -r.s }));
    },
    // unit vectors: cosine = 1 - L2² / 2
    vector(qv, k) {
      return vq.all(new Float32Array(qv), k).map((r) => ({ idx: Number(r.rowid) - 1, score: 1 - (r.distance * r.distance) / 2 }));
    },
    sizeBytes: () => (file === ":memory:" ? null : fs.statSync(file).size),
    close: () => db.close(),
  };
}

// Orama: pure JavaScript, zero native dependencies, BM25 + vector + its own hybrid mode.
export async function oramaStore(chunks, vecs) {
  const dim = vecs[0].length;
  const db = create({
    schema: { idx: "number", text: "string", embedding: `vector[${dim}]` },
    components: { tokenizer: { stemming: true, stopWords: [...STOP] } },
  });
  await insertMultiple(db, chunks.map((c, i) => ({ idx: i, text: c.embedText, embedding: vecs[i] })), 500);
  const hits = (r) => r.hits.map((h) => ({ idx: h.document.idx, score: h.score }));
  return {
    name: "orama",
    keyword: async (q, k) => hits(await search(db, { term: q, properties: ["text"], limit: k, threshold: 1 })),
    vector: async (qv, k) => hits(await search(db, { mode: "vector", vector: { value: qv, property: "embedding" }, similarity: 0.01, limit: k })),
    hybridNative: async (q, qv, k) =>
      hits(await search(db, { mode: "hybrid", term: q, properties: ["text"], vector: { value: qv, property: "embedding" }, similarity: 0.01, limit: k, threshold: 1 })),
    sizeBytes: async () => Buffer.byteLength(JSON.stringify(await save(db))),
    close: () => {},
  };
}

export function rrf(lists, k = 60) {
  const m = new Map();
  for (const list of lists) list.forEach((h, r) => m.set(h.idx, (m.get(h.idx) ?? 0) + 1 / (k + r + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([idx, score]) => ({ idx, score }));
}
