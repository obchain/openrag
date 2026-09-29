// Try the pipeline by hand.
//
//   node scripts/try.mjs <folder | file | url>                  inspect the pieces
//   node scripts/try.mjs <folder | file | url> --ask "question" index them and search
//   …                                          --db index.db    keep the index in a file
//   …                                          --full           print whole pieces
import { LocalEmbedder } from "../packages/local/dist/index.js";
import {
  chunkDocument,
  embedText,
  estimateTokens,
  FUSION_WEIGHTS,
  fuse,
  loadFiles,
  loadUrls,
  parseDocument,
  planUpdate,
  SqliteStore,
} from "../packages/openrag/dist/index.js";

const argv = process.argv.slice(2);
const target = argv.find((argument) => !argument.startsWith("--"));
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const question = flag("ask");
const full = argv.includes("--full");

if (!target) {
  console.error('usage: node scripts/try.mjs <folder | file | url> [--ask "question"] [--db file] [--full]');
  process.exit(1);
}

const isUrl = /^https?:\/\//.test(target);
const load = isUrl ? await loadUrls(target) : await loadFiles(target);
const { documents, failures } = load;

console.log(`\n${documents.length} document(s), ${failures.length} failure(s)`);
for (const failure of failures) console.log(`  ✗ ${failure.uri} — ${failure.reason}`);

// Searching needs the real model, because the budget a piece is packed to has to
// be counted with the tokenizer that model was trained with (D-020). Inspecting
// does not, and loading 33 MB to look at chunk boundaries would be rude.
const embedder = question === undefined ? undefined : await loadEmbedder();
const countTokens = embedder?.countTokens ?? estimateTokens;
const estimated = embedder === undefined ? ", estimated" : "";

const chunkOf = (document) => chunkDocument(document, parseDocument(document), { countTokens });

for (const document of documents) {
  const parsed = parseDocument(document);

  console.log(`\n${"─".repeat(72)}\n${document.uri}`);
  console.log(`  title   ${parsed.title ?? document.title}`);
  console.log(`  id      ${document.id}`);
  console.log(`  size    ${document.text.length} chars → ${parsed.text.length} after parsing`);
  console.log(`  blocks  ${parsed.blocks.length}`);
  if (parsed.blocks.length === 0) {
    console.log("  ⚠ no readable content — the page probably renders its text with JavaScript");
  }

  // Chunking throws on a document it cannot honestly handle; one such page
  // should not end the run, so it is reported like any other failure.
  let chunks = [];
  try {
    chunks = chunkOf(document);
  } catch (error) {
    console.log(`  ✗ cannot chunk: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const sizes = chunks.map((chunk) => chunk.tokens).sort((a, b) => a - b);
  console.log(
    `  chunks  ${chunks.length}  (tokens: median ${sizes[sizes.length >> 1] ?? 0}, max ${sizes.at(-1) ?? 0}${estimated})`,
  );

  // With a question to answer, the pieces are the means rather than the point.
  if (question !== undefined) continue;
  for (const chunk of chunks) {
    const body = full ? chunk.text : `${chunk.text.slice(0, 70).replace(/\n/g, " ")}…`;
    console.log(
      `\n  [${chunk.charStart}-${chunk.charEnd}] ${chunk.tokens} tok · ${[chunk.title, ...chunk.headingPath].join(" › ")}\n    ${body}`,
    );
  }
}

if (question === undefined || embedder === undefined) process.exit(0);

// ── Index, then search ────────────────────────────────────────────────────────
const store = new SqliteStore({ file: flag("db") });
const plan = planUpdate(load, await store.snapshot("try"), (document) =>
  chunkOf(document).map((chunk) => ({ ...chunk, namespace: "try" })),
);

const started = performance.now();
const vectors = await embedder.embedDocuments(plan.embed.map((chunk) => embedText(chunk, true)));
await store.apply("try", {
  upsert: plan.embed.map((chunk, i) => ({ chunk, vector: vectors[i] })),
  restate: plan.restate,
  removeChunks: plan.remove,
  removeDocuments: plan.removedDocuments,
  documents: plan.indexedDocuments,
});

console.log(`\n${"─".repeat(72)}`);
console.log(
  plan.embed.length === 0
    ? `index up to date, ${plan.summary.unchanged} document(s) unchanged — nothing embedded`
    : `indexed ${plan.embed.length} piece(s) in ${((performance.now() - started) / 1000).toFixed(1)} s` +
        (plan.restate.length > 0 ? `, moved ${plan.restate.length}` : ""),
);

// `fuse` defaults to the weights that go with a reranker, and there is none here
// yet (M3). Measured without one, equal weights cost paraphrased questions 20
// points of hit@5, because keyword noise ties with the right answer (D-017).
const hits = fuse(
  {
    lexical: await store.lexicalSearch("try", question, 20),
    vector: await store.vectorSearch("try", await embedder.embedQuery(question), 20),
  },
  { weights: FUSION_WEIGHTS.withoutReranker, topK: 5 },
);

// No reranker and no LLM yet (M3, M4), so these are the pieces a generator would
// be handed, in the order it would see them.
console.log(`\n"${question}"\n`);
if (hits.length === 0) console.log("  nothing matched");
for (const [at, hit] of hits.entries()) {
  const path = [hit.chunk.title, ...hit.chunk.headingPath].filter(Boolean).join(" › ");
  const body = full ? hit.chunk.text : `${hit.chunk.text.slice(0, 160).replace(/\s+/g, " ")}…`;
  console.log(`  ${at + 1}. ${path}`);
  console.log(`     ${hit.chunk.uri} [${hit.chunk.charStart}-${hit.chunk.charEnd}]`);
  console.log(`     ${body}\n`);
}
store.close();

async function loadEmbedder() {
  let last = "";
  return LocalEmbedder.load({
    onProgress: (progress) => {
      if (progress.phase !== "download" || progress.file === last) return;
      last = progress.file;
      console.log(`  downloading ${progress.file} (first run only)`);
    },
  });
}
