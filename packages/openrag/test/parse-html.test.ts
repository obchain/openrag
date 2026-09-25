import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/parse/html.js";

const PAGE = `<!doctype html>
<html>
  <head><title>Refunds | Acme docs</title><script>var a = 1;</script><style>body{}</style></head>
  <body>
    <header><a href="/">Acme</a><nav><a href="/pricing">Pricing</a><a href="/login">Login</a></nav></header>
    <main>
      <header><h1>Refunds</h1></header>
      <div class="toc-whatever">
        <p>On this page</p>
        <ul><li><a href="#how-long">How long</a></li><li><a href="#how-to">How to ask</a></li></ul>
      </div>
      <p>You can cancel at any time. See <a href="/docs/billing">billing</a>.</p>
      <h2>How long<a class="hash-link" href="#how-long" title="Direct link"></a></h2>
      <p>Refunds land within 30 days.</p>
      <h3>International</h3>
      <ul><li>Bank transfers take longer.</li></ul>
      <pre><code>curl https://api.acme.com/refund</code></pre>
      <img src="/img/refund.png" alt="The refund button">
      <aside>Related: <a href="/docs/plans">plans</a></aside>
    </main>
    <footer>Copyright Acme</footer>
  </body>
</html>`;

describe("parseHtml", () => {
  const parsed = parseHtml(PAGE, { url: "https://acme.com/docs/refunds" });
  const text = parsed.text;

  it("drops the site header, nav, footer, scripts and styles", () => {
    for (const junk of ["Pricing", "Login", "Copyright Acme", "var a = 1", "body{}"]) {
      expect(text).not.toContain(junk);
    }
  });

  it("keeps the article's own header, so the page title survives", () => {
    expect(parsed.title).toBe("Refunds");
  });

  it("falls back to the tab title when the page has no h1", () => {
    expect(
      parseHtml("<html><head><title>Plans | Acme</title></head><body><p>Hi</p></body></html>").title,
    ).toBe("Plans | Acme");
  });

  it("drops a table of contents, being a list of links into the same page", () => {
    expect(text).not.toContain("#how-long");
    expect(text).toContain("Refunds land within 30 days.");
  });

  it("drops links that carry no words, such as heading permalinks", () => {
    expect(text).not.toContain("Direct link");
    expect(text).toContain("## How long");
  });

  it("resolves a relative link against the page url", () => {
    expect(text).toContain("https://acme.com/docs/billing");
  });

  it("keeps heading levels, so the chunker still sees the structure", () => {
    expect(parsed.blocks.map((block) => block.headingPath)).toEqual([
      [],
      [],
      ["How long"],
      ["How long", "International"],
      ["How long", "International"],
      ["How long", "International"],
    ]);
  });

  it("keeps lists and code as text", () => {
    expect(text).toContain("Bank transfers take longer.");
    expect(text).toContain("curl https://api.acme.com/refund");
  });

  it("keeps an image's alt text and drops its url", () => {
    expect(text).toContain("The refund button");
    expect(text).not.toContain("/img/refund.png");
  });

  it("offsets point into the converted text", () => {
    for (const block of parsed.blocks) {
      expect(parsed.text.slice(block.charStart, block.charEnd)).toBe(block.text);
    }
  });

  it("uses the aria landmark when a page has no main or article", () => {
    const page =
      '<body><div class="related" role="navigation">Navigation index modules</div>' +
      '<div role="main"><h1>Plans</h1><p>Body text.</p></div>' +
      '<div class="footer">Copyright 2001</div></body>';
    const parsed = parseHtml(page);
    expect(parsed.title).toBe("Plans");
    expect(parsed.blocks.map((block) => block.text)).toEqual(["Body text."]);
    expect(parsed.text).not.toContain("Navigation");
    expect(parsed.text).not.toContain("Copyright");
  });

  it("strips header and footer by tag when the page marks no main", () => {
    const page = "<body><header>Menu</header><h1>Plans</h1><p>Body text.</p><footer>Legal</footer></body>";
    const plain = parseHtml(page);
    expect(plain.text).not.toContain("Menu");
    expect(plain.text).not.toContain("Legal");
    expect(plain.text).toContain("Body text.");
  });
});
