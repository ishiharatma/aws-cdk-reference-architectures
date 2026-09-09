"""
RefundPayment Lambda — Saga compensating transaction.

Undoes ProcessPayment by writing status PAYMENT_REFUNDED to the order
record. Invoked when ConfirmOrder fails (scenario F-3), as the first of the
two-stage compensation (RefundPayment, then ReleaseInventory). Mock
implementation only.
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
                          'paymentRefundedAt = :now',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={
            ':status': 'PAYMENT_REFUNDED',
            ':now': int(time.time()),
        },
    )

    return {**event, 'paymentRefunded': True}
