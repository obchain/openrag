import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * One piece of a document, exactly as it appears in the source file.
 *
 * `text` is always `source.slice(charStart, charEnd)`. Nothing is rewritten:
 * cleaning happens by dropping whole blocks, never by editing inside one. That
 * is what keeps a citation able to point at the real file.
 */
export interface Block {
  /** Section this block sits under, e.g. ["Billing", "Refunds"]. */
  headingPath: string[];
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ParsedDocument {
  /** Front matter `title` if the page declares one, else its first heading. */
  title?: string;
  blocks: Block[];
}

/**
 * Turn Markdown or MDX into the blocks the chunker packs, each one still
 * addressable in the original file.
 */
export function parseMarkdown(source: string): ParsedDocument {
  const { title, body, offset } = splitFrontMatter(source);
  const blocks: Block[] = [];
  const headingPath: string[] = [];
  let pageTitle: string | undefined;

  for (const node of fromMarkdown(body).children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const text = body.slice(start, end);

    if (node.type === "heading") {
      const heading = inlineText(node).trim();
      if (node.depth === 1) {
        // One H1 is the page's own title, not a section inside it.
        pageTitle ??= heading;
        headingPath.length = 0;
      } else {
        const level = node.depth - 2;
        headingPath.length = Math.min(headingPath.length, level); // leaving a section closes the ones under it
        headingPath[level] = heading;
      }
      continue;
    }

    if (isNoise(node.type, text)) continue;

    blocks.push({
      headingPath: [...headingPath],
      text,
      charStart: start + offset,
      charEnd: end + offset,
    });
  }

  return { title: title ?? pageTitle, blocks };
}

/** MDX module lines. A parser without the MDX extension sees these as a paragraph. */
const MDX_STATEMENT = /^(import|export)\s/;

/**
 * A tag opening a paragraph. CommonMark only calls markup an html block when the
 * tag is complete on its own line, so a component written across several lines
 * arrives as an ordinary paragraph and has to be caught here.
 * `<https://example.com>` is an autolink, not a tag, and does not match.
 */
const MARKUP_START = /^<\/?[A-Za-z][\w.-]*[\s/>]/;

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
