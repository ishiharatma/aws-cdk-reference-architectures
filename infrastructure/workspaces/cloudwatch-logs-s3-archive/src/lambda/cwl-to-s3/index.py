"""
Pattern C – CloudWatch Logs → Lambda → S3 Direct Write

Triggered by a CloudWatch Logs subscription filter.
Decodes the gzip+base64 payload, then writes each batch of log events
as a JSON object to S3.

Log event payload format received from CloudWatch Logs:
{
    "awslogs": {
        "data": "<base64(gzip(JSON))>"
    }
}

Decoded JSON structure:
{
    "messageType": "DATA_MESSAGE",
    "owner": "123456789012",
    "logGroup": "/aws/lambda/my-function",
    "logStream": "2024/01/01/[$LATEST]abc123",
    "subscriptionFilters": ["my-filter"],
    "logEvents": [
        {"id": "...", "timestamp": 1234567890000, "message": "log message"}
    ]
}
"""
import base64
import datetime
import gzip
import json
import os
import uuid

import boto3

S3_BUCKET_NAME = os.environ["S3_BUCKET_NAME"]
S3_PREFIX = os.environ.get("S3_PREFIX", "subscriptions")

s3_client = boto3.client("s3")


def lambda_handler(event, context):
    compressed = base64.b64decode(event["awslogs"]["data"])
    payload = json.loads(gzip.decompress(compressed).decode("utf-8"))

    if payload.get("messageType") == "CONTROL_MESSAGE":
        print("Control message received, skipping.")
        return {"status": "skipped", "reason": "control_message"}

    log_group = payload["logGroup"]
    log_stream = payload["logStream"]
    log_events = payload["logEvents"]

    now = datetime.datetime.utcnow()
    # Replace characters that are invalid in S3 keys
    safe_stream = log_stream.replace("/", "_").replace("$", "").replace("[", "").replace("]", "")
    s3_key = (
        f"{S3_PREFIX}"
        f"/{now.strftime('%Y/%m/%d/%H')}"
        f"/{safe_stream}"
        f"_{uuid.uuid4().hex[:8]}.json"
    )

    record = {
        "logGroup": log_group,
        "logStream": log_stream,
        "owner": payload.get("owner"),
        "exportedAt": now.isoformat() + "Z",
        "events": log_events,
    }

    s3_client.put_object(
        Bucket=S3_BUCKET_NAME,
        Key=s3_key,
        Body=json.dumps(record, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )

    print(f"Wrote {len(log_events)} events → s3://{S3_BUCKET_NAME}/{s3_key}")
    return {"status": "ok", "processed": len(log_events), "s3Key": s3_key}
