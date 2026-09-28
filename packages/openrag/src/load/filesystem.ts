import fs from "node:fs/promises";
import path from "node:path";
import { documentId, sha256 } from "../hash.js";
import type { LoadFailure, LoadResult, Namespace, SourceDocument } from "../types.js";
import { DEFAULT_MAX_BYTES, reasonFor } from "./shared.js";

/** Text formats we know how to index. Anything else has to be asked for explicitly. */
export const DEFAULT_INCLUDE = [
  "**/*.md",
  "**/*.mdx",
  "**/*.markdown",
  "**/*.txt",
  "**/*.html",
  "**/*.htm",
] as const;

/** Dotfiles and dot folders need no pattern: `fs.glob` already leaves them out. */
export const DEFAULT_EXCLUDE = ["**/node_modules/**"] as const;

export { DEFAULT_MAX_BYTES } from "./shared.js";

/** How many files are read at once. Enough to hide latency, few enough to keep file handles sane. */
const READ_BATCH = 16;

export interface FilesystemOptions {
  namespace?: Namespace;
  include?: readonly string[];
  exclude?: readonly string[];
  /** Base directory that uris are relative to. Defaults to the path passed in. */
  root?: string;
  maxBytes?: number;
}

/**
 * Read documents from a folder, a file, or a list of either. Never writes to the
 * source, and never throws on a bad file: unreadable entries come back in
 * `failures` so a partial run can't quietly look like a complete one.
 */
export async function loadFiles(
  input: string | readonly string[],
  options: FilesystemOptions = {},
): Promise<LoadResult> {
  const namespace = options.namespace ?? "default";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  const failures: LoadFailure[] = [];

  const directories: string[] = [];
  const found: string[] = [];
  for (const entry of typeof input === "string" ? [input] : input) {
    const absolute = path.resolve(entry);
    try {
      // A file named outright is loaded whatever the include patterns say.
      ((await fs.stat(absolute)).isDirectory() ? directories : found).push(absolute);
    } catch (error) {
      failures.push({ uri: absolute, reason: reasonFor(error) });
    }
  }

  // Uris, and therefore ids, must not depend on the order the paths were passed
  // in: a different order would rename every document and re-embed the corpus.
  const root = path.resolve(options.root ?? commonParent([...directories, ...found.map(path.dirname)]));
  for (const directory of directories) {
    const glob = fs.glob(options.include ?? DEFAULT_INCLUDE, {
      cwd: directory,
      withFileTypes: true,
      exclude: (entry) => isExcluded(path.relative(directory, absoluteOf(entry)), exclude),
    });
    for await (const entry of glob) {
      // Following a link would mean cycle detection and reading outside the root.
      if (entry.isSymbolicLink())
        failures.push({ uri: toUri(root, absoluteOf(entry)), reason: "symbolic link skipped" });
      else if (entry.isFile()) found.push(absoluteOf(entry));
    }
  }

  const targets = [...new Set(found)]
    .map((absolute) => ({ absolute, uri: toUri(root, absolute) }))
    .sort((a, b) => (a.uri < b.uri ? -1 : 1));

  const read = async ({ absolute, uri }: { absolute: string; uri: string }) => {
    try {
      const stats = await fs.stat(absolute);
      if (stats.size > maxBytes) {
        return { failure: { uri, reason: `file is ${stats.size} bytes, over the ${maxBytes} byte limit` } };
      }
      const bytes = await fs.readFile(absolute);
      const text = bytes.toString("utf8");
      if (text.includes("\u0000")) return { failure: { uri, reason: "looks like a binary file" } };
      return {
        document: {
          id: documentId(namespace, uri),
          namespace,
          uri,
          // A placeholder: parsing replaces it with the page's own title.
          title: path.basename(uri, path.extname(uri)).replace(/[-_]+/g, " "),
          text,
          contentHash: sha256(bytes),
          metadata: { bytes: stats.size, modifiedAt: stats.mtime.toISOString() },
        } satisfies SourceDocument,
      };
    } catch (error) {
      return { failure: { uri, reason: reasonFor(error) } };
    }
  };

  // A batch at a time: reading one file after another is latency-bound on a
  // network share, and results stay in uri order either way.
  const documents: SourceDocument[] = [];
  for (let at = 0; at < targets.length; at += READ_BATCH) {
    for (const result of await Promise.all(targets.slice(at, at + READ_BATCH).map(read))) {
      if (result.document) documents.push(result.document);
      else if (result.failure) failures.push(result.failure);
    }
  }

  return { documents, failures };
}

const absoluteOf = (entry: { parentPath: string; name: string }) => path.join(entry.parentPath, entry.name);

/** A pattern ending in `/**` also names the folder itself, which is what prunes it. */
const isExcluded = (relative: string, patterns: readonly string[]) =>
  patterns.some(
    (pattern) =>
      path.matchesGlob(relative, pattern) || path.matchesGlob(relative, pattern.replace(/\/\*\*$/, "")),
  );

/** The deepest folder that holds every path given, so uris stay relative to it. */
function commonParent(paths: readonly string[]): string {
  if (paths.length === 0) return process.cwd();
  const [first = "", ...rest] = paths.map((entry) => entry.split(path.sep));
  let shared = (first as string[]).length;
  for (const parts of rest) {
    let i = 0;
    while (i < shared && i < parts.length && parts[i] === (first as string[])[i]) i++;
    shared = i;
  }
  return (first as string[]).slice(0, shared).join(path.sep) || path.sep;
}

/** Uris are relative and always `/`-separated, so an id is the same on any machine. */
const toUri = (root: string, absolute: string) => path.relative(root, absolute).split(path.sep).join("/");
