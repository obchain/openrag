import { describe, expect, it, vi } from "vitest";
import { planUpdate, type Snapshot } from "../src/sync/plan.js";
import type { Chunk, SourceDocument } from "../src/types.js";

const document = (id: string, contentHash: string): SourceDocument => ({
  id,
  namespace: "acme",
  uri: `${id}.md`,
  title: id,
  text: "…",
  contentHash,
});

const chunk = (docId: string, id: string): Chunk => ({
  id,
  docId,
  namespace: "acme",
  uri: `${docId}.md`,
  title: docId,
  headingPath: [],
  text: id,
  charStart: 0,
  charEnd: 1,
  tokens: 1,
  hash: id,
});

const snapshot = (documents: [string, string][], chunks: [string, string[]][]): Snapshot => ({
  documents: new Map(documents),
  chunks: new Map(chunks),
});

/** A clean read, unless a failure is passed in. */
const read = (documents: SourceDocument[], failures: { uri: string; reason: string }[] = []) => ({
  documents,
  failures,
});

const empty: Snapshot = snapshot([], []);

describe("planUpdate", () => {
  it("embeds everything the first time", () => {
    const plan = planUpdate(read([document("a", "h1")]), empty, () => [chunk("a", "a-1"), chunk("a", "a-2")]);
    expect(plan.embed.map((c) => c.id)).toEqual(["a-1", "a-2"]);
    expect(plan.keep).toEqual([]);
    expect(plan.summary).toEqual({ added: 1, updated: 0, unchanged: 0, deleted: 0, held: 0 });
  });

  it("does no work at all on a second run over unchanged documents", () => {
    const chunkOf = vi.fn(() => [chunk("a", "a-1")]);
    const plan = planUpdate(read([document("a", "h1")]), snapshot([["a", "h1"]], [["a", ["a-1"]]]), chunkOf);

    expect(plan.embed).toEqual([]);
    expect(plan.keep).toEqual(["a-1"]);
    expect(chunkOf).not.toHaveBeenCalled(); // not even parsed
    expect(plan.summary.unchanged).toBe(1);
  });

  it("embeds only the pieces that moved inside an edited document", () => {
    const before = snapshot([["a", "h1"]], [["a", ["a-1", "a-2", "a-3"]]]);
    const plan = planUpdate(read([document("a", "h2")]), before, () => [
      chunk("a", "a-1"),
      chunk("a", "a-NEW"), // the edited section
      chunk("a", "a-3"),
    ]);

    expect(plan.embed.map((c) => c.id)).toEqual(["a-NEW"]);
    // Their vectors stand, but their rows are rewritten: the edit moved them.
    expect(plan.restate.map((c) => c.id)).toEqual(["a-1", "a-3"]);
    expect(plan.keep).toEqual([]);
    expect(plan.remove).toEqual(["a-2"]);
    expect(plan.indexedDocuments).toEqual([{ docId: "a", contentHash: "h2" }]);
    expect(plan.summary).toEqual({ added: 0, updated: 1, unchanged: 0, deleted: 0, held: 0 });
  });

  it("removes a document that is gone from the source, and its chunks", () => {
    const before = snapshot(
      [
        ["a", "h1"],
        ["gone", "h9"],
      ],
      [
        ["a", ["a-1"]],
        ["gone", ["gone-1", "gone-2"]],
      ],
    );
    const plan = planUpdate(read([document("a", "h1")]), before, () => [chunk("a", "a-1")]);

    expect(plan.removedDocuments).toEqual(["gone"]);
    expect(plan.remove).toEqual(["gone-1", "gone-2"]);
    expect(plan.summary).toEqual({ added: 0, updated: 0, unchanged: 1, deleted: 1, held: 0 });
  });

  it("re-chunks a document the index has lost the pieces of, rather than trusting it", () => {
    const chunkOf = vi.fn(() => [chunk("a", "a-1")]);
    const plan = planUpdate(read([document("a", "h1")]), snapshot([["a", "h1"]], []), chunkOf);

    expect(chunkOf).toHaveBeenCalled();
    expect(plan.embed.map((c) => c.id)).toEqual(["a-1"]);
  });

  it("re-embeds nothing when an edit leaves the text alone", () => {
    // An html page whose navigation changed: a new content hash, the same prose.
    const before = snapshot([["a", "old-html"]], [["a", ["a-1", "a-2"]]]);
    const plan = planUpdate(read([document("a", "new-html")]), before, () => [
      chunk("a", "a-1"),
      chunk("a", "a-2"),
    ]);

    expect(plan.embed).toEqual([]);
    expect(plan.restate.map((c) => c.id)).toEqual(["a-1", "a-2"]);
    expect(plan.summary.updated).toBe(1);
    expect(plan.indexedDocuments).toEqual([{ docId: "a", contentHash: "new-html" }]);
  });

  it("handles a mixed run: one added, one edited, one untouched, one gone", () => {
    const before = snapshot(
      [
        ["edit", "h1"],
        ["same", "h2"],
        ["gone", "h3"],
      ],
      [
        ["edit", ["edit-1"]],
        ["same", ["same-1"]],
        ["gone", ["gone-1"]],
      ],
    );
    const plan = planUpdate(
      read([document("new", "h4"), document("edit", "h1-changed"), document("same", "h2")]),
      before,
      (d) => [chunk(d.id, `${d.id}-1${d.id === "edit" ? "b" : ""}`)],
    );

    expect(plan.summary).toEqual({ added: 1, updated: 1, unchanged: 1, deleted: 1, held: 0 });
    expect(plan.embed.map((c) => c.id)).toEqual(["new-1", "edit-1b"]);
    expect(plan.keep).toEqual(["same-1"]);
    expect(plan.restate).toEqual([]);
    expect(plan.remove).toEqual(["edit-1", "gone-1"]);
  });

  it("plans nothing for an empty source against an empty index", () => {
    const plan = planUpdate(read([]), empty, () => []);
    expect(plan).toEqual({
      embed: [],
      restate: [],
      keep: [],
      remove: [],
      removedDocuments: [],
      indexedDocuments: [],
      summary: { added: 0, updated: 0, unchanged: 0, deleted: 0, held: 0 },
    });
  });

  it("removes every chunk when the whole source is emptied", () => {
    const before = snapshot([["a", "h1"]], [["a", ["a-1", "a-2"]]]);
    const plan = planUpdate(read([]), before, () => []);
    expect(plan.remove).toEqual(["a-1", "a-2"]);
    expect(plan.removedDocuments).toEqual(["a"]);
    expect(plan.summary.deleted).toBe(1);
  });

  it("holds a missing document back when the read was not complete", () => {
    const before = snapshot([["a", "h1"]], [["a", ["a-1"]]]);
    const plan = planUpdate(read([], [{ uri: "a.md", reason: "EACCES" }]), before, () => []);

    expect(plan.remove).toEqual([]);
    expect(plan.removedDocuments).toEqual([]);
    // keep + embed + restate is the surviving set, so the held chunks are in it
    expect(plan.keep).toEqual(["a-1"]);
    expect(plan.summary).toEqual({ added: 0, updated: 0, unchanged: 0, deleted: 0, held: 1 });
  });

  it("sweeps chunks left behind by a half-written run", () => {
    const orphaned: Snapshot = { documents: new Map(), chunks: new Map([["orphan", ["o-1", "o-2"]]]) };
    const plan = planUpdate(read([]), orphaned, () => []);

    expect(plan.remove).toEqual(["o-1", "o-2"]);
    expect(plan.removedDocuments).toEqual(["orphan"]);
  });

  it("plans the same document once, however many times it is passed", () => {
    const chunkOf = vi.fn(() => [chunk("a", "a-1")]);
    const plan = planUpdate(
      read([document("a", "h2"), document("a", "h2")]),
      snapshot([["a", "h1"]], [["a", ["old"]]]),
      chunkOf,
    );

    expect(chunkOf).toHaveBeenCalledTimes(1);
    expect(plan.embed.map((c) => c.id)).toEqual(["a-1"]);
    expect(plan.remove).toEqual(["old"]);
    expect(plan.summary.updated).toBe(1);
  });

  it("leaves a document with nothing to index alone on the next run", () => {
    const chunkOf = vi.fn(() => []);
    const plan = planUpdate(
      read([document("stub", "h1")]),
      snapshot([["stub", "h1"]], [["stub", []]]),
      chunkOf,
    );

    expect(chunkOf).not.toHaveBeenCalled();
    expect(plan.summary).toEqual({ added: 0, updated: 0, unchanged: 1, deleted: 0, held: 0 });
  });
});
