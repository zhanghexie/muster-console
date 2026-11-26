import { normalizeContextUsage } from '../../../../shared/guiContextUsage';
import type { GuiContextUsage } from '../../types';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;

/** The last main-agent API message, not the result's cumulative billing totals. */
export class ClaudeContextUsage {
  private model = '';
  private input: number | null = null;
  private output = 0;
  private window = 0;
  private current: GuiContextUsage | null = null;

  get(): GuiContextUsage | null { return this.current; }

  observe(value: unknown): GuiContextUsage | null | undefined {
    const message = record(value);
    const kind = message.type;
    if ((kind === 'stream_event' || kind === 'assistant') && message.parent_tool_use_id) return undefined;
    if (kind === 'stream_event') {
      const event = record(message.event);
      if (event.type === 'message_start') return this.fresh(record(event.message));
      if (event.type === 'message_delta') {
        const output = count(record(event.usage).output_tokens);
        if (output === null || this.input === null) return undefined;
        this.output = output;
        return this.publish();
      }
    } else if (kind === 'assistant') {
      const assistant = record(message.message);
      if (assistant.usage && typeof assistant.usage === 'object') return this.fresh(assistant);
    } else if (kind === 'result' && this.model && this.input !== null) {
      const window = count(record(record(message.modelUsage)[this.model]).contextWindow);
      if (window !== null && window > 0) {
        this.window = window;
        return this.publish();
      }
    }
    return undefined;
  }

  private fresh(message: Record<string, unknown>): GuiContextUsage | null | undefined {
    const model = typeof message.model === 'string' ? message.model : '';
    if (model !== this.model) { this.model = model; this.window = 0; }
    const usage = record(message.usage);
    const input = count(usage.input_tokens);
    const cached = usage.cache_read_input_tokens == null ? 0 : count(usage.cache_read_input_tokens);
    const created = usage.cache_creation_input_tokens == null ? 0 : count(usage.cache_creation_input_tokens);
    const output = usage.output_tokens == null ? 0 : count(usage.output_tokens);
    if (input === null || cached === null || created === null || output === null) {
      this.input = null;
      return this.update(null);
    }
    this.input = input + cached + created;
    this.output = output;
    return this.publish();
  }

  private publish(): GuiContextUsage | null | undefined {
    return this.update(this.input === null ? null : normalizeContextUsage(this.input + this.output, this.window));
  }

  private update(next: GuiContextUsage | null): GuiContextUsage | null | undefined {
    if (this.current?.tokens === next?.tokens && this.current?.contextWindow === next?.contextWindow) return undefined;
    this.current = next;
    return next;
  }
}
