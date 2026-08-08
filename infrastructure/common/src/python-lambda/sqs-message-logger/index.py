"""
Logs every message delivered to the SQS queue that is subscribed to the
SNS-basic main topic.

This is a terminal "just log it" sample Lambda: it does not forward or
transform the message any further.
"""

import json
import logging

logger = logging.getLogger()


def lambda_handler(event, context):
    records = event.get("Records", [])
    logger.info(f"Received {len(records)} SQS message(s)")

    for record in records:
        body = record.get("body", "")
        try:
            body = json.loads(body)
        except (TypeError, ValueError):
            pass

        logger.info(
            json.dumps(
                {
                    "messageId": record.get("messageId"),
                    "body": body,
                }
            )
        )

    return {"batchItemFailures": []}
