import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { documentId } from "../src/hash.js";
import { loadUrls } from "../src/load/url.js";

let server: Server;
let origin = "";
let attempts: Record<string, number> = {};
let inFlight = 0;
let maxInFlight = 0;

const url = (path: string) => `${origin}${path}`;

beforeAll(async () => {
  server = createServer((request, response) => {
    const { pathname, searchParams } = new URL(request.url ?? "/", "http://localhost");
    attempts[pathname] = (attempts[pathname] ?? 0) + 1;

    if (pathname === "/page") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: 'W/"abc"' });
      response.end("<html><head><title>Billing &amp; plans</title></head><body>Refunds</body></html>");
    } else if (pathname === "/redirect") {
      response.writeHead(302, { location: "/page" });
      response.end();
    } else if (pathname === "/markdown") {
      response.writeHead(200, { "content-type": "text/markdown" });
      response.end("# Reset your password\n\nOpen settings.\n");
    } else if (pathname === "/untitled") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>No title here</body></html>");
    } else if (pathname === "/flaky") {
      if ((attempts[pathname] ?? 0) < 3) {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("busy");
      } else {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("# Recovered\n");
      }
    } else if (pathname === "/throttled") {
      if ((attempts[pathname] ?? 0) < 2) {
        response.writeHead(429, { "retry-after": "0", "content-type": "text/plain" });
        response.end("slow down");
      } else {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("# Allowed\n");
      }
    } else if (pathname === "/missing") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    } else if (pathname === "/pdf") {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end("%PDF-1.7");
    } else if (pathname === "/big") {
      const body = "x".repeat(4096);
      response.writeHead(200, { "content-type": "text/plain", "content-length": String(body.length) });
      response.end(body);
    } else if (pathname === "/slow") {
      // never responds: the client's timeout has to end this
    } else if (pathname === "/wait") {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(
        () => {
          inFlight--;
          response.writeHead(200, { "content-type": "text/plain" });
          response.end(`# Page ${searchParams.get("i")}\n`);
        },
        Number(searchParams.get("ms") ?? 20),
      );
    } else {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("boom");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  attempts = {};
  inFlight = 0;
  maxInFlight = 0;
});

