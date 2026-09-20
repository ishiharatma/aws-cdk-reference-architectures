// Persists every codex app-server JSON-RPC line (responses and
// server-initiated notifications alike) to the EventsTable, so a session's
// Thread/Turn content survives the MicroVM being SUSPENDED or terminated.
// The control plane's get-events Lambda polls this same table for the
// client (see README "Turn output retrieval").
//
// Relies on the AWS SDK's default credential provider chain resolving
// credentials the platform injects for the MicroVM's executionRoleArn;
// the exact injection mechanism (env vars vs. a metadata endpoint) was not
// independently verified in this session.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export class EventHandler {
  #tableName;
  #sessionId;
  #sequence = 0;

  constructor(tableName) {
    this.#tableName = tableName;
  }

  setSessionId(sessionId) {
    this.#sessionId = sessionId;
  }

  /** @param {unknown} event */
  async record(event) {
    if (!this.#tableName || !this.#sessionId) {
      // No session bound yet (e.g. a line emitted before /run assigned a
      // sessionId) -- drop it rather than write an unattributed record.
      return;
    }
    const sequence = this.#sequence++;
    try {
      await ddbClient.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: {
            sessionId: this.#sessionId,
            sequence,
            recordedAt: new Date().toISOString(),
            event,
          },
        }),
      );
    } catch (err) {
      // Never let a DynamoDB write failure take codex app-server down;
      // surface it on stderr for CloudWatch instead.
      console.error('[event-handler] failed to persist event', err);
    }
  }
}
