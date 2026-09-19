import { z } from 'zod';

export const inferenceModeSchema = z.enum(['bedrock', 'kiro-cli']);
export type InferenceMode = z.infer<typeof inferenceModeSchema>;

export const kiroModelConfigs = {
  auto: { name: 'Auto (recommended)' },
  'claude-fable-5.1': { name: 'Claude Fable 5.1' },
  'claude-fable-5': { name: 'Claude Fable 5' },
  'claude-opus-5': { name: 'Claude Opus 5' },
  'claude-opus-4.8': { name: 'Claude Opus 4.8' },
  'claude-opus-4.7': { name: 'Claude Opus 4.7' },
  'claude-sonnet-5': { name: 'Claude Sonnet 5' },
  'claude-sonnet-4.6': { name: 'Claude Sonnet 4.6' },
  'claude-haiku-4.5': { name: 'Claude Haiku 4.5' },
  'gpt-5.6-sol': { name: 'GPT 5.6 Sol' },
  'gpt-5.6-terra': { name: 'GPT 5.6 Terra' },
  'gpt-5.6-luna': { name: 'GPT 5.6 Luna' },
  'deepseek-3.2': { name: 'DeepSeek 3.2' },
  'minimax-m2.5': { name: 'MiniMax M2.5' },
  'glm-5': { name: 'GLM 5' },
  'qwen3-coder-next': { name: 'Qwen3 Coder Next' },
} as const satisfies Record<string, { name: string }>;

export type KiroModelId = keyof typeof kiroModelConfigs;

export const getKiroModelIds = (): KiroModelId[] => Object.keys(kiroModelConfigs) as KiroModelId[];

export const kiroModelSchema = z.enum(Object.keys(kiroModelConfigs) as [KiroModelId, ...KiroModelId[]]);

export const modelTypeList = [
  'fable5.1',
  'fable5',
  'opus5',
  'opus4.8',
  'opus4.7',
  'opus4.6',
  'opus4.6-long-context-mode',
  'opus4.5',
  'opus4.1',
  'opus4',
  'sonnet5',
  'sonnet4.6',
  'sonnet4.6-long-context-mode',
  'sonnet4.5',
  'sonnet4.5-long-context-mode',
  'sonnet4',
  'sonnet4-long-context-mode',
  'sonnet3.7',
  'sonnet3.5',
  'sonnet3.5v1',
  'haiku4.5',
  'haiku3.5',
  'gpt6astra',
  'nova-pro',
] as const;
export const modelTypeSchema = z.enum(modelTypeList);
export type ModelType = z.infer<typeof modelTypeSchema>;

// Single source of truth for cross-region inference (CRI) profile regions.
// Used to build criRegionSchema here and consumed by cost.ts to strip the
// region prefix from a runtime modelId. Adding a region here automatically
// keeps cost calculation in sync (avoids the silent "cost 0" trap).
export const criRegions = ['global', 'us', 'eu', 'apac', 'jp', 'au'] as const;
const criRegionSchema = z.enum(criRegions);
export const criRegion = criRegionSchema
  .catch('us')
  .parse(process.env.NEXT_PUBLIC_BEDROCK_CRI_REGION_OVERRIDE || process.env.BEDROCK_CRI_REGION_OVERRIDE || 'us');

const modelConfigSchema = z.object({
  name: z.string(),
  modelId: z.string(),
  maxOutputTokens: z.number(),
  maxInputTokens: z.number(),
  cacheSupport: z.array(z.enum(['system', 'tool', 'message'])),
  reasoningSupport: z.boolean(),
  toolChoiceSupport: z.array(z.enum(['any', 'auto', 'tool'])),
  isHidden: z.boolean().optional(),
  interleavedThinkingSupport: z.boolean().optional(),
  adaptiveThinkingOnly: z.boolean().optional(),
  // Whether the model accepts a trailing assistant message (Anthropic "prefill").
  // Omitted / true = supported (default, all legacy models). Set false for models
  // that reject prefill (e.g. Sonnet 5, which returns a ValidationException:
  // "This model does not support assistant message prefill"). When false, a
  // trailing assistant message is stripped from the request before invoke.
  assistantPrefillSupport: z.boolean().optional(),
  supportedCriProfiles: z.array(criRegionSchema),
  additionalRequestFields: z.record(z.string(), z.unknown()).optional(),
  pricing: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    longContextInput: z.number().optional(),
    longContextOutput: z.number().optional(),
    longContextCacheRead: z.number().optional(),
    longContextCacheWrite: z.number().optional(),
  }),
});

