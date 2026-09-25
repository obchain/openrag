import { describe, expect, it } from "vitest";
import { parseMarkdown, splitFrontMatter } from "../src/parse/markdown.js";

describe("splitFrontMatter", () => {
  it("takes the title and reports how much it removed", () => {
    const source = '---\ntitle: "Refunds"\nsidebar_position: 3\n---\n\n# Refunds\nText.\n';
    const { title, body, offset } = splitFrontMatter(source);
    expect(title).toBe("Refunds");
    expect(body).toBe("\n# Refunds\nText.\n");
    expect(source.slice(offset)).toBe(body); // offset points back at the original file
  });

  it("leaves a page without front matter untouched", () => {
    const source = "# Refunds\nText.\n";
    expect(splitFrontMatter(source)).toEqual({ body: source, offset: 0 });
  });

  it("stops at the first closing fence, not a horizontal rule further down", () => {
    const source = "---\ntitle: A\n---\n\nIntro\n\n---\n\nMore\n";
    const { title, body } = splitFrontMatter(source);
    expect(title).toBe("A");
    expect(body).toContain("More");
  });

  it("returns no title when front matter has none", () => {
    const source = "---\nsidebar_position: 3\n---\n# Heading\n";
    const { title, body, offset } = splitFrontMatter(source);
    expect(title).toBeUndefined();
    expect(body).toBe("# Heading\n");
    expect(source.slice(offset)).toBe(body);
  });
});

const PAGE = `---
title: Billing and plans
---

import CtaBox from '@site/src/components/CtaBox';

# Billing

Intro line.

## Refunds

<CtaBox title="Try" />

We refund within 30 days.

### International

Bank transfers take longer.

## Account

Change your email in settings.
`;

describe("parseMarkdown", () => {
  it("slices the original file exactly, front matter and all", () => {
    for (const block of parseMarkdown(PAGE).blocks) {
      expect(PAGE.slice(block.charStart, block.charEnd)).toBe(block.text);
    }
  });

  it("prefers the front matter title and falls back to the first h1", () => {
    expect(parseMarkdown(PAGE).title).toBe("Billing and plans");
    expect(parseMarkdown("# Refunds\n\nText.\n").title).toBe("Refunds");
    expect(parseMarkdown("Text with no heading.\n").title).toBeUndefined();
  });

  it("tracks the heading path and closes deeper sections when one ends", () => {
    expect(parseMarkdown(PAGE).blocks.map((block) => block.headingPath)).toEqual([
      [],
      ["Refunds"],
      ["Refunds", "International"],
      ["Account"],
    ]);
  });

  it("drops mdx imports, components and embedded html", () => {
    const text = parseMarkdown(PAGE)
      .blocks.map((block) => block.text)
      .join("\n");
    expect(text).not.toContain("import CtaBox");
    expect(text).not.toContain("<CtaBox");
  });

  it("drops a head block that repeats the page, which would be indexed twice", () => {
    const page = `# Refunds\n\n<head>\n  <script>{"text":"We refund within 30 days."}</script>\n</head>\n\nWe refund within 30 days.\n`;
    const blocks = parseMarkdown(page).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("We refund within 30 days.");
  });

  it("reads a heading through its own markup and underlined form", () => {
    const page = "## Use the **API** [docs](/api)\n\nOne.\n\nHow to ask\n----------\n\nTwo.\n";
    expect(parseMarkdown(page).blocks.map((block) => block.headingPath)).toEqual([
      ["Use the API docs"],
      ["How to ask"],
    ]);
  });

  it("keeps code blocks, tables and lists as text", () => {
    const page =
      "## Setup\n\n```js\nconst a = 1;\n```\n\n| Plan | Window |\n| --- | --- |\n| Free | 30 days |\n\n- one\n- two\n";
    const text = parseMarkdown(page)
      .blocks.map((block) => block.text)
      .join("\n");
    expect(text).toContain("const a = 1;");
    expect(text).toContain("| Free | 30 days |");
    expect(text).toContain("- two");
  });

  it("returns no blocks for an empty page", () => {
    expect(parseMarkdown("")).toEqual({ title: undefined, blocks: [] });
  });
});

describe("parseMarkdown noise that only real pages show", () => {
  it("drops a component written across several lines, which arrives as a paragraph", () => {
    const page =
      '# Billing\n\n<CtaBox\n  headline="30 days free"\n  link="https://example.com"\n/>\n\nWe refund within 30 days.\n';
    const blocks = parseMarkdown(page).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("We refund within 30 days.");
  });

  it("keeps prose that merely mentions a tag, and an autolink", () => {
    const page = "## Setup\n\nPaste this in the `<head>` section of your page.\n\n<https://example.com>\n";
    const text = parseMarkdown(page)
      .blocks.map((block) => block.text)
      .join("\n");
    expect(text).toContain("`<head>` section");
    expect(text).toContain("<https://example.com>");
  });
});
