// Prove the three "done when" criteria of incremental re-indexing, on the real
// corpus. Copies it to a temp folder so the corpus itself is never touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chunkDocument,
  estimateTokens,
  loadFiles,
  parseHtml,
  parseMarkdown,
  planUpdate,
} from "../../packages/openrag/dist/index.js";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "openrag-incr-"));
fs.cpSync("corpus/plausible", work, { recursive: true });

const chunkOf = (document) => {
  const parsed = /^\s*</.test(document.text) ? parseHtml(document.text, { url: document.uri }) : parseMarkdown(document.text);
  return chunkDocument(document, parsed, { countTokens: estimateTokens });
};

/** Stands in for the store M2 will provide: what is indexed, and nothing else. */
const index = { documents: new Map(), chunks: new Map() };
const apply = (documents, plan) => {
  for (const id of plan.removedDocuments) {
    index.documents.delete(id);
    index.chunks.delete(id);
  }
  const byId = new Map(documents.map((d) => [d.id, d]));
  const touched = new Map();
  for (const chunk of plan.embed) touched.set(chunk.docId, [...(touched.get(chunk.docId) ?? []), chunk.id]);
  for (const chunk of plan.embed) index.documents.set(chunk.docId, byId.get(chunk.docId).contentHash);
  for (const [docId, ids] of touched) {
    const kept = (index.chunks.get(docId) ?? []).filter((id) => !plan.remove.includes(id));
    index.chunks.set(docId, [...kept, ...ids]);
  }
  for (const id of plan.remove) {
    for (const [docId, ids] of index.chunks) {
      if (ids.includes(id)) index.chunks.set(docId, ids.filter((x) => x !== id));
    }
  }
};

const run = async (label) => {
  const { documents } = await loadFiles(work);
  const t = performance.now();
  const plan = planUpdate(documents, index, chunkOf);
  const ms = performance.now() - t;
  apply(documents, plan);
  console.log(
    `${label.padEnd(34)} embed ${String(plan.embed.length).padStart(4)} | keep ${String(plan.keep.length).padStart(4)}` +
      ` | remove ${String(plan.remove.length).padStart(3)} | ${JSON.stringify(plan.summary)} | ${Math.round(ms)}ms`,
  );
  return plan;
};

await run("1. first run (empty index)");
const second = await run("2. nothing changed");

const page = path.join(work, "2fa.md");
fs.writeFileSync(page, `${fs.readFileSync(page, "utf8")}\n## Extra section\n\nA newly added paragraph.\n`);
const third = await run("3. one section added to one page");

fs.rmSync(path.join(work, "billing.md"));
const fourth = await run("4. one page deleted");

fs.rmSync(work, { recursive: true, force: true });

const ok = (name, value) => console.log(`${value ? "PASS" : "FAIL"}  ${name}`);
console.log();
ok("a second run embeds nothing", second.embed.length === 0);
ok("editing one page embeds only its new pieces", third.embed.length > 0 && third.embed.length <= 3);
ok("every other page is untouched by that edit", third.summary.unchanged === 133);
ok("a deleted page takes its chunks with it", fourth.removedDocuments.length === 1 && fourth.remove.length > 0);
if (second.embed.length !== 0 || third.summary.unchanged !== 133) process.exit(1);
