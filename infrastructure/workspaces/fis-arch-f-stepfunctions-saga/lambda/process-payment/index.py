"""
ProcessPayment Lambda — Saga forward step 2.

Simulates charging the customer by writing status PAYMENT_PROCESSED to the
order record. Mock implementation only. When this function is made
unreachable by FIS (scenario F-1, reserved concurrency = 0), the Step
Functions Retry policy exhausts and the state machine's Catch branch
compensates by invoking ReleaseInventory.
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
                          'paymentProcessedAt = :now',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={
            ':status': 'PAYMENT_PROCESSED',
            ':now': int(time.time()),
        },
    )

    return {**event, 'paymentProcessed': True}
