"""
API Gateway (Lambda proxy) backend for the SNS-basic main topic's HTTPS
subscription (see https://docs.aws.amazon.com/sns/latest/dg/sns-http-https-endpoint-as-subscriber.html).

Handles two SNS message types delivered as the raw POST body:
  - SubscriptionConfirmation: confirms the subscription by fetching the
    SubscribeURL, after validating that it points at a genuine SNS endpoint
    for our own topic (mitigates SSRF via a forged SubscribeURL).
  - Notification: writes the raw payload to S3 and a summary record to
    DynamoDB.

Environment variables:
  EXPECTED_TOPIC_ARN - ARN of the SNS topic this endpoint is subscribed to.
                        Notifications/confirmations for any other TopicArn
                        are rejected.
  S3_BUCKET_NAME      - Bucket to store the raw notification payload in.
  DDB_TABLE_NAME      - DynamoDB table to store a summary record in.
"""

import json
import logging
import os
import re
import urllib.request
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

EXPECTED_TOPIC_ARN = os.environ["EXPECTED_TOPIC_ARN"]
S3_BUCKET_NAME = os.environ["S3_BUCKET_NAME"]
DDB_TABLE_NAME = os.environ["DDB_TABLE_NAME"]

# Only ever fetch SubscribeURLs that point at a real SNS regional endpoint.
SUBSCRIBE_URL_PATTERN = re.compile(r"^https://sns\.[a-z0-9-]+\.amazonaws\.com/")


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "body": json.dumps(body),
    }


def _confirm_subscription(message):
    subscribe_url = message.get("SubscribeURL", "")
    if not SUBSCRIBE_URL_PATTERN.match(subscribe_url):
        logger.error(f"Refusing to fetch untrusted SubscribeURL: {subscribe_url}")
        return _response(400, {"error": "invalid SubscribeURL"})

    logger.info(f"Confirming subscription via {subscribe_url}")
    with urllib.request.urlopen(subscribe_url, timeout=5) as res:
        logger.info(f"Subscription confirmation response status: {res.status}")

    return _response(200, {"confirmed": True})


def _store_notification(message):
    message_id = message.get("MessageId", "unknown")
    timestamp = message.get("Timestamp") or datetime.now(timezone.utc).isoformat()

    s3.put_object(
        Bucket=S3_BUCKET_NAME,
        Key=f"notifications/{message_id}.json",
        Body=json.dumps(message).encode("utf-8"),
        ContentType="application/json",
    )

    table = dynamodb.Table(DDB_TABLE_NAME)
    table.put_item(
        Item={
            "messageId": message_id,
            "timestamp": timestamp,
            "subject": message.get("Subject", ""),
            "message": message.get("Message", ""),
        }
    )

    logger.info(f"Stored notification {message_id} in S3 and DynamoDB")
    return _response(200, {"stored": True, "messageId": message_id})


def lambda_handler(event, context):
    body = event.get("body") or "{}"
    message = json.loads(body)

    message_type = message.get("Type")
    topic_arn = message.get("TopicArn")
    logger.info(f"Received {message_type} for topic {topic_arn}")

    if topic_arn != EXPECTED_TOPIC_ARN:
        logger.error(f"Unexpected TopicArn: {topic_arn}")
        return _response(403, {"error": "unexpected TopicArn"})

    if message_type == "SubscriptionConfirmation":
        return _confirm_subscription(message)

    if message_type == "Notification":
        return _store_notification(message)

    logger.info(f"Ignoring message type: {message_type}")
    return _response(200, {"ignored": True})
