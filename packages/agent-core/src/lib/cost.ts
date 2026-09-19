import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws/ddb';
import { criRegions, modelConfigs } from '../schema/model';
import { updateSession } from './sessions';

// Cross-region inference (CRI) profile prefixes that may be prepended to a
// base model id at invoke time (see chooseModelAndRegion in converse.ts).
// A stored token-usage modelId is either a bare base id (`anthropic.claude-*`)
// or a region-prefixed CRI profile id (`us.anthropic.claude-*`). Derived from
// the single `criRegions` source in schema/model.ts so a new region added
// there is automatically honoured here.
const CRI_PREFIXES: readonly string[] = criRegions;

/**
 * Strip a leading CRI region prefix from a runtime modelId, leaving the base
 * model id used as the `modelId` key in modelConfigs.
 * e.g. `us.anthropic.claude-fable-5-1` -> `anthropic.claude-fable-5-1`.
 */
const stripCriPrefix = (modelId: string): string => {
  const dot = modelId.indexOf('.');
  if (dot > 0 && CRI_PREFIXES.includes(modelId.slice(0, dot))) {
    return modelId.slice(dot + 1);
  }
  return modelId;
};

// Calculate cost in USD based on token usage
export const calculateCost = (
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
) => {
  // Exact match on the base model id (after removing any CRI region prefix).
  // Substring matching is unsafe because base ids can be prefixes of one
  // another (e.g. `anthropic.claude-fable-5` vs `anthropic.claude-fable-5-1`),
  // which would mis-price the longer id with the shorter id's config.
  const baseModelId = stripCriPrefix(modelId);
  const config = Object.values(modelConfigs).find((config) => config.modelId === baseModelId);
  if (!config) {
    // Exact match means an unknown/removed modelId now yields cost 0 silently.
    // Warn so a future catalog drift (e.g. a new region prefix or renamed id)
    // is noticed instead of quietly under-counting cost.
    console.warn(`calculateCost: no pricing config for modelId "${modelId}" (base "${baseModelId}"); counting as 0`);
    return 0;
  }

  const pricing = config.pricing;
  return (
    (inputTokens * pricing.input +
      outputTokens * pricing.output +
      cacheReadTokens * pricing.cacheRead +
      cacheWriteTokens * pricing.cacheWrite) /
    1000
  );
};

/**
 * Calculate total cost from token usage records in DynamoDB
 */
async function calculateTotalSessionCost(workerId: string) {
  try {
    // Query token usage records from DynamoDB
    const result = await ddb.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `token-${workerId}`,
        },
      })
    );

    const items = result.Items || [];
    let totalCost = 0;

    // Calculate cost for each model from token usage records
    for (const item of items) {
      const modelId = item.SK; // model ID is stored in SK
      const inputTokens = item.inputToken || 0;
      const outputTokens = item.outputToken || 0;
      const cacheReadTokens = item.cacheReadInputTokens || 0;
      const cacheWriteTokens = item.cacheWriteInputTokens || 0;

      const modelCost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

      totalCost += modelCost;
    }

    return totalCost;
  } catch (error) {
    console.error(`Error calculating session cost for workerId ${workerId}:`, error);
    return 0;
  }
}

/**
 * Updates the session cost in DynamoDB by calculating cost for each model
 */
export async function updateSessionCost(workerId: string) {
  try {
    // Calculate total cost across all models
    const totalCost = await calculateTotalSessionCost(workerId);

    // Update the cost using the generic updateSession function
    await updateSession(workerId, { sessionCost: totalCost });
  } catch (error) {
    console.error(`Error updating session cost for workerId ${workerId}:`, error);
  }
}
