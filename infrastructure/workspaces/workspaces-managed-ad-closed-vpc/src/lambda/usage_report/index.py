"""Monthly WorkSpaces usage report.

Collects every WorkSpace and its last user connection time
(DescribeWorkspacesConnectionStatus.LastKnownUserConnectionTimestamp), stores the full list
as CSV in S3 and sends a summary through SNS.

Environment variables:
    REPORT_BUCKET           S3 bucket for CSV files
    REPORT_PREFIX           Key prefix (default: reports)
    TOPIC_ARN               SNS topic for the summary
    INACTIVE_THRESHOLD_DAYS Days without connection that count as inactive
    REPORT_TIME_ZONE        IANA time zone for timestamps (e.g. Asia/Tokyo)
"""

from __future__ import annotations

import logging
import os
from typing import Any
from zoneinfo import ZoneInfo

import boto3

from report import build_message, build_rows, report_key, to_csv, utc_now

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# DescribeWorkspacesConnectionStatus accepts up to 25 WorkSpace IDs per call.
CONNECTION_STATUS_BATCH = 25

workspaces_client = boto3.client("workspaces")
s3_client = boto3.client("s3")
sns_client = boto3.client("sns")


def list_workspaces() -> list[dict[str, Any]]:
    paginator = workspaces_client.get_paginator("describe_workspaces")
    result: list[dict[str, Any]] = []
    for page in paginator.paginate():
        result.extend(page.get("Workspaces", []))
    return result


def get_connection_status(workspace_ids: list[str]) -> dict[str, dict[str, Any]]:
    status: dict[str, dict[str, Any]] = {}
    for start in range(0, len(workspace_ids), CONNECTION_STATUS_BATCH):
        batch = workspace_ids[start : start + CONNECTION_STATUS_BATCH]
        kwargs: dict[str, Any] = {"WorkspaceIds": batch}
        while True:
            page = workspaces_client.describe_workspaces_connection_status(**kwargs)
            for item in page.get("WorkspacesConnectionStatus", []):
                status[item["WorkspaceId"]] = item
            token = page.get("NextToken")
            if not token:
                break
            kwargs["NextToken"] = token
    return status


def handler(_event: dict[str, Any], _context: Any) -> dict[str, Any]:
    bucket = os.environ["REPORT_BUCKET"]
    prefix = os.environ.get("REPORT_PREFIX", "reports")
    topic_arn = os.environ["TOPIC_ARN"]
    threshold_days = int(os.environ.get("INACTIVE_THRESHOLD_DAYS", "30"))
    tz = ZoneInfo(os.environ.get("REPORT_TIME_ZONE", "Asia/Tokyo"))
    now = utc_now()

    workspaces = list_workspaces()
    status = get_connection_status([ws["WorkspaceId"] for ws in workspaces])
    rows = build_rows(workspaces, status, now, threshold_days)

    key = report_key(prefix, now, tz)
    s3_client.put_object(
        Bucket=bucket,
        Key=key,
        Body=to_csv(rows, tz).encode("utf-8"),
        ContentType="text/csv; charset=utf-8",
    )
    s3_uri = f"s3://{bucket}/{key}"

    subject, body = build_message(rows, now, tz, threshold_days, s3_uri)
    sns_client.publish(TopicArn=topic_arn, Subject=subject, Message=body)

    summary = {"workspaces": len(rows), "csv": s3_uri}
    logger.info("Report sent: %s", summary)
    return summary
