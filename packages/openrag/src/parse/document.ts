import type { ParsedDocument, SourceDocument } from "../types.js";
import { parseHtml } from "./html.js";
import { parseMarkdown } from "./markdown.js";

const HTML_URI = /\.(html?|xhtml)(\?|#|$)/i;
/** A real document opening, not merely a line that starts with a tag. */
const HTML_TEXT = /^\s*<(!doctype|html|head|body)\b/i;

/**
 * Parse a document the right way for what it is.
 *
 * The content type a fetch reported is the strongest signal, then the uri, and
 * only then the text itself — a Markdown page may well open with a comment or a
 * wrapper `<div>`, so that guess goes last.
 */
export function parseDocument(document: SourceDocument): ParsedDocument {
  const contentType = String(document.metadata?.contentType ?? "");
  const isHtml = contentType
    ? /html|xml/i.test(contentType)
    : HTML_URI.test(document.uri) || HTML_TEXT.test(document.text);

  return isHtml ? parseHtml(document.text, { url: document.uri }) : parseMarkdown(document.text);
}
