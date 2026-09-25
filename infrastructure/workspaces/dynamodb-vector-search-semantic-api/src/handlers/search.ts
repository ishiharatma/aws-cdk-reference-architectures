import { SearchVectorsCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ddb, embedText, json, TABLE_NAME, toVectorAttribute, VECTOR_INDEX_NAME } from './utils/clients';

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
const CATEGORY_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * GET /search?q=<text>[&k=5][&category=<name>]
 *
 * 1. Embed the query with the same Bedrock model used at indexing time.
 * 2. SearchVectors on the DynamoDB vector index (no OpenSearch / vector DB in the loop).
 * 3. `category` is an INLINE_FILTER attribute of the index, so it is applied inside the vector
 *    search rather than after it (post-filtering top-k would return fewer than k hits).
 *
 * The index uses COSINE, where the returned score is a distance (0 = identical, 2 = opposite).
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const q = event.queryStringParameters?.q?.trim();
  if (!q) return json(400, { message: 'Query parameter `q` is required' });
  if (q.length > 2000) return json(400, { message: '`q` must be at most 2000 characters' });

  const k = Number(event.queryStringParameters?.k ?? DEFAULT_TOP_K);
  if (!Number.isInteger(k) || k < 1 || k > MAX_TOP_K) {
    return json(400, { message: `\`k\` must be an integer between 1 and ${MAX_TOP_K}` });
  }

  const category = event.queryStringParameters?.category;
  if (category !== undefined && !CATEGORY_PATTERN.test(category)) {
    return json(400, { message: '`category` must match ^[a-z0-9-]{1,32}$' });
  }

  const vector = await embedText(q);
  const { SearchResults = [] } = await ddb.send(
    new SearchVectorsCommand({
      TableName: TABLE_NAME,
      IndexName: VECTOR_INDEX_NAME,
      SearchVector: toVectorAttribute(vector),
      TopK: k,
      ProjectionExpression: 'docId, title, category',
      ...(category && {
        SearchConditionExpression: '#c = :c',
        ExpressionAttributeNames: { '#c': 'category' },
        ExpressionAttributeValues: { ':c': { S: category } },
      }),
    }),
  );

  return json(200, {
    query: q,
    category: category ?? null,
    count: SearchResults.length,
    results: SearchResults.map((r) => ({
      docId: r.Item?.docId?.S,
      title: r.Item?.title?.S,
      category: r.Item?.category?.S,
      distance: r.Score,
      similarity: r.Score === undefined ? undefined : 1 - r.Score,
    })),
  });
};
