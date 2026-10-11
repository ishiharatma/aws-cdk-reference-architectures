import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  embeddingModelId: 'amazon.titan-embed-text-v2:0',
  vectorDimension: 1024,
  generationInferenceProfileId: 'jp.anthropic.claude-sonnet-4-6',
  generationFoundationModelId: 'anthropic.claude-sonnet-4-6',
  chunking: { maxTokens: 300, overlapPercentage: 20 },
  numberOfResults: 4,
  filterAttribute: 'department',
  apiRateLimit: 5,
  apiBurstLimit: 10,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
