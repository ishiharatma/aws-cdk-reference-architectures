"""
ConfirmOrder Lambda — Saga forward step 3 (final step).

Simulates finalizing the order (confirming inventory consumption and
settling payment) by writing status ORDER_CONFIRMED. Mock implementation
only. When this function is made unreachable by FIS (scenario F-3, reserved
concurrency = 0), the Step Functions Retry policy exhausts and the state
machine's Catch branch runs the two-stage compensation: RefundPayment, then
ReleaseInventory, in that order.
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
                          'orderConfirmedAt = :now',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={
            ':status': 'ORDER_CONFIRMED',
            ':now': int(time.time()),
        },
    )

    return {**event, 'orderConfirmed': True}
