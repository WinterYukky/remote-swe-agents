import { describe, expect, test } from 'vitest';
import { deepMerge, preProcessInput } from './converse';
import { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';

const baseInput = (userText = 'hello'): ConverseCommandInput => ({
  modelId: 'dummy',
  messages: [{ role: 'user', content: [{ text: userText }] }],
});

describe('deepMerge', () => {
  test('merges flat objects', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test('later values override earlier ones', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  test('concatenates arrays', () => {
    expect(deepMerge({ arr: ['a'] }, { arr: ['b'] })).toEqual({ arr: ['a', 'b'] });
  });

  test('deep merges nested objects', () => {
    expect(deepMerge({ nested: { a: 1, b: 2 } }, { nested: { b: 3, c: 4 } })).toEqual({ nested: { a: 1, b: 3, c: 4 } });
  });

  test('merges three objects with array concatenation', () => {
    expect(deepMerge({ arr: ['a'] }, { arr: ['b'] }, { arr: ['c'] })).toEqual({ arr: ['a', 'b', 'c'] });
  });

  test('returns empty object for no inputs', () => {
    expect(deepMerge()).toEqual({});
  });
});

describe('preProcessInput', () => {
  describe('reasoning model with interleaved thinking (sonnet4.6)', () => {
    test('sets reasoning_config and interleaved-thinking beta header', () => {
      const { input } = preProcessInput(baseInput(), 'sonnet4.6', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning_config).toEqual({
        type: 'enabled',
        budget_tokens: 2000,
      });
      expect(fields.anthropic_beta).toEqual(['interleaved-thinking-2025-05-14']);
    });
  });

  describe('long context model with reasoning (sonnet4.6-long-context-mode)', () => {
    test('merges reasoning, interleaved-thinking and long context beta headers', () => {
      const { input } = preProcessInput(baseInput(), 'sonnet4.6-long-context-mode', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning_config).toEqual({
        type: 'enabled',
        budget_tokens: 2000,
      });
      expect(fields.anthropic_beta).toEqual(
        expect.arrayContaining(['interleaved-thinking-2025-05-14', 'context-1m-2025-08-07'])
      );
      expect((fields.anthropic_beta as string[]).length).toBe(2);
    });
  });

  describe('non-reasoning model (sonnet3.5)', () => {
    test('does not set reasoning_config or beta headers', () => {
      const { input } = preProcessInput(baseInput(), 'sonnet3.5', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(fields?.reasoning_config).toBeUndefined();
      expect(fields?.anthropic_beta).toBeUndefined();
    });
  });

  describe('non-reasoning model strips reasoningContent', () => {
    test('removes reasoningContent from messages', () => {
      const input: ConverseCommandInput = {
        modelId: 'dummy',
        messages: [
          { role: 'user', content: [{ text: 'hello' }] },
          {
            role: 'assistant',
            content: [{ reasoningContent: { reasoningText: { text: 'thinking...' } } } as any, { text: 'response' }],
          },
          { role: 'user', content: [{ text: 'follow up' }] },
        ],
      };
      const { input: processed } = preProcessInput(input, 'sonnet3.5', 0);
      const assistantContent = processed.messages![1].content!;
      expect(assistantContent).toHaveLength(1);
      expect(assistantContent[0]).toEqual({ text: 'response' });
    });
  });

  describe('reasoning model without interleaved thinking (sonnet3.7)', () => {
    test('sets reasoning_config but no interleaved-thinking header', () => {
      const { input } = preProcessInput(baseInput(), 'sonnet3.7', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning_config).toEqual({
        type: 'enabled',
        budget_tokens: 2000,
      });
      expect(fields.anthropic_beta).toBeUndefined();
    });
  });

  describe('long context model without reasoning enabled', () => {
    test('only sets long context beta header when reasoning is disabled by toolChoice', () => {
      const input: ConverseCommandInput = {
        modelId: 'dummy',
        messages: [{ role: 'user', content: [{ text: 'hello' }] }],
        toolConfig: {
          toolChoice: { any: {} },
          tools: [{ toolSpec: { name: 'test', inputSchema: { json: {} } } }],
        },
      };
      const { input: processed } = preProcessInput(input, 'sonnet4.6-long-context-mode', 0);
      const fields = processed.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning_config).toBeUndefined();
      expect(fields.anthropic_beta).toEqual(['context-1m-2025-08-07']);
    });
  });

  describe('ultrathink keyword', () => {
    test('increases thinking budget when ultrathink is in user message', () => {
      const { input, thinkingBudget } = preProcessInput(baseInput('please ultrathink this'), 'sonnet4.6', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      const config = fields.reasoning_config as { budget_tokens: number };
      expect(config.budget_tokens).toBeGreaterThan(2000);
      expect(thinkingBudget).toBe(config.budget_tokens);
    });

    test('does not increase budget without ultrathink keyword', () => {
      const { thinkingBudget } = preProcessInput(baseInput('just a normal message'), 'sonnet4.6', 0);
      expect(thinkingBudget).toBeUndefined();
    });
  });

  describe('assistant message prefill normalization', () => {
    const withTrailingAssistant = (): ConverseCommandInput => ({
      modelId: 'dummy',
      messages: [
        { role: 'user', content: [{ text: 'Count to 3.' }] },
        { role: 'assistant', content: [{ text: '1, 2, 3.' }] },
      ],
    });

    test('strips trailing assistant for prefill-unsupported model (sonnet5)', () => {
      const { input } = preProcessInput(withTrailingAssistant(), 'sonnet5', 0);
      expect(input.messages?.map((m) => m.role)).toEqual(['user']);
    });

    test('keeps trailing assistant for prefill-supported model (sonnet4.5)', () => {
      const { input } = preProcessInput(withTrailingAssistant(), 'sonnet4.5', 0);
      expect(input.messages?.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    test('strips multiple trailing assistant messages for sonnet5', () => {
      const input: ConverseCommandInput = {
        modelId: 'dummy',
        messages: [
          { role: 'user', content: [{ text: 'hi' }] },
          { role: 'assistant', content: [{ text: 'a' }] },
          { role: 'assistant', content: [{ text: 'b' }] },
        ],
      };
      const { input: processed } = preProcessInput(input, 'sonnet5', 0);
      expect(processed.messages?.map((m) => m.role)).toEqual(['user']);
    });

    test('leaves an all-assistant conversation untouched (never empties)', () => {
      const input: ConverseCommandInput = {
        modelId: 'dummy',
        messages: [{ role: 'assistant', content: [{ text: 'x' }] }],
      };
      const { input: processed } = preProcessInput(input, 'sonnet5', 0);
      expect(processed.messages?.map((m) => m.role)).toEqual(['assistant']);
    });
  });

  describe('OpenAI-style reasoning (gpt6astra)', () => {
    test('emits reasoning.effort=high by default and no Anthropic reasoning_config/beta', () => {
      const { input, thinkingBudget } = preProcessInput(baseInput(), 'gpt6astra', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning).toEqual({ effort: 'high' });
      // Must NOT emit the Anthropic-style fields for an openai.* model.
      expect(fields.reasoning_config).toBeUndefined();
      expect(fields.output_config).toBeUndefined();
      expect(fields.anthropic_beta).toBeUndefined();
      // effort is categorical, so no numeric thinking budget is reported.
      expect(thinkingBudget).toBeUndefined();
    });

    test('escalates reasoning.effort to max on the ultrathink keyword', () => {
      const { input } = preProcessInput(baseInput('please ultrathink this'), 'gpt6astra', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning).toEqual({ effort: 'max' });
      expect(fields.reasoning_config).toBeUndefined();
    });

    test('gives the response the full output headroom (maxTokens = maxOutputTokens)', () => {
      const { input } = preProcessInput(baseInput(), 'gpt6astra', 0);
      // gpt6astra maxOutputTokens is 131_072; the openai branch must not let
      // the later budget-derived maxTokens adjustment shrink it.
      expect(input.inferenceConfig?.maxTokens).toBe(131_072);
    });
  });

  describe('Claude reasoning is unchanged by the openai branch (regression lock)', () => {
    test('reasoningSupport Claude model (sonnet4.6) still emits Anthropic reasoning_config, not reasoning.effort', () => {
      const { input } = preProcessInput(baseInput(), 'sonnet4.6', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning_config).toEqual({ type: 'enabled', budget_tokens: 2000 });
      // The OpenAI-style field must never appear for a Claude model.
      expect(fields.reasoning).toBeUndefined();
    });

    test('adaptive Claude model (opus5) still emits reasoning_config adaptive + output_config, not reasoning.effort', () => {
      const { input } = preProcessInput(baseInput(), 'opus5', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning_config).toEqual({ type: 'adaptive' });
      expect(fields.output_config).toEqual({ effort: 'xhigh' });
      expect(fields.reasoning).toBeUndefined();
    });
  });

  describe('reasoning-strip must not leave an empty content array (E2E "messages.N is empty" regression)', () => {
    // History with a reasoning-ONLY assistant message (a GPT-6 Astra end-of-turn
    // that delivered its text via a tool and emitted no plain text), followed by
    // a bare toolUse as the second-to-last message so the shared enable-guard
    // DISABLES reasoning for this request (toolChoice unset; messages.at(-2) is a
    // bare toolUse without a reasoningContent block). When reasoning is disabled,
    // preProcessInput strips reasoningContent from every message; the
    // reasoning-only assistant would become content:[] and Bedrock rejects it
    // ("The content field in the Message object at messages.N is empty"). The fix
    // drops such now-empty messages.
    const historyWithReasoningOnlyAssistant = (): ConverseCommandInput => ({
      modelId: 'dummy',
      messages: [
        { role: 'user', content: [{ text: 'do the task' }] },
        // reasoning-only assistant (no text, no toolUse) — the trigger
        { role: 'assistant', content: [{ reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } } as any] },
        { role: 'user', content: [{ text: 'continue' }] },
        // second-to-last: a BARE toolUse assistant → disables reasoning
        { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'tool', input: {} } }] },
        // last: toolResult
        {
          role: 'user',
          content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'result' }] } } as any],
        },
      ],
    });

    test('gpt6astra: no message has an empty content array after preprocessing', () => {
      const { input } = preProcessInput(historyWithReasoningOnlyAssistant(), 'gpt6astra', 0);
      // reasoning must be disabled here (proves the strip path runs)
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning).toBeUndefined();
      // No surviving message may have an empty content array.
      for (const m of input.messages ?? []) {
        expect(m.content?.length ?? 0).toBeGreaterThan(0);
      }
      // The reasoning-only assistant was dropped (its only block was stripped).
      const hasReasoningOnly = (input.messages ?? []).some(
        (m) => m.content?.length === 1 && m.content[0] && 'reasoningContent' in m.content[0]
      );
      expect(hasReasoningOnly).toBe(false);
      // The real content-bearing messages are preserved.
      expect((input.messages ?? []).some((m) => m.content?.some((c) => 'toolUse' in c))).toBe(true);
      expect((input.messages ?? []).some((m) => m.content?.some((c) => 'toolResult' in c))).toBe(true);
    });

    test('a reasoning+text assistant keeps its text block after the strip (only the reasoning block is removed)', () => {
      const input: ConverseCommandInput = {
        modelId: 'dummy',
        messages: [
          { role: 'user', content: [{ text: 'q' }] },
          {
            role: 'assistant',
            content: [
              { reasoningContent: { redactedContent: new Uint8Array([9]) } } as any,
              { text: 'visible answer' },
            ],
          },
          { role: 'user', content: [{ text: 'again' }] },
          { role: 'assistant', content: [{ toolUse: { toolUseId: 't2', name: 'tool', input: {} } }] },
          { role: 'user', content: [{ toolResult: { toolUseId: 't2', content: [{ text: 'r' }] } } as any] },
        ],
      };
      const { input: processed } = preProcessInput(input, 'gpt6astra', 0);
      const assistantWithText = processed.messages?.find((m) =>
        m.content?.some((c) => 'text' in c && c.text === 'visible answer')
      );
      expect(assistantWithText).toBeDefined();
      // reasoning block removed, text kept -> content length 1
      expect(assistantWithText!.content).toHaveLength(1);
      for (const m of processed.messages ?? []) {
        expect(m.content?.length ?? 0).toBeGreaterThan(0);
      }
    });
  });
});
