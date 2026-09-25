import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** Bedrock embedding model used for both indexing and querying (must be the same for both). */
  readonly embeddingModelId: string;
  /**
   * Embedding vector size. Must equal the `Dimensions` of the DynamoDB vector index.
   * Titan Text Embeddings V2 supports 256 / 512 / 1024.
   */
  readonly embeddingDimensions: 256 | 512 | 1024;
  /** API Gateway usage plan: steady-state requests per second. */
  readonly apiRateLimit: number;
  /** API Gateway usage plan: burst requests. */
  readonly apiBurstLimit: number;
  /** API Gateway usage plan: requests per day (caps Bedrock spend if the API key leaks). */
  readonly apiDailyQuota: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
