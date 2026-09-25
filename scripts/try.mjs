// Try the pipeline by hand: node scripts/try.mjs <folder | file | url> [--full]
import { loadFiles, loadUrls, parseHtml, parseMarkdown } from "../packages/openrag/dist/index.js";

const [target, ...flags] = process.argv.slice(2);
if (!target) {
  console.error("usage: node scripts/try.mjs <folder | file | url> [--full]");
  process.exit(1);
}

const isUrl = /^https?:\/\//.test(target);
const { documents, failures } = isUrl ? await loadUrls(target) : await loadFiles(target);

console.log(`\n${documents.length} document(s), ${failures.length} failure(s)`);
for (const failure of failures) console.log(`  ✗ ${failure.uri} — ${failure.reason}`);

for (const document of documents) {
  const parsed = /^\s*</.test(document.text)
    ? parseHtml(document.text, { url: document.uri })
    : parseMarkdown(document.text);

  console.log(`\n${"─".repeat(72)}\n${document.uri}`);
  console.log(`  title   ${parsed.title ?? document.title}`);
  console.log(`  id      ${document.id}`);
  console.log(`  size    ${document.text.length} chars → ${parsed.text.length} after parsing`);
  console.log(`  blocks  ${parsed.blocks.length}`);
  if (parsed.blocks.length === 0) {
    console.log("  ⚠ no readable content — the page probably renders its text with JavaScript");
  }

  for (const block of parsed.blocks) {
    const where = block.headingPath.length ? block.headingPath.join(" › ") : "(page top)";
    const body = flags.includes("--full") ? block.text : `${block.text.slice(0, 70).replace(/\n/g, " ")}…`;
    console.log(`\n  [${block.charStart}-${block.charEnd}] ${where}\n    ${body}`);
  }
}
