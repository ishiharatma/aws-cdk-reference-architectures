"""
Pattern B – CloudWatch Logs Export Task Lambda

Triggered by EventBridge on a schedule (default: daily).
Calls CreateExportTask to export the previous day's logs to S3.

Notes:
- Only one export task can run at a time per AWS account.
  This function checks for in-progress tasks before creating a new one.
- The export is asynchronous; completion may take minutes to hours.
"""
import boto3
import datetime
import os

LOG_GROUP_NAME = os.environ["LOG_GROUP_NAME"]
S3_BUCKET_NAME = os.environ["S3_BUCKET_NAME"]
S3_PREFIX = os.environ.get("S3_PREFIX", "exports")


def lambda_handler(event, context):
    logs_client = boto3.client("logs")

    # Check if another export task is already running
    running = logs_client.describe_export_tasks(statusCode="RUNNING")
    pending = logs_client.describe_export_tasks(statusCode="PENDING")
    if running["exportTasks"] or pending["exportTasks"]:
        print("An export task is already running or pending. Skipping.")
        return {"status": "skipped", "reason": "task_in_progress"}

    # Export the previous day (UTC)
    yesterday = datetime.datetime.utcnow() - datetime.timedelta(days=1)
    from_time = int(
        yesterday.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000
    )
    to_time = int(
        yesterday.replace(hour=23, minute=59, second=59, microsecond=999999).timestamp()
        * 1000
    )

    task_name = f"export-{yesterday.strftime('%Y-%m-%d')}"
    destination_prefix = f"{S3_PREFIX}/{yesterday.strftime('%Y/%m/%d')}"

    response = logs_client.create_export_task(
        taskName=task_name,
        logGroupName=LOG_GROUP_NAME,
        fromTime=from_time,
        to=to_time,
        destination=S3_BUCKET_NAME,
        destinationPrefix=destination_prefix,
    )

    task_id = response["taskId"]
    print(f"Export task created: {task_id} → s3://{S3_BUCKET_NAME}/{destination_prefix}")
    return {"status": "created", "taskId": task_id}
