"""
Logs every message delivered by a direct Lambda subscription to the
SNS-basic log-alert topic (the final hop of the
CloudWatch Logs -> Lambda -> SNS -> Lambda chain).

This is a terminal "just log it" sample Lambda: it does not forward or
transform the message any further.
"""

import json
import logging

logger = logging.getLogger()


def lambda_handler(event, context):
    records = event.get("Records", [])
    logger.info(f"Received {len(records)} log-alert SNS record(s)")

    for record in records:
        sns_message = record.get("Sns", {})
        logger.info(
            json.dumps(
                {
                    "messageId": sns_message.get("MessageId"),
                    "subject": sns_message.get("Subject"),
                    "message": sns_message.get("Message"),
                }
            )
        )

    return {"statusCode": 200}
