import { expect, test } from 'vitest';
import { calculateCost } from './cost';

test('calculateCost for sonnet3.7 model', () => {
  // GIVEN
  const modelId = 'us.anthropic.claude-3-7-sonnet-20250219-v1:0';
  const inputTokens = 1000;
  const outputTokens = 500;
  const cacheReadTokens = 200;
  const cacheWriteTokens = 100;

  // WHEN
  const cost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  // THEN
  const expectedCost = (1000 * 0.003 + 500 * 0.015 + 200 * 0.0003 + 100 * 0.00375) / 1000;
  expect(cost).toBe(expectedCost);
});

test('calculateCost for haiku3.5 model', () => {
  // GIVEN
  const modelId = 'apac.anthropic.claude-3-5-haiku-20241022-v1:0';
  const inputTokens = 2000;
  const outputTokens = 1000;
  const cacheReadTokens = 500;
  const cacheWriteTokens = 250;

  // WHEN
  const cost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  // THEN
  const expectedCost = (2000 * 0.0008 + 1000 * 0.004 + 500 * 0.00008 + 250 * 0.001) / 1000;
  expect(cost).toBe(expectedCost);
});

test('calculateCost returns 0 for unknown model', () => {
  // GIVEN
  const modelId = 'unknown-model-id';
  const inputTokens = 1000;
  const outputTokens = 500;
  const cacheReadTokens = 200;
  const cacheWriteTokens = 100;

  // WHEN
  const cost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  // THEN
  expect(cost).toBe(0);
});

test('calculateCost with zero tokens', () => {
  // GIVEN
  const modelId = 'anthropic.claude-sonnet-4-20250514-v1:0';
  const inputTokens = 0;
  const outputTokens = 0;
  const cacheReadTokens = 0;
  const cacheWriteTokens = 0;

  // WHEN
  const cost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  // THEN
  expect(cost).toBe(0);
});

// The following two tests pin the per-model cache-read rates for Fable 5 and
// Fable 5.1 (they differ: 0.001 vs 0.00025). NOTE: on their own they do NOT
// catch the old `modelId.includes(config.modelId)` substring bug, because
// 'fable5.1' is declared before 'fable5' in modelConfigs, so `find()` hits the
// longer id first even with includes(). The real regression guard for the
// substring bug is the "unregistered id must cost 0" test below, which is
// insertion-order independent.
test('calculateCost prices Fable 5.1 with its own (cheaper) cache-read rate, not Fable 5', () => {
  // GIVEN a CRI-prefixed Fable 5.1 runtime modelId
  const modelId = 'us.anthropic.claude-fable-5-1';
  const inputTokens = 1000;
  const outputTokens = 500;
  const cacheReadTokens = 10000;
  const cacheWriteTokens = 100;

  // WHEN
  const cost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  // THEN Fable 5.1 pricing: cacheRead 0.00025 (not Fable 5's 0.001)
  const expectedCost = (1000 * 0.01 + 500 * 0.05 + 10000 * 0.00025 + 100 * 0.0125) / 1000;
  expect(cost).toBe(expectedCost);
});

test('calculateCost prices Fable 5 with its own cache-read rate (bare and CRI-prefixed)', () => {
  const inputTokens = 1000;
  const outputTokens = 500;
  const cacheReadTokens = 10000;
  const cacheWriteTokens = 100;
  const expectedCost = (1000 * 0.01 + 500 * 0.05 + 10000 * 0.001 + 100 * 0.0125) / 1000;

  expect(
    calculateCost('global.anthropic.claude-fable-5', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)
  ).toBe(expectedCost);
  expect(calculateCost('anthropic.claude-fable-5', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)).toBe(
    expectedCost
  );
});

test('calculateCost matches base model id exactly after stripping the CRI prefix', () => {
  // A bare (no-prefix) id and a global-prefixed id resolve to the same config.
  const args = [1000, 500, 200, 100] as const;
  const bare = calculateCost('anthropic.claude-sonnet-4-6', ...args);
  const prefixed = calculateCost('global.anthropic.claude-sonnet-4-6', ...args);
  expect(bare).toBe(prefixed);
  expect(bare).toBeGreaterThan(0);
});

// TRUE regression guard for the substring-matching bug (insertion-order
// independent). `us.anthropic.claude-fable-5-2` is an UNREGISTERED id whose
// base (`anthropic.claude-fable-5-2`) is not in modelConfigs, so exact matching
// yields cost 0. The old `modelId.includes(config.modelId)` matcher would
// instead match `anthropic.claude-fable-5` (a substring) regardless of ordering
// and return a non-zero cost — so reverting to includes() makes this test fail.
test('calculateCost returns 0 for an unregistered modelId whose base contains a known id as a prefix', () => {
  const cost = calculateCost('us.anthropic.claude-fable-5-2', 1000, 500, 200, 100);
  expect(cost).toBe(0);
});

test('calculateCost prices GPT-6 Astra from a CRI-prefixed runtime modelId (global.openai.gpt-6-astra)', () => {
  // GIVEN the CRI-prefixed runtime modelId that chooseModelAndRegion produces
  // for gpt6astra under the deployment's `global` CRI profile.
  const modelId = 'global.openai.gpt-6-astra';
  const inputTokens = 1000;
  const outputTokens = 500;
  const cacheReadTokens = 10000;
  const cacheWriteTokens = 100;

  // WHEN
  const cost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  // THEN it resolves (after stripping the `global.` prefix) to GPT-6 Astra
  // Standard pricing: input 0.01, output 0.05, cacheRead 0.001, cacheWrite 0.0125.
  const expectedCost = (1000 * 0.01 + 500 * 0.05 + 10000 * 0.001 + 100 * 0.0125) / 1000;
  expect(cost).toBe(expectedCost);
  // And a bare id resolves to the same config.
  expect(calculateCost('openai.gpt-6-astra', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)).toBe(
    expectedCost
  );
});
