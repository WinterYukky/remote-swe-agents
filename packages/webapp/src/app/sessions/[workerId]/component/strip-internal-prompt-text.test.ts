import { describe, expect, test } from 'vitest';
import { stripInternalPromptText } from './strip-internal-prompt-text';

// The exact NON_EMPTY_DISCARD_WARNING string the kiro-cli loop appends
// (packages/worker/src/agent/kiro-loop-helpers.ts). Reproduced as a literal so
// this webapp test does not import the server-only worker module; the filter is
// generic over <system>...</system> so it does not depend on this exact text.
const WARNING =
  '\n<system>WARNING: Your previous response included text blocks alongside tool calls. These text blocks were NOT delivered to the user. If the text was intended for the user, you must resend it using the Send Message To User tool.</system>';

/**
 * Reproduce the Bedrock `renderToolResult` envelope shape (agent-core
 * lib/prompt.ts) as a literal. Not imported (server-only barrel); the point of
 * these tests is that the filter unwraps THIS exact shape and nothing else.
 */
function renderToolResultEnvelope(toolResult: string, forceReportMessage = ''): string {
  return `<result>\n${toolResult}\n</result>\n<command>\n${forceReportMessage}\n</command>`;
}

describe('stripInternalPromptText — <system> note removal', () => {
  test('removes a trailing NON_EMPTY_DISCARD_WARNING, keeping the real output', () => {
    const input = 'New session created successfully.' + WARNING;
    expect(stripInternalPromptText(input)).toBe('New session created successfully.');
  });

  // Measured: the REAL reload text is not `resolved + WARNING`.
  // `page.tsx` joins the tool-result content blocks with `join('\n')`, and the
  // WARNING constant itself already starts with '\n', so the reload text is
  // `resolved + '\n' + WARNING` — a TWO-newline run before `<system>`. The
  // filter must consume BOTH newlines so the stripped reload text is
  // byte-identical to the live text `resolved` (no dangling trailing '\n'),
  // preserving live/reload parity. (Previously `\n?` left one '\n' behind.)
  test('production reload shape (join adds a newline before the \n-prefixed WARNING) strips to bare output — §14a byte parity', () => {
    const resolved = 'New session created successfully.';
    // Exactly what page.tsx builds: content blocks [resolved, WARNING].join('\n').
    const reloadText = [resolved, WARNING].join('\n');
    expect(reloadText.startsWith(resolved + '\n\n<system>')).toBe(true); // guard: really two newlines
    expect(stripInternalPromptText(reloadText)).toBe(resolved); // byte-identical to the live value
  });

  // Reviewer nit (measured): when the legitimate output ITSELF ends in a newline
  // AND a warning is attached, the reload path swallows that trailing '\n' (via
  // the `\n*` before <system>) while the live path — which never carries the
  // warning — keeps it, so server="hello" vs live="hello\n" diverge in the
  // OTHER direction. The unconditional trimEnd on the shared filter makes both
  // paths normalise the trailing newline identically → true byte parity.
  test('legitimate output ending in a newline + warning: live and reload are byte-identical', () => {
    const resolved = 'hello\n'; // the tool output genuinely ends with a newline
    // reload path: page.tsx joins content blocks [resolved, WARNING] with '\n'
    const reloadInput = [resolved, WARNING].join('\n');
    // live path: applyToolResult sees just the raw event output (no warning)
    const liveInput = resolved;

    const reloadOut = stripInternalPromptText(reloadInput);
    const liveOut = stripInternalPromptText(liveInput);

    expect(reloadOut).toBe(liveOut); // byte parity in BOTH directions
    expect(reloadOut).toBe('hello'); // trailing newline normalised away on both
  });

  test('removes a standalone <system> block', () => {
    expect(stripInternalPromptText('<system>internal note</system>')).toBe('');
  });

  test('removes multiple <system> blocks', () => {
    const input = 'a<system>one</system>\nb\n<system>two</system>';
    expect(stripInternalPromptText(input)).toBe('a\nb');
  });

  // The worker's WARNING inner is single-line (verified against the real
  // NON_EMPTY_DISCARD_WARNING constant). A <system> whose inner spans a newline
  // is NOT a worker note, and pairing across newlines is exactly what corrupted
  // legitimate output (E2E-c). So a multi-line-inner <system> is left UNTOUCHED
  // (passthrough) — the conservative contract.
  test('a <system> whose inner spans a newline is NOT stripped (passthrough)', () => {
    const input = 'ok\n<system>line1\nline2</system>';
    expect(stripInternalPromptText(input)).toBe(input);
  });
});

