/** 5 MB. A documentation page is never this big; something else is. */
export const DEFAULT_MAX_BYTES = 5_000_000;

/** One wording for a failure, whether it came off a disk or off the network. */
export function reasonFor(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "timed out" : error.message;
  return String(error);
}
