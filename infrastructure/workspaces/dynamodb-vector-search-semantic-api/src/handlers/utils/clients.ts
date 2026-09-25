import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyResult } from 'aws-lambda';

export const ddb = new DynamoDBClient({});
export const bedrock = new BedrockRuntimeClient({});

export const TABLE_NAME = process.env.TABLE_NAME ?? '';
export const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_NAME ?? '';
export const EMBEDDING_MODEL_ID = process.env.EMBEDDING_MODEL_ID ?? '';
export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? '256');

/**
 * Embed text with Amazon Titan Text Embeddings V2.
 *
 * `normalize: true` returns unit-length vectors, so COSINE / DOT_PRODUCT / EUCLIDEAN rank identically.
 * The same model, dimensions and normalization MUST be used for indexing and querying, otherwise the
 * two vectors live in different spaces and the distances are meaningless.
 */
export async function embedText(text: string): Promise<number[]> {
  const res = await bedrock.send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text, dimensions: EMBEDDING_DIMENSIONS, normalize: true }),
    }),
  );
  const { embedding } = JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] };
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Unexpected embedding size: expected ${EMBEDDING_DIMENSIONS}, got ${embedding?.length}`);
  }
  return embedding;
}

/** DynamoDB vector values must be 32-bit IEEE-754 floats, sent as a list of `N` attribute values. */
export const toVectorAttribute = (vector: number[]): { N: string }[] =>
  vector.map((v) => ({ N: String(Math.fround(v)) }));

export function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
