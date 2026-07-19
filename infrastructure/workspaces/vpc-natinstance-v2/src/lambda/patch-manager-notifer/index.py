import json
import boto3
import base64
import gzip
from botocore.client import ClientError
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.metrics import MetricUnit

# from aws_lambda_powertools.logging.formatters.datadog import DatadogLogFormatter
from aws_xray_sdk.core import patch_all

logger = Logger(service="natgw-scheduler")
tracer = Tracer(service="natgw-scheduler")
metrics = Metrics(namespace="NatgwScheduler", service="natgw-scheduler")

# Initialize X-Ray SDK
patch_all()


@logger.inject_lambda_context(log_event=True)
@tracer.capture_lambda_handler
@metrics.log_metrics
def lambda_handler(event, context):
    # Get CloudWatch Logs data from the event
    decoded_data = base64.b64decode(event["awslogs"]["data"])
    json_data = json.loads(gzip.decompress(decoded_data).decode("utf-8"))

    logMessage = json_data["logEvents"][0]["message"]
    logger.debug(f"Received log message: {logMessage}")

    messageTemplate = """
Notification Patch Compliance Report for NAT Instance
- Target ID: {0}
- Patch Group: {1}
- Result:
{2}
"""

    print("Patch Manager Notifier Lambda invoked.")
    return {"statusCode": 200, "body": "Patch Manager Notifier executed successfully."}