export const modelConfigs: Record<ModelType, z.infer<typeof modelConfigSchema>> = {
  'fable5.1': {
    name: 'Claude Fable 5.1',
    modelId: 'anthropic.claude-fable-5-1',
    maxOutputTokens: 128_000,
    maxInputTokens: 1_000_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    adaptiveThinkingOnly: true,
    assistantPrefillSupport: false,
    supportedCriProfiles: ['global', 'us'],
    // Fable 5.1 shares Fable 5's uniform pricing (no longContext surcharge)
    // except for a 75% cheaper cache read ($0.25/M vs $1.00/M).
    pricing: { input: 0.01, output: 0.05, cacheRead: 0.00025, cacheWrite: 0.0125 },
  },
  fable5: {
    name: 'Claude Fable 5',
    modelId: 'anthropic.claude-fable-5',
    maxOutputTokens: 128_000,
    maxInputTokens: 1_000_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    adaptiveThinkingOnly: true,
    assistantPrefillSupport: false,
    supportedCriProfiles: ['global', 'us'],
    // Fable 5 has uniform pricing across all context lengths (no longContext surcharge).
    pricing: { input: 0.01, output: 0.05, cacheRead: 0.001, cacheWrite: 0.0125 },
  },
  opus5: {
    name: 'Claude Opus 5',
    modelId: 'anthropic.claude-opus-5',
    maxOutputTokens: 128_000,
    maxInputTokens: 1_000_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    adaptiveThinkingOnly: true,
    assistantPrefillSupport: false,
    supportedCriProfiles: ['global', 'us', 'eu', 'au'],
    pricing: { input: 0.005, output: 0.025, cacheRead: 0.0005, cacheWrite: 0.00625 },
  },
  'opus4.8': {
    name: 'Claude Opus 4.8',
    modelId: 'anthropic.claude-opus-4-8',
    maxOutputTokens: 128_000,
    maxInputTokens: 1_000_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    adaptiveThinkingOnly: true,
    assistantPrefillSupport: false,
    supportedCriProfiles: ['global', 'us', 'eu', 'jp', 'au'],
    pricing: { input: 0.005, output: 0.025, cacheRead: 0.0005, cacheWrite: 0.00625 },
  },
  'opus4.7': {
    name: 'Claude Opus 4.7',
    modelId: 'anthropic.claude-opus-4-7',
    maxOutputTokens: 128_000,
    maxInputTokens: 1_000_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    adaptiveThinkingOnly: true,
    assistantPrefillSupport: false,
    supportedCriProfiles: ['global', 'us', 'eu', 'jp'],
    pricing: { input: 0.005, output: 0.025, cacheRead: 0.0005, cacheWrite: 0.00625 },
  },
  'opus4.6': {
    name: 'Claude Opus 4.6',
    modelId: 'anthropic.claude-opus-4-6-v1',
    maxOutputTokens: 32_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    assistantPrefillSupport: false,
    supportedCriProfiles: ['global', 'us', 'eu', 'au'],
    pricing: { input: 0.005, output: 0.025, cacheRead: 0.0005, cacheWrite: 0.00625 },
  },
  'opus4.6-long-context-mode': {
    name: 'Claude Opus 4.6 (Long Context)',
    modelId: 'anthropic.claude-opus-4-6-v1',
    maxOutputTokens: 32_000,
    maxInputTokens: 1_000_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    assistantPrefillSupport: false,
    supportedCriProfiles: ['global', 'us', 'eu', 'au'],
    additionalRequestFields: { anthropic_beta: ['context-1m-2025-08-07'] },
    pricing: { input: 0.005, output: 0.025, cacheRead: 0.0005, cacheWrite: 0.00625 },
  },
  'opus4.5': {
    name: 'Claude Opus 4.5',
    modelId: 'anthropic.claude-opus-4-5-20251101-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['global'],
    pricing: { input: 0.005, output: 0.025, cacheRead: 0.0005, cacheWrite: 0.00625 },
  },
  'opus4.1': {
    name: 'Claude 4.1 Opus',
    modelId: 'anthropic.claude-opus-4-1-20250805-v1:0',
    maxOutputTokens: 32_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    isHidden: true,
    supportedCriProfiles: ['us'],
    pricing: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 },
  },
  opus4: {
    name: 'Claude 4 Opus',
    modelId: 'anthropic.claude-opus-4-20250514-v1:0',
    maxOutputTokens: 32_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    isHidden: true,
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['us'],
    pricing: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 },
  },
  sonnet5: {
    name: 'Claude Sonnet 5',
    modelId: 'anthropic.claude-sonnet-5',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    adaptiveThinkingOnly: true,
    assistantPrefillSupport: false,
    supportedCriProfiles: ['global', 'us', 'eu', 'au'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
  'sonnet4.6': {
    name: 'Claude Sonnet 4.6',
    modelId: 'anthropic.claude-sonnet-4-6',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    assistantPrefillSupport: false,
    supportedCriProfiles: ['global', 'us', 'eu', 'jp', 'au'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
  'sonnet4.6-long-context-mode': {
    name: 'Claude Sonnet 4.6 (Long Context)',
    modelId: 'anthropic.claude-sonnet-4-6',
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    assistantPrefillSupport: false,
    supportedCriProfiles: ['global', 'us', 'eu', 'jp', 'au'],
    additionalRequestFields: { anthropic_beta: ['context-1m-2025-08-07'] },
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
  'sonnet4.5': {
    name: 'Claude Sonnet 4.5',
    modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['global', 'us', 'eu', 'jp', 'au'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
  'sonnet4.5-long-context-mode': {
    name: 'Claude Sonnet 4.5 (Long Context)',
    modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['global', 'us', 'eu', 'jp', 'au'],
    additionalRequestFields: { anthropic_beta: ['context-1m-2025-08-07'] },
    pricing: {
      input: 0.003,
      output: 0.015,
      cacheRead: 0.0003,
      cacheWrite: 0.00375,
      longContextInput: 0.006,
      longContextOutput: 0.0225,
      longContextCacheRead: 0.0006,
      longContextCacheWrite: 0.0075,
    },
  },
  sonnet4: {
    name: 'Claude 4 Sonnet',
    modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['global', 'us', 'eu', 'apac'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
  'sonnet4-long-context-mode': {
    name: 'Claude 4 Sonnet (Long Context)',
    modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['global', 'us', 'eu', 'apac'],
    additionalRequestFields: { anthropic_beta: ['context-1m-2025-08-07'] },
    pricing: {
      input: 0.003,
      output: 0.015,
      cacheRead: 0.0003,
      cacheWrite: 0.00375,
      longContextInput: 0.006,
      longContextOutput: 0.0225,
      longContextCacheRead: 0.0006,
      longContextCacheWrite: 0.0075,
    },
  },
  'sonnet3.7': {
    name: 'Claude 3.7 Sonnet',
    modelId: 'anthropic.claude-3-7-sonnet-20250219-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    supportedCriProfiles: ['us', 'eu', 'apac'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
  'sonnet3.5': {
    name: 'Claude 3.5 Sonnet v2',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    maxOutputTokens: 4096,
    maxInputTokens: 200_000,
    cacheSupport: [],
    reasoningSupport: false,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    supportedCriProfiles: ['us', 'apac'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
  'sonnet3.5v1': {
    name: 'Claude 3.5 Sonnet v1',
    modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    maxOutputTokens: 4096,
    maxInputTokens: 200_000,
    cacheSupport: [],
    reasoningSupport: false,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    isHidden: true,
    supportedCriProfiles: ['us', 'apac'],
    pricing: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  },
  'haiku4.5': {
    name: 'Claude Haiku 4.5',
    modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    interleavedThinkingSupport: true,
    supportedCriProfiles: ['global', 'us', 'eu', 'jp', 'au'],
    pricing: { input: 0.001, output: 0.005, cacheRead: 0.0001, cacheWrite: 0.00125 },
  },
  'haiku3.5': {
    name: 'Claude 3.5 Haiku',
    modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
    maxOutputTokens: 4096,
    maxInputTokens: 200_000,
    cacheSupport: [],
    reasoningSupport: false,
    toolChoiceSupport: ['any', 'auto', 'tool'],
    isHidden: true,
    supportedCriProfiles: ['us', 'eu'],
    pricing: { input: 0.0008, output: 0.004, cacheRead: 0.00008, cacheWrite: 0.001 },
  },
  gpt6astra: {
    name: 'GPT-6 Astra',
    modelId: 'openai.gpt-6-astra',
    maxOutputTokens: 131_072,
    maxInputTokens: 1_000_000,
    // Explicit prompt caching via a Converse cachePoint is rejected by this
    // model (AccessDeniedException: "your request did not allow prompt
    // caching"), so no cache breakpoints are sent.
    cacheSupport: [],
    // OpenAI models expose reasoning via an OpenAI-style `reasoning.effort`
    // field, not the Anthropic `reasoning_config`. preProcessInput branches on
    // the `openai.` modelId prefix to emit the correct shape (verified against
    // the real Converse API), so reasoning is enabled here.
    reasoningSupport: true,
    // Verified against the real Converse API (global.openai.gpt-6-astra,
    // ap-northeast-1): 'auto' returns text, 'any' forces a tool call, and
    // 'tool' forces the named tool — all three accepted.
    toolChoiceSupport: ['any', 'auto', 'tool'],
    // Assistant message prefill (a request ending on an assistant turn) is
    // accepted by this model — verified against the real Converse API: a
    // trailing assistant message returned a normal continuation with no
    // ValidationException. So the default (prefill supported) is left in place.
    supportedCriProfiles: ['global', 'us'],
    // Standard tier (per-1K units). input $10/M, output $50/M, cacheRead $1/M,
    // cacheWrite $12.50/M. A separate >272K-input tier (2x input, 1.5x output)
    // is not representable in this schema.
    pricing: { input: 0.01, output: 0.05, cacheRead: 0.001, cacheWrite: 0.0125 },
  },
  'nova-pro': {
    name: 'Amazon Nova Pro',
    modelId: 'amazon.nova-pro-v1:0',
    maxOutputTokens: 10_000,
    maxInputTokens: 300_000,
    reasoningSupport: false,
    cacheSupport: ['system'],
    toolChoiceSupport: ['auto'],
    supportedCriProfiles: ['us', 'apac'],
    pricing: { input: 0.0008, output: 0.0032, cacheRead: 0.0002, cacheWrite: 0.0008 },
  },
};

export const getAvailableModelTypes = (): ModelType[] => {
  return Object.entries(modelConfigs)
    .filter(([_, config]) => !config.isHidden && config.supportedCriProfiles.includes(criRegion))
    .map(([type, _]) => type as ModelType);
};
