/**
 * Minimal glob matching for include/exclude lists: `*` inside one path segment,
 * `?` for a single character, `**` across segments. Paths are always compared
 * with `/` separators. Small enough to keep the package dependency-free.
 */

const RESERVED = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "?") {
      source += "[^/]";
    } else if (char !== "*") {
      source += char.replace(RESERVED, "\\$&");
    } else if (pattern.charAt(i + 1) !== "*") {
      source += "[^/]*";
    } else if (pattern.charAt(i + 2) === "/") {
      source += "(?:[^/]*/)*"; // `**/` is zero or more directories
      i += 2;
    } else {
      source += ".*";
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

export function compileGlobs(patterns: readonly string[]): RegExp[] {
  return patterns.map(globToRegExp);
}

/**
 * The same patterns, aimed at directories: `**\/node_modules/**` should prune
 * the `node_modules` directory itself, so the trailing `/**` comes off.
 */
export function compileDirectoryGlobs(patterns: readonly string[]): RegExp[] {
  return patterns.map((pattern) => globToRegExp(pattern.replace(/\/\*\*$/, "")));
}

export function matchesAny(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}
