// Two chunkers: heading-aware (the planned default) and fixed-size (baseline).
import { fromMarkdown } from "mdast-util-from-markdown";
import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");
export const countTokens = (s) => enc.encode(s).length;
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

function splitLong(text, max) {
  const out = [];
  let buf = "";
  for (const { segment } of sentences.segment(text)) {
    if (buf && countTokens(buf + segment) > max) {
      out.push(buf.trim());
      buf = "";
    }
    buf += segment;
  }
  if (buf.trim()) out.push(buf.trim());
  // a single sentence longer than max gets a hard token split
  return out.flatMap((t) => {
    const ids = enc.encode(t);
    if (ids.length <= max) return [t];
    const parts = [];
    for (let i = 0; i < ids.length; i += max) parts.push(enc.decode(ids.slice(i, i + max)));
    return parts;
  });
}

const headerOf = (doc, path) => [doc.title, ...path].join(" › ");

// Break on the doc's own headings first, then pack blocks under the same heading up to maxTokens.
export function headingChunks(docs, { maxTokens, header = true }) {
  const chunks = [];
  for (const doc of docs) {
    const tree = fromMarkdown(doc.text);
    const path = [];
    let buf = [];
    let bufPath = [];
    const flush = () => {
      if (!buf.length) return;
      const text = buf.join("\n\n");
      chunks.push({ docId: doc.id, title: doc.title, path: [...bufPath], text });
      buf = [];
    };
    for (const node of tree.children) {
      const src = doc.text.slice(node.position.start.offset, node.position.end.offset);
      if (node.type === "heading") {
        flush();
        path.length = Math.max(0, node.depth - 2); // H2 is the first level under the page title
        path[Math.max(0, node.depth - 2)] = src.replace(/^#+\s*/, "");
        continue;
      }
      const pieces = countTokens(src) > maxTokens ? splitLong(src, maxTokens) : [src];
      for (const p of pieces) {
        const samePath = bufPath.join("\u0000") === path.join("\u0000");
        if (buf.length && (!samePath || countTokens([...buf, p].join("\n\n")) > maxTokens)) flush();
        if (!buf.length) bufPath = [...path];
        buf.push(p);
      }
    }
    flush();
  }
  return chunks.map((c, i) => ({
    ...c,
    idx: i,
    embedText: header ? `${headerOf(c, c.path)}\n${c.text}` : c.text,
    tokens: countTokens(c.text),
  }));
}

// Baseline: ignore structure, cut every `size` tokens.
export function fixedChunks(docs, { size }) {
  const chunks = [];
  for (const doc of docs) {
    const ids = enc.encode(doc.text);
    for (let i = 0; i < ids.length; i += size) {
      const text = enc.decode(ids.slice(i, i + size));
      chunks.push({ docId: doc.id, title: doc.title, path: [], text });
    }
  }
  return chunks.map((c, i) => ({ ...c, idx: i, embedText: c.text, tokens: countTokens(c.text) }));
}

export const CHUNKERS = {
  "fixed-256": (docs) => fixedChunks(docs, { size: 256 }),
  "heading-128": (docs) => headingChunks(docs, { maxTokens: 128 }),
  "heading-256": (docs) => headingChunks(docs, { maxTokens: 256 }),
  "heading-512": (docs) => headingChunks(docs, { maxTokens: 512 }),
  "heading-256-noheader": (docs) => headingChunks(docs, { maxTokens: 256, header: false }),
};
