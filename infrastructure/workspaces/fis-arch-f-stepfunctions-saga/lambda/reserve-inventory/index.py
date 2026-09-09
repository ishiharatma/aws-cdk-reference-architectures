"""
ReserveInventory Lambda — Saga forward step 1.

Simulates reserving inventory for an order by writing the order record to
DynamoDB with status INVENTORY_RESERVED. This is a mock implementation: it
performs no real inventory bookkeeping, it exists purely as a Step Functions
task target so FIS can exercise Retry/Catch behavior by stopping invocations
of this function (see fis-arch-f-stepfunctions-saga FisStack scenario F-2).
"""
import os
import time
import boto3

TABLE_NAME = os.environ['TABLE_NAME']
table = boto3.resource('dynamodb').Table(TABLE_NAME)


def handler(event, context):
    order_id = event['orderId']

    table.update_item(
        Key={'orderId': order_id},
        UpdateExpression='SET #status = :status, updatedAt = :now, '
                          'inventoryReservedAt = :now',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={
            ':status': 'INVENTORY_RESERVED',
            ':now': int(time.time()),
        },
    )

    return {**event, 'inventoryReserved': True}
