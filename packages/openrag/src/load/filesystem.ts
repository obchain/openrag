import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { documentId, sha256 } from "../hash.js";
import type { LoadFailure, LoadResult, Namespace, SourceDocument } from "../types.js";
import { compileDirectoryGlobs, compileGlobs, matchesAny } from "./glob.js";

/** Text formats we know how to index. Anything else has to be asked for explicitly. */
export const DEFAULT_INCLUDE = [
  "**/*.md",
  "**/*.mdx",
  "**/*.markdown",
  "**/*.txt",
  "**/*.html",
  "**/*.htm",
] as const;

export const DEFAULT_EXCLUDE = ["**/.*", "**/.*/**", "**/node_modules/**"] as const;

/** 5 MB. A documentation page is never this big; something else is. */
export const DEFAULT_MAX_BYTES = 5_000_000;

export interface FilesystemOptions {
  namespace?: Namespace;
  include?: readonly string[];
  exclude?: readonly string[];
  /**
   * Base directory that uris are relative to. Defaults to the folder passed in,
   * or to the common parent when several paths are passed.
   */
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
  const include = compileGlobs(options.include ?? DEFAULT_INCLUDE);
  const exclude = compileGlobs(options.exclude ?? DEFAULT_EXCLUDE);
  const excludeDirectories = compileDirectoryGlobs(options.exclude ?? DEFAULT_EXCLUDE);
  const failures: LoadFailure[] = [];

  const inputs = (typeof input === "string" ? [input] : input).map((entry) => path.resolve(entry));
  const directories: string[] = [];
  const named: string[] = [];
  for (const absolute of inputs) {
    try {
      const stats = await stat(absolute);
      (stats.isDirectory() ? directories : named).push(absolute);
    } catch (error) {
      failures.push({ uri: absolute, reason: reasonFor(error) });
    }
  }

  const root = options.root ? path.resolve(options.root) : defaultRoot(directories, named);
  const found: string[] = [...named];
  for (const directory of directories) {
    await walk(directory, { root, include, exclude, excludeDirectories, found, failures });
  }

  const documents: SourceDocument[] = [];
  const files = [...new Set(found)]
    .map((absolute) => ({ absolute, uri: toUri(root, absolute) }))
    .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));

  for (const { absolute, uri } of files) {
    try {
      const stats = await stat(absolute);
      if (stats.size > maxBytes) {
        failures.push({ uri, reason: `file is ${stats.size} bytes, over the ${maxBytes} byte limit` });
        continue;
      }
      const bytes = await readFile(absolute);
      const text = bytes.toString("utf8");
      if (text.includes("\u0000")) {
        failures.push({ uri, reason: "looks like a binary file" });
        continue;
      }
      documents.push({
        id: documentId(namespace, uri),
        namespace,
        uri,
        title: titleFromUri(uri),
        text,
        contentHash: sha256(bytes),
        metadata: { bytes: stats.size, modifiedAt: stats.mtime.toISOString() },
      });
    } catch (error) {
      failures.push({ uri, reason: reasonFor(error) });
    }
  }

  return { documents, failures };
}

interface WalkContext {
  root: string;
  include: RegExp[];
  exclude: RegExp[];
  excludeDirectories: RegExp[];
  found: string[];
  failures: LoadFailure[];
}

async function walk(directory: string, context: WalkContext): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    context.failures.push({ uri: toUri(context.root, directory), reason: reasonFor(error) });
    return;
  }

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const uri = toUri(context.root, absolute);
    if (entry.isSymbolicLink()) {
      // Following links would mean cycle detection and reading outside the root.
      context.failures.push({ uri, reason: "symbolic link skipped" });
    } else if (entry.isDirectory()) {
      if (!matchesAny(uri, context.excludeDirectories)) await walk(absolute, context);
    } else if (entry.isFile()) {
      if (!matchesAny(uri, context.exclude) && matchesAny(uri, context.include)) context.found.push(absolute);
    }
  }
}

/** Uris are relative and always `/`-separated, so an id is the same on any machine. */
function toUri(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  return (relative === "" ? path.basename(absolute) : relative).split(path.sep).join("/");
}

function defaultRoot(directories: readonly string[], named: readonly string[]): string {
  if (directories.length === 1 && named.length === 0) return directories[0] as string;
  const bases = [...directories, ...named.map((file) => path.dirname(file))];
  if (bases.length === 0) return process.cwd();
  return commonParent(bases);
}

function commonParent(paths: readonly string[]): string {
  const split = paths.map((entry) => entry.split(path.sep));
  const first = split[0] as string[];
  let shared = first.length;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < shared && i < parts.length && parts[i] === first[i]) i++;
    shared = i;
  }
  return first.slice(0, shared).join(path.sep) || path.sep;
}

/**
 * A readable placeholder from the path. The parsing step replaces it with the
 * document's real heading once it has one.
 */
function titleFromUri(uri: string): string {
  const base = path.posix.basename(uri, path.posix.extname(uri));
  const folder = path.posix.basename(path.posix.dirname(uri));
  const name = (base === "index" || base.toLowerCase() === "readme") && folder !== "" ? folder : base;
  const title = name.replace(/[-_]+/g, " ").trim();
  return title === "" || title === "." ? base : title;
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
