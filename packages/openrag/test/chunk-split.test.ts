import { describe, expect, it } from "vitest";
import { split } from "../src/chunk/split.js";
import { estimateTokens } from "../src/chunk/tokens.js";

/** One token per word keeps the tests readable. */
const words: (text: string) => number = (text) => text.trim().split(/\s+/).filter(Boolean).length;

describe("split", () => {
  it("leaves text that already fits as one piece", () => {
    expect(split("One two three.", 10, words)).toEqual(["One two three."]);
  });

  it("breaks at a sentence end rather than mid-sentence", () => {
    const text = "Refunds land within 30 days. Bank transfers take longer. Contact support for help.";
    expect(split(text, 6, words)).toEqual([
      "Refunds land within 30 days.",
      "Bank transfers take longer.",
      "Contact support for help.",
    ]);
  });

  it("does not cut inside a url, where the segmenter sees a sentence end", () => {
    // The segmenter reads the url's `?` as a sentence end, and the budget runs
    // out exactly there, so without the guard the url is torn in two.
    const text =
      "Install it from https://play.google.com/store/apps/details?id=io.ente.auth today. Then open it.";
    const pieces = split(text, 5, words);
    expect(pieces.some((piece) => piece.includes("details?id=io.ente.auth"))).toBe(true);
    for (const piece of pieces) {
      expect(piece).not.toMatch(/details\?$/);
      expect(piece).not.toMatch(/^id=/);
    }
  });

  it("still breaks after a sentence that merely ends with a url", () => {
    const text = "Read the guide at https://example.com. Then many more words follow here after it.";
    expect(split(text, 8, words)).toEqual([
      "Read the guide at https://example.com.",
      "Then many more words follow here after it.",
    ]);
  });

  it("falls back to word boundaries for a sentence longer than the budget", () => {
    const pieces = split("alpha beta gamma delta epsilon zeta eta theta", 3, words);
    expect(pieces).toEqual(["alpha beta gamma", "delta epsilon zeta", "eta theta"]);
  });

  it("never returns a piece over the budget, even for one long unbroken word", () => {
    const text = `prefix ${"a".repeat(400)} suffix`;
    for (const piece of split(text, 20, estimateTokens)) {
      expect(estimateTokens(piece)).toBeLessThanOrEqual(20);
    }
  });

  it("keeps every word, in order", () => {
    const text = "Refunds land within 30 days. Bank transfers take longer than cards do.";
    expect(split(text, 4, words).join(" ")).toBe(text);
  });

  it("returns nothing for blank text", () => {
    expect(split("   \n  ", 10, words)).toEqual([]);
  });
});
