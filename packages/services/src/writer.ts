import Anthropic from '@anthropic-ai/sdk';
import { ServiceError } from './errors';

// The direct generation path's model call (spec §16.1). Behind an interface, so tests and
// other providers can stand in. The default uses the Claude API with the user's key from
// the secret store.

export interface WriterMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ReportWriter {
  /** One completion: the report body as Markdown, and the model that wrote it. */
  write(req: {
    system: string;
    messages: WriterMessage[];
  }): Promise<{ text: string; model: string }>;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

export function claudeWriter(apiKey: string, model: string = DEFAULT_MODEL): ReportWriter {
  const client = new Anthropic({ apiKey });
  return {
    async write(req) {
      let message: Anthropic.Beta.BetaMessage;
      try {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: 64_000,
          // On a policy decline, the API re-runs the request on a fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'high' },
          // The system prompt is the same for every report: cache it.
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: req.messages,
        });
        message = await stream.finalMessage();
      } catch (e) {
        if (
          e instanceof Anthropic.AuthenticationError ||
          e instanceof Anthropic.PermissionDeniedError
        ) {
          throw new ServiceError(
            400,
            'bad_request',
            'The Claude API key was refused; replace it in Settings → AI',
          );
        }
        if (e instanceof Anthropic.RateLimitError) {
          throw new ServiceError(
            503,
            'internal',
            'The Claude API is rate limiting this key; try again shortly',
          );
        }
        if (e instanceof Anthropic.APIError) {
          throw new ServiceError(
            502,
            'internal',
            `The Claude API failed (${e.status ?? 'network'}): ${e.message}`,
          );
        }
        throw e;
      }
      if (message.stop_reason === 'refusal') {
        throw new ServiceError(422, 'bad_request', 'The model declined to write this report');
      }
      if (message.stop_reason === 'max_tokens') {
        throw new ServiceError(422, 'bad_request', 'The report was cut off at the output limit');
      }
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { text, model: message.model };
    },
  };
}