describe("loadUrls", () => {
  it("returns one document per URL and lists the failures separately", async () => {
    const { documents, failures } = await loadUrls([url("/page"), url("/missing"), url("/markdown")]);
    expect(documents.map((document) => document.uri)).toEqual([url("/page"), url("/markdown")]);
    expect(failures).toEqual([{ uri: url("/missing"), reason: "HTTP 404 Not Found" }]);
  });

  it("keeps documents in the order the URLs were given, not the order they arrived", async () => {
    const { documents } = await loadUrls(
      [url("/wait?i=1&ms=60"), url("/wait?i=2&ms=5"), url("/wait?i=3&ms=30")],
      { concurrency: 3 },
    );
    expect(documents.map((document) => document.text.trim())).toEqual(["# Page 1", "# Page 2", "# Page 3"]);
  });

  it("never runs more requests at once than the concurrency limit", async () => {
    const urls = [1, 2, 3, 4, 5, 6].map((i) => url(`/wait?i=${i}`));
    const { documents } = await loadUrls(urls, { concurrency: 2 });
    expect(documents).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("follows a redirect and addresses the document by the final URL", async () => {
    const { documents } = await loadUrls(url("/redirect"));
    expect(documents[0]?.uri).toBe(url("/page"));
    expect(documents[0]?.id).toBe(documentId("default", url("/page")));
  });

  it("retries a 503 and succeeds", async () => {
    const { documents, failures } = await loadUrls(url("/flaky"), { retryDelayMs: 1 });
    expect(failures).toEqual([]);
    expect(documents[0]?.text.trim()).toBe("# Recovered");
    expect(attempts["/flaky"]).toBe(3);
  });

  it("gives up after the retry budget and reports the status", async () => {
    const { documents, failures } = await loadUrls(url("/flaky"), { retries: 1, retryDelayMs: 1 });
    expect(documents).toEqual([]);
    expect(failures[0]?.reason).toBe("HTTP 503 Service Unavailable");
    expect(attempts["/flaky"]).toBe(2);
  });

  it("honours Retry-After on a 429", async () => {
    const { documents } = await loadUrls(url("/throttled"), { retryDelayMs: 10_000 });
    expect(documents[0]?.text.trim()).toBe("# Allowed");
    expect(attempts["/throttled"]).toBe(2);
  });

  it("does not retry a 404", async () => {
    await loadUrls(url("/missing"), { retryDelayMs: 1 });
    expect(attempts["/missing"]).toBe(1);
  });

  it("reports a timeout instead of hanging", async () => {
    const { documents, failures } = await loadUrls(url("/slow"), { timeoutMs: 50, retries: 0 });
    expect(documents).toEqual([]);
    expect(failures).toEqual([{ uri: url("/slow"), reason: "timed out" }]);
  });

  it("refuses a content type it cannot read", async () => {
    const { failures } = await loadUrls(url("/pdf"));
    expect(failures[0]?.reason).toBe("unsupported content type: application/pdf");
  });

  it("refuses a response over the size limit before reading it", async () => {
    const { documents, failures } = await loadUrls(url("/big"), { maxBytes: 1024 });
    expect(documents).toEqual([]);
    expect(failures[0]?.reason).toContain("over the 1024 byte limit");
  });

  it("takes the title from the page, decoding entities", async () => {
    const { documents } = await loadUrls([url("/page"), url("/markdown"), url("/untitled")]);
    expect(documents.map((document) => document.title)).toEqual([
      "Billing & plans",
      "Reset your password",
      "untitled",
    ]);
  });

  it("records status, content type, size and validators", async () => {
    const { documents } = await loadUrls(url("/page"));
    expect(documents[0]?.metadata).toMatchObject({
      status: 200,
      contentType: "text/html; charset=utf-8",
      etag: 'W/"abc"',
    });
    expect(documents[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fetches a repeated URL once", async () => {
    const { documents } = await loadUrls([url("/page"), url("/page")]);
    expect(documents).toHaveLength(1);
    expect(attempts["/page"]).toBe(1);
  });

  it("scopes ids to the namespace", async () => {
    const acme = await loadUrls(url("/page"), { namespace: "acme" });
    const globex = await loadUrls(url("/page"), { namespace: "globex" });
    expect(acme.documents[0]?.id).not.toBe(globex.documents[0]?.id);
  });

  it("sends a descriptive user agent", async () => {
    const seen: string[] = [];
    await loadUrls(url("/page"), {
      fetch: async (_input, init) => {
        seen.push(String(new Headers(init?.headers).get("user-agent")));
        return new Response("<title>Stub</title>", { headers: { "content-type": "text/html" } });
      },
    });
    expect(seen[0]).toContain("openrag");
  });

  it("reports a network error after exhausting retries", async () => {
    const { documents, failures } = await loadUrls("http://127.0.0.1:1/page", {
      retries: 1,
      retryDelayMs: 1,
    });
    expect(documents).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  it("stops early when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    const { failures } = await loadUrls(url("/page"), { signal: controller.signal });
    expect(failures).toEqual([{ uri: url("/page"), reason: "cancelled" }]);
  });
});

describe("loadUrls under pressure", () => {
  it("waits between retries when the server gives no Retry-After", async () => {
    const at: number[] = [];
    const { failures } = await loadUrls(url("/flaky"), {
      retries: 2,
      retryDelayMs: 40,
      fetch: async () => {
        at.push(Date.now());
        return new Response("busy", { status: 503 });
      },
    });

    expect(failures).toHaveLength(1);
    expect(at).toHaveLength(3);
    // 40ms then 80ms, not three requests in the same millisecond
    expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(30);
    expect((at[2] as number) - (at[1] as number)).toBeGreaterThanOrEqual(70);
  });

  it("stops reading a body that runs past the limit, rather than buffering it", async () => {
    let pulled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulled++;
        if (pulled > 100) return controller.close();
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
    });

    const { documents, failures } = await loadUrls(url("/huge"), {
      maxBytes: 4096,
      fetch: async () => new Response(stream, { headers: { "content-type": "text/plain" } }),
    });

    expect(documents).toEqual([]);
    expect(failures[0]?.reason).toContain("over the 4096 byte limit");
    expect(pulled).toBeLessThan(10); // it stopped early instead of draining 100 KB
  });

  it("refuses an oversized response on the header alone", async () => {
    // An endless body: reading it instead of trusting the header never returns.
    const endless = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(64)));
      },
    });

    const { failures } = await loadUrls(url("/declared"), {
      maxBytes: 1024,
      fetch: async () =>
        new Response(endless, { headers: { "content-type": "text/plain", "content-length": "999999" } }),
    });

    expect(failures[0]?.reason).toContain("999999 bytes");
  });
});
