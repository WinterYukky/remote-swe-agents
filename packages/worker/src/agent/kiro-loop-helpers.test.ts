/**
 * Unit tests for `kiro-loop-helpers` constants that other packages depend on
 * structurally.
 */
import { describe, expect, test } from 'vitest';
import { NON_EMPTY_DISCARD_WARNING } from './kiro-loop-helpers';

describe('NON_EMPTY_DISCARD_WARNING — single-line <system> inner contract', () => {
  // The webapp display filter (strip-internal-prompt-text.ts) removes this note
  // from a tool result at display time by matching a SAME-LINE
  // `<system>[^\n]*?</system>` pair. That constraint is deliberate: matching
  // across newlines corrupted legitimate multi-line output (E2E-c). The filter's
  // correctness therefore depends on this producer-side invariant: the
  // `<system>...</system>` inner must not contain a newline. The webapp cannot
  // import this server-only constant, so it duplicates the literal in its tests
  // and cannot detect drift — this test is the build-time guard on the producer
  // side. If someone adds a newline inside the tag, this fails here instead of
  // silently leaking the warning into the webapp display.
  test('the <system>...</system> inner contains no newline', () => {
    const match = /<system>([\s\S]*?)<\/system>/.exec(NON_EMPTY_DISCARD_WARNING);
    expect(match).not.toBeNull();
    const inner = match![1]!;
    expect(inner).not.toContain('\n');
  });

  test('there is exactly one well-formed <system>...</system> pair', () => {
    const opens = NON_EMPTY_DISCARD_WARNING.match(/<system>/g) ?? [];
    const closes = NON_EMPTY_DISCARD_WARNING.match(/<\/system>/g) ?? [];
    expect(opens.length).toBe(1);
    expect(closes.length).toBe(1);
  });

  test('the same-line filter regex used by the webapp strips the whole note', () => {
    // Mirror of the webapp filter's core removal (same-line inner). This pins
    // that the real constant is actually removable by that regex shape.
    const stripped = NON_EMPTY_DISCARD_WARNING.replace(/[ \t]*\n*<system>[^\n]*?<\/system>/g, '');
    expect(stripped).toBe('');
    expect(stripped).not.toContain('<system>');
  });
});
