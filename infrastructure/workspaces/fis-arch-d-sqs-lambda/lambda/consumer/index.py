"""
Consumer Lambda for FIS chaos scenario D.

Triggered by the SQS main queue (event source mapping, batchSize=5). For each
message in the batch, writes a record to DynamoDB capturing the message id,
body, and processing timestamp.

This function is intentionally simple — it exists as the FIS fault-injection
target (`aws:lambda:put-function-concurrent-executions`), not as a
production-grade service. When FIS sets reserved concurrency to 0 or 1,
messages accumulate in the SQS queue (ApproximateNumberOfMessagesVisible
rises) and, if the outage exceeds visibilityTimeout (60s) x maxReceiveCount
(3) = 180s, the redrive policy moves messages to the DLQ.

Partial batch failure reporting is used so that only messages which genuinely
fail to process are returned to the queue for redelivery — a poison message
does not block the rest of the batch.
"""
import datetime
import json
import os

import boto3

TABLE_NAME = os.environ['TABLE_NAME']
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)


def handler(event, context):
    records = event.get('Records', [])
    batch_item_failures = []

    for record in records:
        message_id = record.get('messageId')
        try:
            process_message(record)
        except Exception as e:  # noqa: BLE001 - report failure, do not crash the batch
            print(f'Failed to process message {message_id}: {e}')
            batch_item_failures.append({'itemIdentifier': message_id})

    # Report partial batch failures per the SQS ReportBatchItemFailures contract,
    # so only failed messages become visible again for redelivery.
    return {'batchItemFailures': batch_item_failures}


def process_message(record):
    message_id = record['messageId']
    body = record.get('body', '')

    try:
        parsed_body = json.loads(body)
    except (TypeError, ValueError):
        parsed_body = {'raw': body}

    table.put_item(
        Item={
            'id': message_id,
            'body': json.dumps(parsed_body, default=str),
            'processedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'sentTimestamp': record.get('attributes', {}).get('SentTimestamp', ''),
            'approximateReceiveCount': record.get('attributes', {}).get(
                'ApproximateReceiveCount', '1'
            ),
        }
    )
