"""
Producer Lambda for FIS chaos scenario D.

Exposed via a Lambda Function URL. Accepts a POST request and sends the
message body to the SQS main queue (SendMessage), so an operator can drive
demo load into the queue by hand — for example with a simple shell loop —
while a D-1/D-2/D-3 chaos experiment is running against the consumer Lambda.

Routes:
  POST /  — body is forwarded verbatim as the SQS message body (defaults to
            a small generated payload with a UUID when no body is supplied)
  GET  /  — health check, returns 200 with queue info
"""
import json
import os
import uuid

import boto3

QUEUE_URL = os.environ['QUEUE_URL']
sqs = boto3.client('sqs')


def handler(event, context):
    method = event.get('requestContext', {}).get('http', {}).get('method', 'POST')

    if method == 'GET':
        return response(200, {'status': 'ok', 'queueUrl': QUEUE_URL})

    try:
        body = event.get('body') or ''
        if not body.strip():
            body = json.dumps({'id': str(uuid.uuid4()), 'message': 'demo load'})

        result = sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=body)
        return response(
            202,
            {'messageId': result['MessageId'], 'queueUrl': QUEUE_URL},
        )
    except Exception as e:
        return response(500, {'error': str(e)})


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body, default=str),
    }
