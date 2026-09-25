import { documentId, sha256 } from "../hash.js";
import type { LoadFailure, LoadResult, Namespace, SourceDocument } from "../types.js";
import { DEFAULT_MAX_BYTES } from "./filesystem.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_USER_AGENT = "openrag (+https://github.com/obchain/openrag)";

/** Worth trying again: the server is busy or briefly broken, not the request. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface UrlOptions {
  namespace?: Namespace;
  /** How many URLs to fetch at once, so a site is not hammered. */
  concurrency?: number;
  timeoutMs?: number;
  /** Extra attempts after the first one. */
  retries?: number;
  retryDelayMs?: number;
  maxBytes?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Injection point for tests. Defaults to the global fetch. */
  fetch?: FetchLike;
}

/**
 * Fetch documents over HTTP, so a docs site can be indexed without cloning it.
 * Only the URLs given are fetched: there is no crawling. Documents come back in
 * the order they were asked for, and every URL that failed is listed.
 */
export async function loadUrls(
  input: string | readonly string[],
  options: UrlOptions = {},
): Promise<LoadResult> {
  const urls = [...new Set(typeof input === "string" ? [input] : input)];
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const outcomes = new Array<Outcome | undefined>(urls.length);

  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    for (let i = next++; i < urls.length; i = next++) {
      outcomes[i] = await loadUrl(urls[i] as string, options);
    }
  });
  await Promise.all(workers);

  const documents: SourceDocument[] = [];
  const failures: LoadFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome?.ok) documents.push(outcome.document);
    else if (outcome) failures.push(outcome.failure);
  }
  return { documents, failures };
}

type Outcome = { ok: true; document: SourceDocument } | { ok: false; failure: LoadFailure };

async function loadUrl(url: string, options: UrlOptions): Promise<Outcome> {
  const namespace = options.namespace ?? "default";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const doFetch = options.fetch ?? globalThis.fetch;
  const failed = (reason: string): Outcome => ({ ok: false, failure: { uri: url, reason } });

  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) return failed("cancelled");

    let response: Response;
    try {
      response = await doFetch(url, {
        redirect: "follow",
        headers: {
          "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
          accept: "text/html, text/markdown, text/plain;q=0.9, */*;q=0.1",
          ...options.headers,
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(timeoutMs),
          ...(options.signal ? [options.signal] : []),
        ]),
      });
    } catch (error) {
      if (options.signal?.aborted) return failed("cancelled");
      if (attempt >= retries) return failed(reasonFor(error));
      await sleep(backoff(attempt, retryDelayMs));
      continue;
    }

    if (!response.ok) {
      const reason = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      const retryable = RETRYABLE_STATUS.has(response.status) || response.status >= 500;
      const wait = retryAfter(response) ?? backoff(attempt, retryDelayMs);
      void response.body?.cancel().catch(() => {});
      if (!retryable || attempt >= retries) return failed(reason);
      await sleep(wait);
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!isTextual(contentType)) {
      void response.body?.cancel().catch(() => {});
      return failed(`unsupported content type: ${contentType || "unknown"}`);
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= retries) return failed(reasonFor(error));
      await sleep(backoff(attempt, retryDelayMs));
      continue;
    }
    if (bytes.byteLength > maxBytes) {
      return failed(`response is ${bytes.byteLength} bytes, over the ${maxBytes} byte limit`);
    }

    const text = new TextDecoder("utf-8").decode(bytes);
    if (text.includes("\u0000")) return failed("looks like a binary response");

    // The final URL after redirects is what the document is addressed by.
    const uri = response.url === "" ? url : response.url;
    const metadata: Record<string, unknown> = {
      status: response.status,
      contentType,
      bytes: bytes.byteLength,
    };
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    if (etag) metadata.etag = etag;
    if (lastModified) metadata.lastModified = lastModified;

    return {
      ok: true,
      document: {
        id: documentId(namespace, uri),
        namespace,
        uri,
        title: titleFrom(text, uri),
        text,
        contentHash: sha256(bytes),
        metadata,
      },
    };
  }
}

function backoff(attempt: number, base: number): number {
  return base * 2 ** attempt;
}

/** A server that says how long to wait is more reliable than our own guess. */
function retryAfter(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
}

/** An empty header is allowed: the null-byte check still guards us. */
const isTextual = (contentType: string) =>
  contentType === "" || /^text\/|html|xml|json|markdown/i.test(contentType);

function titleFrom(text: string, url: string): string {
  const tag = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = tag && decodeEntities(tag).replace(/\s+/g, " ").trim();
  return title || text.match(/^#\s+(.+)$/m)?.[1]?.trim() || new URL(url).pathname.split("/").pop() || url;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decodeEntities = (text: string) =>
  text.replace(/&(\w+);/g, (match, entity: string) => ENTITIES[entity.toLowerCase()] ?? match);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reasonFor(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "timed out" : error.message;
  }
  return String(error);
}
