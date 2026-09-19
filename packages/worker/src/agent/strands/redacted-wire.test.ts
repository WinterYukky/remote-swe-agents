// Wire-level regression test for redacted reasoning (GPT-6 Astra / openai.*).
//
// Neither the SDK accumulator tests nor the message-converter unit tests
// exercise how the persisted history is actually re-serialized onto the
// Bedrock ConverseCommand wire. The production request-build path is:
//   getItems -> noOpFiltering -> itemsToMessages -> postProcessMessageContent
//   -> ConverseCommand -> @smithy serializer
// A reasoningContent.redactedContent left as a base64 STRING is re-encoded as
// UTF-8 text by @smithy/util-base64 toBase64 (DOUBLE base64), corrupting the
// bytes the model must receive. postProcessMessageContent (non-forUi) must
// decode the stored base64 string back to a Uint8Array so the wire carries the
// exact original base64.
import { describe, it, expect } from 'vitest';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { noOpFiltering } from '@remote-swe-agents/agent-core/lib';
import type { MessageItem } from '@remote-swe-agents/agent-core/schema';

// Serialize a ConverseCommand carrying the given assistant content and return
// the wire request body as a string (captured via a mock requestHandler).
async function wireBodyFor(content: any[]): Promise<string> {
  let captured: unknown;
  const client = new BedrockRuntimeClient({
    region: 'us-west-2',
    credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    requestHandler: {
      async handle(request: any) {
        captured = request.body;
        throw new Error('CAPTURED');
      },
    } as any,
  });
  const cmd = new ConverseCommand({ modelId: 'global.openai.gpt-6-astra', messages: [{ role: 'assistant', content }] });
  try {
    await client.send(cmd);
  } catch (e: any) {
    if (e?.message !== 'CAPTURED') throw e;
  }
  return String(captured);
}

describe('redacted reasoning wire encoding', () => {
  it('a base64 STRING redactedContent is DOUBLE-encoded on the wire (the bug this guards against)', async () => {
    const body = await wireBodyFor([{ reasoningContent: { redactedContent: 'yv66vg==' } }]);
    // Demonstrates why a leftover string is wrong: it becomes eXY2NnZnPT0=.
    expect(body).toContain('eXY2NnZnPT0=');
    expect(body).not.toContain('"redactedContent":"yv66vg=="');
  });

  it('a Uint8Array redactedContent serializes to the correct base64 on the wire', async () => {
    const body = await wireBodyFor([
      { reasoningContent: { redactedContent: new Uint8Array([0xca, 0xfe, 0xba, 0xbe]) } },
    ]);
    expect(body).toContain('"redactedContent":"yv66vg=="');
  });

  it('production round-trip: stored base64 -> load -> ConverseCommand wire carries the ORIGINAL base64 (not double-encoded)', async () => {
    const original = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]); // base64 "yv66vg=="

    // The stored form produced by saveConversationHistory's
    // preProcessMessageContent: reasoningContent.redactedContent as a base64
    // STRING (asserted separately in agent-core messages.test.ts).
    const storedContent = JSON.stringify([
      { reasoningContent: { redactedContent: Buffer.from(original).toString('base64') } },
    ]);
    const item: MessageItem = {
      PK: 'message-w',
      SK: '000000000000001',
      content: storedContent,
      role: 'assistant',
      tokenCount: 0,
      messageType: 'assistant',
    } as MessageItem;

    // Drive the REAL production load path (getItems -> noOpFiltering ->
    // itemsToMessages -> postProcessMessageContent).
    const { messages } = await noOpFiltering([item]);
    const loadedContent = messages[0]!.content as any[];

    // Feed the LOADED content straight onto the wire (as the loop does).
    const body = await wireBodyFor(loadedContent);
    expect(body).toContain('"redactedContent":"yv66vg=="');
    expect(body).not.toContain('eXY2NnZnPT0=');
  });
});
