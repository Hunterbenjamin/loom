// Text on its way into a pane. tmux's own paste path rewrites line endings (spike 06 turned
// `\r\n` into `\n\n`, where Herdr produced `\n`), and a single `set-buffer` longer than tmux's
// CLI message limit fails with `command too long`, so both are handled here rather than left
// to the transport.

/** tmux's CLI message limit bit at 20 KB in spike 06; chunk well inside it, in bytes. */
export const CHUNK_BYTES = 2048;

/**
 * CRLF and lone CR both become LF before transport, so what the provider confirms can be
 * compared against what Loom recorded. Core's `normalizeText` hashes the same shape.
 */
export const normalizeNewlines = (text: string): string =>
  text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

/**
 * Split into chunks of at most `CHUNK_BYTES` UTF-8 bytes, never inside a code point. A
 * character-count bound is wrong: one emoji is four bytes, and a chunk boundary in the middle
 * of one reaches tmux as two invalid sequences.
 */
export function chunkByBytes(
  text: string,
  limit: number = CHUNK_BYTES,
): string[] {
  if (limit < 4) throw new RangeError("chunk limit must fit one code point");
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > limit) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += codePoint;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/**
 * A leading `/` or `!` is a TUI command in both providers, not a prompt: spike 06 sent five
 * slash and six bang fixtures and got zero `UserPromptSubmit`. The host refuses them rather
 * than writing something the provider will silently interpret.
 */
export const isCommandPrefix = (text: string): boolean =>
  /^\s*[/!]/u.test(text);
