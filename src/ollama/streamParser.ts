// Incremental Ollama NDJSON stream parser (§16.5).
// Tolerates arbitrary network chunk boundaries, multiple JSON objects per chunk,
// partial objects, UTF-8 splits (caller decodes with TextDecoder streaming),
// malformed chunks (skipped, surfaced via onErrorChunk), and done signals.
//
// The thinking channel is counted but never emitted. Ollama streams it as
// `message.thinking`, separate from `message.content`, and a reasoning model
// that spends its whole budget there returns a 0-byte `content`. Ignoring the
// field is why that looked like a silent failure; remembering that it happened
// is what lets the caller explain it.

export interface ChatChunk {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  error?: string;
}

export class OllamaStreamParser {
  private buffer = '';
  private thinkingChars = 0;
  malformedChunks = 0;

  /** Whether any reasoning content arrived, regardless of what was shown. */
  sawThinking(): boolean {
    return this.thinkingChars > 0;
  }

  /** Total reasoning characters received. Diagnostic only. */
  thinkingLength(): number {
    return this.thinkingChars;
  }

  private consume(obj: ChatChunk, onContent: (content: string) => void): void {
    if (typeof obj.message?.thinking === 'string' && obj.message.thinking) {
      this.thinkingChars += obj.message.thinking.length;
    }
    if (typeof obj.message?.content === 'string' && obj.message.content) {
      onContent(obj.message.content);
    }
  }

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
      this.consume(obj, onContent);
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
      this.consume(obj, onContent);
      if (obj.done === true) onDone?.();
    } catch {
      this.malformedChunks += 1;
    }
  }
}
