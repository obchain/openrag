// Load the practice corpus and clean Docusaurus/MDX noise out of each page.
import fs from "node:fs";
import path from "node:path";

export function clean(raw) {
  let s = raw;
  let title = null;
  const fm = s.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    const t = fm[1].match(/^title:\s*(.*)$/m);
    if (t) title = t[1].trim().replace(/^["']|["']$/g, "");
    s = s.slice(fm[0].length);
  }
  s = s
    .replace(/<head>[\s\S]*?<\/head>/g, "") // JSON-LD blocks duplicate the page text
    .replace(/^import .*$/gm, "")
    .replace(/<CtaBox[\s\S]*?\/>/g, "")
    .replace(/<img[^>]*\/?>/g, "")
    .replace(/^\s*<\/?div[^>]*>\s*$/gm, "")
    .replace(/^:::\w+[ \t]*(.*)$/gm, "$1") // keep an admonition's title text
    .replace(/^:::\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: s };
}

// Normalisation used only for matching evidence phrases against retrieved text.
export const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function loadCorpus(dir) {
  const docs = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md") && e.name !== "LICENSE.md") {
        const { title, text } = clean(fs.readFileSync(p, "utf8"));
        const id = path.relative(dir, p);
        docs.push({ id, title: title ?? id, text });
      }
    }
  };
  walk(dir);
  return docs.sort((a, b) => a.id.localeCompare(b.id));
}
