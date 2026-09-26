// Incremental Ollama NDJSON stream parser (§16.5).
// Tolerates arbitrary network chunk boundaries, multiple JSON objects per chunk,
// partial objects, UTF-8 splits (caller decodes with TextDecoder streaming),
// malformed chunks (skipped, surfaced via onErrorChunk), and done signals.
//
// The thinking channel is emitted separately from content. Ollama streams it as
// `message.thinking`, separate from `message.content`, and a reasoning model
// that spends its whole budget there returns a 0-byte `content`. Ignoring the
// field is why that looked like a silent failure; remembering that it happened
// is what lets the caller explain it, and forwarding the text is what lets the
// UI show the reasoning log instead of only counting it.

export interface ChatChunk {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  error?: string;
  /**
   * Why generation stopped. `length` means a cap was hit, and which cap matters:
   * `num_predict` or the context window. Ollama reports the token counts on the
   * final chunk either way, so the caller can tell "we asked for 4096 and got
   * 4096" from "only 900 were available because the prompt filled the window".
   */
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface StreamBudget {
  reason: string | null;
  promptTokens: number | null;
  generatedTokens: number | null;
}

export class OllamaStreamParser {
  private buffer = '';
  private thinkingChars = 0;
  private doneReason: string | null = null;
  private promptTokens: number | null = null;
  private generatedTokens: number | null = null;
  malformedChunks = 0;

  /** Whether any reasoning content arrived, regardless of what was shown. */
  sawThinking(): boolean {
    return this.thinkingChars > 0;
  }

  /** Total reasoning characters received. Diagnostic only. */
  thinkingLength(): number {
    return this.thinkingChars;
  }

  /**
   * What the server said about the budget. `reason: 'length'` with a
   * `generatedTokens` far below the requested cap means the context window, not
   * `num_predict`, was the binding constraint — which is a different problem
   * with a different fix, and one the user cannot see from a 25-character answer.
   */
  budget(): StreamBudget {
    return {
      reason: this.doneReason,
      promptTokens: this.promptTokens,
      generatedTokens: this.generatedTokens,
    };
  }

  private consume(
    obj: ChatChunk,
    onContent: (content: string) => void,
    onThinking?: (thinking: string) => void,
  ): void {
    if (typeof obj.message?.thinking === 'string' && obj.message.thinking) {
      this.thinkingChars += obj.message.thinking.length;
      onThinking?.(obj.message.thinking);
    }
    if (typeof obj.message?.content === 'string' && obj.message.content) {
      onContent(obj.message.content);
    }
    if (obj.done === true) {
      if (typeof obj.done_reason === 'string') this.doneReason = obj.done_reason;
      if (typeof obj.prompt_eval_count === 'number') this.promptTokens = obj.prompt_eval_count;
      if (typeof obj.eval_count === 'number') this.generatedTokens = obj.eval_count;
    }
  }

  /** Feed a decoded text fragment. Returns newly completed content pieces. */
  push(
    text: string,
    onContent: (content: string) => void,
    onDone?: () => void,
    onServerError?: (msg: string) => void,
    onThinking?: (thinking: string) => void,
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
      this.consume(obj, onContent, onThinking);
      if (obj.done === true) {
        onDone?.();
      }
    }
  }

  /** Flush any remaining buffered line at stream end. */
  flush(
    onContent: (content: string) => void,
    onDone?: () => void,
    onThinking?: (thinking: string) => void,
  ): void {
    const trimmed = this.buffer.trim();
    this.buffer = '';
    if (!trimmed) return;
    try {
      const obj = JSON.parse(trimmed) as ChatChunk;
      this.consume(obj, onContent, onThinking);
      if (obj.done === true) onDone?.();
    } catch {
      this.malformedChunks += 1;
    }
  }
}
