// Incremental Ollama NDJSON stream parser (§16.5).
// Tolerates arbitrary network chunk boundaries, multiple JSON objects per chunk,
// partial objects, UTF-8 splits (caller decodes with TextDecoder streaming),
// malformed chunks (skipped, surfaced via onErrorChunk), and done signals.

export interface ChatChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

export class OllamaStreamParser {
  private buffer = '';
  malformedChunks = 0;

  /** Feed a decoded text fragment. Returns newly completed content pieces. */
  push(
    text: string,
    onContent: (content: string) => void,
    onDone?: () => void,
    onServerError?: (msg: string) => void,
  ): void {
    this.buffer += text;
    // Split on newlines; keep trailing partial line in buffer.
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: ChatChunk;
      try {
        obj = JSON.parse(trimmed) as ChatChunk;
      } catch {
        this.malformedChunks += 1;
        continue;
      }
      if (typeof obj.error === 'string' && obj.error) {
        onServerError?.(obj.error);
        continue;
      }
      if (typeof obj.message?.content === 'string' && obj.message.content) {
        onContent(obj.message.content);
      }
      if (obj.done === true) {
        onDone?.();
      }
    }
  }

  /** Flush any remaining buffered line at stream end. */
  flush(
    onContent: (content: string) => void,
    onDone?: () => void,
  ): void {
    const trimmed = this.buffer.trim();
    this.buffer = '';
    if (!trimmed) return;
    try {
      const obj = JSON.parse(trimmed) as ChatChunk;
      if (typeof obj.message?.content === 'string' && obj.message.content) {
        onContent(obj.message.content);
      }
      if (obj.done === true) onDone?.();
    } catch {
      this.malformedChunks += 1;
    }
  }
}
