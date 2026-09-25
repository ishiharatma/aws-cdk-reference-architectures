import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { ddb, EMBEDDING_MODEL_ID, embedText, TABLE_NAME, toVectorAttribute } from './utils/clients';

/**
 * DynamoDB Streams -> Lambda: embed each new document and write the vector back to the same item.
 *
 * Loop safety: this function's own UpdateItem produces a MODIFY stream record. The event source
 * mapping filter only lets through records whose NewImage has no `embeddedAt` attribute, so that
 * write-back record is dropped before it ever reaches Lambda. The early return and the conditional
 * update below are the second line of defence (idempotent under retries, and safe for items that
 * were deleted before embedding finished).
 */
export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const batchItemFailures: DynamoDBBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage;
    const docId = image?.docId?.S;
    const sequenceNumber = record.dynamodb?.SequenceNumber;
    if (!docId || !sequenceNumber || image?.embeddedAt) continue;

    try {
      const vector = await embedText(`${image?.title?.S ?? ''}\n${image?.body?.S ?? ''}`);
      await ddb.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: { docId: { S: docId } },
          UpdateExpression: 'SET embedding = :v, embeddedAt = :t, embeddingModel = :m',
          ConditionExpression: 'attribute_exists(docId) AND attribute_not_exists(embeddedAt)',
          ExpressionAttributeValues: {
            ':v': { L: toVectorAttribute(vector) },
            ':t': { S: new Date().toISOString() },
            ':m': { S: EMBEDDING_MODEL_ID },
          },
        }),
      );
      console.log(JSON.stringify({ msg: 'embedded', docId, dimensions: vector.length }));
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        console.log(JSON.stringify({ msg: 'skipped (deleted or already embedded)', docId }));
        continue;
      }
      console.error(JSON.stringify({ msg: 'embedding failed', docId, error: String(err) }));
      // Report only this record so the rest of the batch is not retried (ReportBatchItemFailures).
      batchItemFailures.push({ itemIdentifier: sequenceNumber });
    }
  }

  return { batchItemFailures };
};
