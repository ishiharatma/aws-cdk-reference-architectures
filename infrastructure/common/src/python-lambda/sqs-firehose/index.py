import json
import os
import boto3
import base64
import gzip
from botocore.client import ClientError
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.metrics import MetricUnit

# from aws_lambda_powertools.logging.formatters.datadog import DatadogLogFormatter
from aws_xray_sdk.core import patch_all

POWERTOOLS_METRICS_NAMESPACE = os.environ.get(
    "POWERTOOLS_METRICS_NAMESPACE", "sqs-firehose-namespace"
)
POWERTOOLS_SERVICE_NAME = os.environ.get(
    "POWERTOOLS_SERVICE_NAME", "sqs-firehose-service"
)
logger = Logger(service=POWERTOOLS_SERVICE_NAME)
tracer = Tracer(service=POWERTOOLS_SERVICE_NAME)
metrics = Metrics(
    namespace=POWERTOOLS_METRICS_NAMESPACE, service=POWERTOOLS_SERVICE_NAME
)

# Initialize X-Ray SDK
patch_all()

firehose_client = boto3.client("firehose")
sqs_client = boto3.client("sqs")


# Lambda function to process messages from SQS and send them to Firehose
@logger.inject_lambda_context(log_event=True)
@tracer.capture_lambda_handler
@metrics.log_metrics
def lambda_handler(event, context):
    records = event.get("Records", [])
    if not records:
        logger.warning("No records found in the event.")
        return {
            "statusCode": 200,
            "body": json.dumps({"message": "No records to process."}),
        }

    processed_messages = []
    batchItemFailures = []
    sqs_batch_response = {}
    delivery_stream_name = os.environ.get("FIREHOSE_DELIVERY_STREAM_NAME", "")
    if not delivery_stream_name:
        logger.error("FIREHOSE_DELIVERY_STREAM_NAME environment variable is not set.")
        raise ValueError(
            "FIREHOSE_DELIVERY_STREAM_NAME environment variable is not set."
        )

    for record in records:
        message_body = record.get("body", "")
        message_id = record.get("messageId", "unknown")
        logger.debug(f"Processing message: {message_body}")
        # Process the message (for demonstration, we just append it to the list)
        process_message(message_body, message_id, delivery_stream_name, batchItemFailures)
        processed_messages.append(message_body)
        # delete from SQS is handled automatically by Lambda on successful execution

    sqs_batch_response["batchItemFailures"] = batchItemFailures
    sqs_batch_response["statusCode"] = 200
    sqs_batch_response["body"] = json.dumps(
        {
            "processed_messages": processed_messages,
            "total_processed": len(processed_messages),
        }
    )
    logger.debug(f"SQS Batch Response: {sqs_batch_response}")

    return sqs_batch_response


# Process individual message
def process_message(message_body, message_id, delivery_stream_name, batchItemFailures=[]):
    try:
        # send to Firehose
        send_to_firehose_response = send_to_firehose(
            firehose_client, delivery_stream_name, [message_body]
        )
        logger.debug(f"Firehose response: {send_to_firehose_response}")
    except Exception as e:
        logger.error(f"Error processing message: {e}")
        batchItemFailures.append(
            {"itemIdentifier": message_id}
        )


# Send records to Firehose
def send_to_firehose(firehose_client, delivery_stream_name, records):
    try:
        response = firehose_client.put_record_batch(
            DeliveryStreamName=delivery_stream_name,
            Records=[{"Data": record.encode("utf-8")} for record in records],
        )
        return response
    except ClientError as e:
        logger.error(f"Failed to send records to Firehose: {e}")
        raise
