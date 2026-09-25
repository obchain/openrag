import { NodeHtmlMarkdown } from "node-html-markdown";
import { type HTMLElement, parse } from "node-html-parser";
import { type ParsedDocument, parseMarkdown } from "./markdown.js";

/** Tags that never hold an answer, wherever they appear. */
const NOISE = "script,style,noscript,iframe,svg,nav,aside,form,dialog,button";

/** Page furniture, dropped only when we had to fall back to the whole body. */
const CHROME = 'header,footer,[role="navigation"],[role="banner"],[role="contentinfo"],[role="search"]';

/**
 * The element holding the article. A documentation page marks it — `<main>`,
 * `<article>`, or the ARIA landmark older generators emit — and picking it
 * removes the site's header, sidebar and footer in one step, because they sit
 * outside it. Only when nothing is marked do we take the body and strip the
 * furniture by tag and landmark, which is the guessier path.
 */
function contentRoot(document: HTMLElement): { root: HTMLElement; marked: boolean } {
  const marked =
    document.querySelector("main") ??
    document.querySelector("article") ??
    document.querySelector('[role="main"]');
  if (marked) return { root: marked, marked: true };
  const body = document.querySelector("body") ?? document;
  for (const element of body.querySelectorAll(CHROME)) element.remove();
  return { root: body, marked: false };
}

/**
 * Navigation, for a page that marked nothing: an element that is almost all
 * link text. Only used on the guessing path — when a page says where its
 * content is, we take it at its word rather than second-guess it, because a
 * wrong guess deletes an answer instead of leaving noise.
 */
function dropLinkLists(root: HTMLElement): void {
  for (const element of root.querySelectorAll("*")) {
    if (!element.parentNode) continue; // already removed with an ancestor
    const links = element.querySelectorAll("a");
    const total = textOf(element).length;
    if (links.length < 3 || total < 20) continue; // a real navbar reads "DocsBlogPricingLogin"
    const linkText = links.reduce((sum, link) => sum + textOf(link).length, 0);
    if (linkText / total > 0.5) element.remove();
  }
}

/**
 * Everything a reader would skip. Each rule is about shape, not about one
 * site's class names, so it holds on a page we have never seen.
 */
function clean(root: HTMLElement, baseUrl?: string): void {
  for (const element of root.querySelectorAll(NOISE)) element.remove();

  // A list whose every item is a link to this same page is a table of contents.
  for (const list of root.querySelectorAll("ul,ol")) {
    const links = list.querySelectorAll("a");
    const items = list.querySelectorAll("li");
    if (links.length > 1 && links.length === items.length && links.every(isSamePageLink)) list.remove();
  }

  // Links with no words: heading permalinks, icon buttons, tracking pixels.
  for (const link of root.querySelectorAll("a")) if (textOf(link) === "") link.remove();

  // A relative href is useless once the page is out of its site.
  if (baseUrl) {
    for (const link of root.querySelectorAll("a[href]")) {
      const resolved = resolve(link.getAttribute("href"), baseUrl);
      if (resolved) link.setAttribute("href", resolved);
      else link.removeAttribute("href");
    }
  }
}

const isSamePageLink = (link: HTMLElement) => (link.getAttribute("href") ?? "").startsWith("#");

/**
 * Words only. Zero-width characters are invisible to a reader, and a pilcrow or
 * section sign is the permalink some generators hang off every heading.
 */
const textOf = (element: HTMLElement) => element.text.replace(/[\u200B-\u200D\uFEFF\s¶§]/g, "");

function resolve(href: string | undefined, baseUrl: string): string | undefined {
  try {
    return new URL(href ?? "", baseUrl).href;
  } catch {
    return undefined;
  }
}

export interface HtmlOptions {
  /** The page's own address, used to resolve relative links. */
  url?: string;
}

/**
 * Extract the readable part of a page and hand it to the Markdown parser.
 *
 * Converting to Markdown rather than walking the DOM ourselves means headings,
 * lists, code and tables arrive in the one shape the chunker already
 * understands, and there is only ever one block-building routine to trust.
 */
export function parseHtml(html: string, options: HtmlOptions = {}): ParsedDocument {
  const document = parse(html);
  const title = document.querySelector("title")?.text.trim();
  const { root, marked } = contentRoot(document);
  clean(root, options.url);
  if (!marked) dropLinkLists(root);

  const markdown = NodeHtmlMarkdown.translate(root.innerHTML)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    // An image's alt text reads as content; its url is noise in an embedding.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const parsed = parseMarkdown(markdown);
  return { ...parsed, title: parsed.title ?? title };
}
