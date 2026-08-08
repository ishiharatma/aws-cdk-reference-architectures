"""
CloudWatch Logs subscription filter destination.

Decodes the gzip+base64 CloudWatch Logs payload, builds a short summary of
the batch, and publishes it to the SNS log-alert topic.

Environment variables:
  TOPIC_ARN - ARN of the SNS topic to publish the summary to.
"""

import base64
import gzip
import json
import logging
import os

import boto3

logger = logging.getLogger()

sns = boto3.client("sns")

TOPIC_ARN = os.environ["TOPIC_ARN"]


def lambda_handler(event, context):
    compressed_payload = base64.b64decode(event["awslogs"]["data"])
    payload = json.loads(gzip.decompress(compressed_payload))

    log_events = payload.get("logEvents", [])
    log_group = payload.get("logGroup")
    log_stream = payload.get("logStream")

    logger.info(f"Received {len(log_events)} log event(s) from {log_group}/{log_stream}")

    summary = {
        "logGroup": log_group,
        "logStream": log_stream,
        "eventCount": len(log_events),
        "firstMessage": log_events[0]["message"] if log_events else None,
    }

    response = sns.publish(
        TopicArn=TOPIC_ARN,
        Subject=f"CloudWatch Logs alert: {log_group}",
        Message=json.dumps(summary),
    )

    logger.info(f"Published summary to SNS, MessageId={response['MessageId']}")
    return {"published": True, "messageId": response["MessageId"]}