describe('stripInternalPromptText — renderToolResult envelope unwrap (whole-string only)', () => {
  test('unwraps an envelope with empty command (forceReport off) to the inner result', () => {
    const input = renderToolResultEnvelope('Tool ran fine.');
    expect(stripInternalPromptText(input)).toBe('Tool ran fine.');
  });

  test('unwraps an envelope with a forceReport command, dropping the command', () => {
    const input = renderToolResultEnvelope(
      'Done.',
      'Long time has passed since you sent the last message. Please use ... asap.'
    );
    expect(stripInternalPromptText(input)).toBe('Done.');
  });

  test('unwraps a multi-line result body verbatim', () => {
    const body = 'line1\nline2\nline3';
    expect(stripInternalPromptText(renderToolResultEnvelope(body))).toBe(body);
  });
});

describe('stripInternalPromptText — passthrough / no false positives (PM constraint)', () => {
  test('ordinary text is unchanged', () => {
    expect(stripInternalPromptText('just some tool output')).toBe('just some tool output');
  });

  test('empty string is unchanged', () => {
    expect(stripInternalPromptText('')).toBe('');
  });

  // The key PM-mandated case: text that PARTIALLY contains the markers must pass
  // through untouched — we must never corrupt legitimate tool output.
  test('a <result> appearing partway through normal output is NOT unwrapped', () => {
    const input = 'Here is the file content:\n<result>\nsomething\n</result>\nand more trailing text';
    expect(stripInternalPromptText(input)).toBe(input);
  });

  test('an envelope with leading/trailing text around it is NOT unwrapped (not whole-string)', () => {
    const input = 'prefix ' + renderToolResultEnvelope('inner');
    expect(stripInternalPromptText(input)).toBe(input);
  });

  test('a <result> without the matching <command> envelope tail is NOT unwrapped', () => {
    const input = '<result>\njust a result-ish string\n</result>';
    expect(stripInternalPromptText(input)).toBe(input);
  });

  test('an unbalanced/lone <system> (no closing tag) is left untouched', () => {
    const input = 'output mentioning <system> as literal text with no close';
    expect(stripInternalPromptText(input)).toBe(input);
  });

  test('output that documents the tags in prose is preserved when tags are unbalanced', () => {
    const input = 'The parser emits </system> and <result> markers as sentinels.';
    expect(stripInternalPromptText(input)).toBe(input);
  });

  test('idempotent: applying twice equals applying once', () => {
    const input = 'New session created successfully.' + WARNING;
    const once = stripInternalPromptText(input);
    expect(stripInternalPromptText(once)).toBe(once);
  });
});

describe('stripInternalPromptText — E2E-c regression: lone/unbalanced tags across lines must not corrupt output', () => {
  // Exact heredoc scenario from the E2E fault (DDB SK 001789134995042). All four
  // lines are one tool output joined by '\n'. Before the fix, line A's lone
  // `<system>` paired with line B's stray `</system>` across the newline and
  // deleted the text between them. With the single-line-inner constraint:
  //   A (lone <system>, no same-line close)   -> intact
  //   B (stray </system>, no opening)          -> intact
  //   C (mid-text <result>, no <system>)       -> intact
  //   D (same-line <system>..</system> pair)   -> stripped (in-spec, PM-ruled)
  const lines = [
    'A: lone <system> tag no close',
    'B: only closing </system> here',
    'C: mid-text <result> marker stays',
    'D: pair <system>legit inner</system> tail',
  ];
  const input = lines.join('\n');

  test('lines A, B, C are preserved verbatim; only the same-line pair on D is stripped', () => {
    const expected = [
      'A: lone <system> tag no close',
      'B: only closing </system> here',
      'C: mid-text <result> marker stays',
      'D: pair tail',
    ].join('\n');
    expect(stripInternalPromptText(input)).toBe(expected);
  });

  test('the real worker WARNING is still stripped even though it sits on its own line', () => {
    // resolved output followed by the real single-line-inner WARNING.
    const withWarning = 'C: mid-text <result> marker stays' + WARNING;
    expect(stripInternalPromptText(withWarning)).toBe('C: mid-text <result> marker stays');
  });
});
