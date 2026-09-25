// Prove the "done when" criteria of incremental re-indexing on the real corpus.
// Copies it to a temp folder, so the corpus itself is never touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chunkDocument,
  estimateTokens,
  loadFiles,
  parseDocument,
  planUpdate,
} from "../../packages/openrag/dist/index.js";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "openrag-incr-"));
const results = [];
const ok = (name, passed) => {
  results.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
};

try {
  fs.cpSync("corpus/plausible", work, { recursive: true });
  const chunkOf = (document) =>
    chunkDocument(document, parseDocument(document), { countTokens: estimateTokens });

  /** Stands in for the store M2 will provide: what is indexed, and nothing else. */
  const index = { documents: new Map(), chunks: new Map() };

  const apply = (plan) => {
    const gone = new Set(plan.remove);
    for (const docId of plan.removedDocuments) {
      index.documents.delete(docId);
      index.chunks.delete(docId);
    }
    for (const { docId, contentHash } of plan.indexedDocuments) index.documents.set(docId, contentHash);

    const written = new Map();
    for (const chunk of [...plan.embed, ...plan.restate]) {
      written.set(chunk.docId, [...(written.get(chunk.docId) ?? []), chunk.id]);
    }
    for (const [docId, ids] of index.chunks) {
      const kept = ids.filter((id) => !gone.has(id));
      index.chunks.set(docId, written.has(docId) ? [...kept, ...(written.get(docId) ?? [])] : kept);
    }
    for (const [docId, ids] of written) if (!index.chunks.has(docId)) index.chunks.set(docId, ids);
  };

  const run = async (label) => {
    const load = await loadFiles(work);
    const t = performance.now();
    const plan = planUpdate(load, index, chunkOf);
    const ms = performance.now() - t;
    apply(plan);
    console.log(
      `${label.padEnd(36)} embed ${String(plan.embed.length).padStart(4)} | restate ${String(plan.restate.length).padStart(4)}` +
        ` | keep ${String(plan.keep.length).padStart(4)} | remove ${String(plan.remove.length).padStart(3)} | ${Math.round(ms)}ms`,
    );
    console.log(`${" ".repeat(36)} ${JSON.stringify(plan.summary)}`);
    return { plan, load };
  };

  const first = await run("1. first run (empty index)");
  const pages = first.load.documents.length;
  const second = await run("2. nothing changed");

  // An edit in the MIDDLE of a page: the one shape that moves everything below
  // it, so a kept chunk carrying a stale span would show up here and nowhere else.
  const edited = first.load.documents.find((d) => d.text.includes("\n## "));
  const file = path.join(work, edited.uri);
  const source = fs.readFileSync(file, "utf8");
  const at = source.indexOf("\n## ");
  fs.writeFileSync(file, `${source.slice(0, at)}\n\nAn inserted paragraph that shifts everything below it.\n${source.slice(at)}`);
  const third = await run("3. a paragraph inserted mid-page");

  // Every chunk the plan writes must agree with a fresh chunking of the new text.
  const after = (await loadFiles(work)).documents.find((d) => d.uri === edited.uri);
  const fresh = new Map(chunkOf(after).map((c) => [c.id, c]));
  const written = [...third.plan.embed, ...third.plan.restate].filter((c) => c.docId === after.id);
  const spansAgree = written.every((c) => {
    const truth = fresh.get(c.id);
    return truth && truth.charStart === c.charStart && truth.charEnd === c.charEnd;
  });
  const movedRestated = third.plan.restate.some((c) => c.docId === after.id);

  const removedPage = first.load.documents.find((d) => d.uri !== edited.uri);
  fs.rmSync(path.join(work, removedPage.uri));
  const fourth = await run("4. one page deleted");

  console.log();
  ok("a second run embeds nothing", second.plan.embed.length === 0);
  ok("a second run rewrites nothing", second.plan.restate.length === 0);
  ok("a mid-page edit embeds only the new text", third.plan.embed.length > 0 && third.plan.embed.length <= 3);
  ok("chunks below the edit are restated, not re-embedded", movedRestated);
  ok("every written chunk carries its true span", spansAgree);
  ok("every other page is untouched", third.plan.summary.unchanged === pages - 1);
  ok("a deleted page takes its chunks with it", fourth.plan.removedDocuments.length === 1 && fourth.plan.remove.length > 0);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

if (results.some((passed) => !passed)) process.exit(1);
