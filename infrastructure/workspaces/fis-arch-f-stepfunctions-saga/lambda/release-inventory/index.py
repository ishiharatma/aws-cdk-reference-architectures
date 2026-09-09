"""
ReleaseInventory Lambda — Saga compensating transaction.

Undoes ReserveInventory by writing status INVENTORY_RELEASED to the order
record. Invoked from two places in the state machine's Catch branches:
  1. Directly, when ProcessPayment fails (scenario F-1).
  2. After RefundPayment, when ConfirmOrder fails (scenario F-3).
Mock implementation only.
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
                          'inventoryReleasedAt = :now',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={
            ':status': 'INVENTORY_RELEASED',
            ':now': int(time.time()),
        },
    )

    return {**event, 'inventoryReleased': True}
