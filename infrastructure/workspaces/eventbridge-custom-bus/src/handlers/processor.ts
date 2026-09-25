import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { EventBridgeEvent } from 'aws-lambda';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME ?? '';

interface OrderDetail {
  orderId: string;
  amount: number;
  region: string;
}

/**
 * Target of the EU rule: records each order the rule delivers.
 *
 * EventBridge invokes Lambda asynchronously, so delivery is at-least-once. The write is keyed by
 * `orderId` (+ event id) and idempotent: a redelivered or replayed event overwrites the same item
 * instead of creating a duplicate.
 */
export const handler = async (event: EventBridgeEvent<'OrderPlaced', OrderDetail>): Promise<void> => {
  const { orderId, amount, region } = event.detail;
  await ddb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        orderId: { S: orderId },
        eventId: { S: event.id },
        amount: { N: String(amount) },
        region: { S: region },
        source: { S: event.source },
        // Present only on events re-delivered by an archive replay.
        replayName: { S: (event as unknown as Record<string, string>)['replay-name'] ?? '' },
        processedAt: { S: new Date().toISOString() },
      },
    }),
  );
  console.log(JSON.stringify({ msg: 'processed', orderId, eventId: event.id }));
};
