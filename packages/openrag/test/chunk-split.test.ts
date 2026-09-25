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
    const text = "Install it from https://play.google.com/store/apps/details?id=io.ente.auth today.";
    for (const piece of split(text, 8, words)) {
      expect(piece).not.toMatch(/details\?$/);
    }
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
