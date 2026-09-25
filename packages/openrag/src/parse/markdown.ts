import { fromMarkdown } from "mdast-util-from-markdown";
import type { Block, ParsedDocument } from "../types.js";

/**
 * Turn Markdown or MDX into the blocks the chunker packs, each one still
 * addressable in the original file.
 */
export function parseMarkdown(source: string): ParsedDocument {
  const { title, body, offset } = splitFrontMatter(source);
  const blocks: Block[] = [];
  /** Open headings, outermost first. A stack handles a skipped level and a
   *  second h1 without any index arithmetic to get wrong. */
  const open: { depth: number; text: string }[] = [];
  let pageTitle: string | undefined;

  for (const node of fromMarkdown(body).children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const text = body.slice(start, end);

    if (node.type === "heading") {
      const heading = inlineText(node).trim();

      // The first h1 names the page. A second one is a section inside it, which
      // is what a concatenated handbook or a converted page looks like.
      if (node.depth === 1 && pageTitle === undefined && heading !== "") {
        pageTitle = heading;
        open.length = 0;
        continue;
      }

      // Opening a heading closes every heading at its level or deeper.
      while (open.length > 0 && (open[open.length - 1] as { depth: number }).depth >= node.depth) open.pop();
      if (heading !== "") open.push({ depth: node.depth, text: heading });
      continue;
    }

    if (isNoise(node.type, text)) continue;

    blocks.push({
      headingPath: open.map((heading) => heading.text),
      text,
      charStart: start + offset,
      charEnd: end + offset,
    });
  }

  return { title: title ?? pageTitle, text: source, blocks };
}

/** MDX module lines. A parser without the MDX extension sees these as a paragraph. */
const MDX_STATEMENT = /^(import|export)\s/;

/**
 * A paragraph that is really markup: an MDX component, which is capitalised by
 * convention, or a layout tag. CommonMark only calls markup an html block when
 * the tag is complete on its own line, so a component written across several
 * lines arrives as an ordinary paragraph and has to be caught here.
 *
 * Deliberately narrow. A sentence may well open with `<b>`, `<kbd>` or `<br>`,
 * and dropping the paragraph would delete an answer with nothing to show for it.
 * `<https://example.com>` is an autolink, not a tag, and does not match either.
 */
const MARKUP_START = /^<\/?(?:[A-Z][\w.]*|div|section|figure|head|script|style|iframe|noscript)\b/;

/**
 * Markup that carries no answer: a component, a wrapper div, a `<head>` block.
 *
 * In the practice corpus a `<head>` block held JSON-LD that repeated the whole
 * page, which would have put the same answer in the index twice.
 */
function isNoise(type: string, text: string): boolean {
  if (type === "html") return true;
  if (type !== "paragraph") return false;
  return MDX_STATEMENT.test(text) || MARKUP_START.test(text);
}

/**
 * The words a heading actually reads as, taken from the parsed nodes rather
 * than from the raw line: `## Use the **API** [docs](/api)` reads as
 * "Use the API docs", and an underlined heading has no `#` to strip at all.
 *
 * Every node shape is either a leaf carrying `value` or a branch carrying
 * `children`, so the walk only looks for those two and ignores the rest.
 */
function inlineText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const { value, children } = node as { value?: unknown; children?: unknown };
  if (typeof value === "string") return value;
  return Array.isArray(children) ? children.map(inlineText).join("") : "";
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

/**
 * Split a leading `---` block off the source.
 *
 * `offset` is how many characters were removed, so every position the parser
 * reports can be shifted back onto the original file.
 */
export function splitFrontMatter(source: string): { title?: string; body: string; offset: number } {
  const match = source.match(FRONT_MATTER);
  if (!match) return { body: source, offset: 0 };

  const title = match[1]
    ?.match(/^title:[ \t]*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  return {
    title: title === "" ? undefined : title,
    body: source.slice(match[0].length),
    offset: match[0].length,
  };
}
