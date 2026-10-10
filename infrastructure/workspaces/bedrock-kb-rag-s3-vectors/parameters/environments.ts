import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/** How documents are split into chunks before they are embedded. */
export interface ChunkingParams {
  /** Maximum tokens per chunk. Smaller chunks retrieve more precisely; larger chunks carry more context. */
  readonly maxTokens: number;
  /** Overlap between neighbouring chunks, in percent. */
  readonly overlapPercentage: number;
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** Embedding model ID. Its output dimension must equal `vectorDimension`. */
  readonly embeddingModelId: string;
  /** Vector dimension of the embedding model (Titan Text Embeddings V2 supports 256, 512 and 1024). */
  readonly vectorDimension: number;
  /** Inference profile ID of the generation model (for example `jp.anthropic.claude-sonnet-4-6`). */
  readonly generationInferenceProfileId: string;
  /** Foundation model ID that the inference profile routes to (used to scope the invoke permission). */
  readonly generationFoundationModelId: string;
  /** Chunking of the data source. */
  readonly chunking: ChunkingParams;
  /** Number of chunks retrieved per question. */
  readonly numberOfResults: number;
  /** Metadata attribute the API can filter on (`department` in the sample documents). */
  readonly filterAttribute: string;
  /** Throttling of the HTTP API stage, requests per second. */
  readonly apiRateLimit: number;
  /** Throttling of the HTTP API stage, burst. */
  readonly apiBurstLimit: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
