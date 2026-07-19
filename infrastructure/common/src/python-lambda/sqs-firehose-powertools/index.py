"""
SQS to Firehose Lambda Function with Partial Batch Response Support

This Lambda function processes messages from SQS and sends them to Kinesis Firehose.
It uses AWS Lambda Powertools for:
- Structured logging (JSON format)
- Distributed tracing (X-Ray)
- Custom metrics (CloudWatch)
- Batch processing with partial failure reporting (ReportBatchItemFailures)
"""

import json
import os
import boto3
from botocore.exceptions import ClientError
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.metrics import MetricUnit
from aws_lambda_powertools.utilities.batch import (
    BatchProcessor,
    EventType,
    process_partial_response,
)
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord
from aws_lambda_powertools.utilities.typing import LambdaContext

# Environment variables
POWERTOOLS_METRICS_NAMESPACE = os.environ.get(
    "POWERTOOLS_METRICS_NAMESPACE", "sqs-firehose-namespace"
)
POWERTOOLS_SERVICE_NAME = os.environ.get(
    "POWERTOOLS_SERVICE_NAME", "sqs-firehose-service"
)
FIREHOSE_DELIVERY_STREAM_NAME = os.environ.get("FIREHOSE_DELIVERY_STREAM_NAME", "")

# Initialize Powertools
logger = Logger(service=POWERTOOLS_SERVICE_NAME)
tracer = Tracer(service=POWERTOOLS_SERVICE_NAME)
metrics = Metrics(
    namespace=POWERTOOLS_METRICS_NAMESPACE, service=POWERTOOLS_SERVICE_NAME
)

# Initialize batch processor for SQS
processor = BatchProcessor(event_type=EventType.SQS)

# Initialize AWS clients
firehose_client = boto3.client("firehose")


@tracer.capture_method
def record_handler(record: SQSRecord) -> None:
    """
    Process individual SQS record and send to Firehose.

    This function is called for each record in the batch.
    If an exception is raised, the record will be marked as failed
    and returned in batchItemFailures for retry.

    Args:
        record: SQS record from the event
    """
    message_id = record.message_id
    message_body = record.body

    logger.debug("Processing message", extra={"message_id": message_id})

    # Validate delivery stream name
    if not FIREHOSE_DELIVERY_STREAM_NAME:
        logger.error("FIREHOSE_DELIVERY_STREAM_NAME environment variable is not set")
        raise ValueError("FIREHOSE_DELIVERY_STREAM_NAME environment variable is not set")

    # Parse message body if it's JSON
    try:
        payload = record.json_body
    except json.JSONDecodeError:
        # If not JSON, use raw body
        payload = {"raw_message": message_body}
        logger.warning(
            "Message body is not valid JSON, wrapping in raw_message",
            extra={"message_id": message_id},
        )

    # Add metadata to the payload
    enriched_payload = {
        "message_id": message_id,
        "timestamp": record.attributes.get("SentTimestamp"),
        "approximate_receive_count": record.attributes.get("ApproximateReceiveCount"),
        "data": payload,
    }

    # Send to Firehose
    send_to_firehose(enriched_payload)

    # Record success metric
    metrics.add_metric(name="MessagesProcessed", unit=MetricUnit.Count, value=1)

    logger.info(
        "Successfully processed message",
        extra={"message_id": message_id},
    )


@tracer.capture_method
def send_to_firehose(payload: dict) -> dict:
    """
    Send a single record to Kinesis Firehose.

    Args:
        payload: Dictionary to send to Firehose

    Returns:
        Firehose put_record response

    Raises:
        ClientError: If Firehose API call fails
    """
    try:
        # Convert payload to JSON string with newline for easier processing
        data = json.dumps(payload, ensure_ascii=False, default=str) + "\n"

        response = firehose_client.put_record(
            DeliveryStreamName=FIREHOSE_DELIVERY_STREAM_NAME,
            Record={"Data": data.encode("utf-8")},
        )

        logger.debug(
            "Sent record to Firehose",
            extra={
                "record_id": response.get("RecordId"),
                "encrypted": response.get("Encrypted", False),
            },
        )

        return response

    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "Unknown")
        logger.error(
            "Failed to send record to Firehose",
            extra={
                "error_code": error_code,
                "error_message": str(e),
            },
        )
        metrics.add_metric(name="FirehoseErrors", unit=MetricUnit.Count, value=1)
        raise


@logger.inject_lambda_context(log_event=True)
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: LambdaContext) -> dict:
    """
    Lambda function entry point.

    Processes SQS messages in batch and returns partial failures
    for automatic retry by Lambda.

    Args:
        event: SQS event containing Records
        context: Lambda context

    Returns:
        dict with batchItemFailures for failed records
    """
    records = event.get("Records", [])

    if not records:
        logger.warning("No records found in the event")
        return {"batchItemFailures": []}

    logger.info(
        "Processing batch",
        extra={"batch_size": len(records)},
    )

    # Process records with partial failure support
    # Failed records will be automatically added to batchItemFailures
    response = process_partial_response(
        event=event,
        record_handler=record_handler,
        processor=processor,
        context=context,
    )

    # Log batch processing summary
    failed_count = len(response.get("batchItemFailures", []))
    success_count = len(records) - failed_count

    logger.info(
        "Batch processing completed",
        extra={
            "total_records": len(records),
            "successful": success_count,
            "failed": failed_count,
        },
    )

    # Record batch metrics
    metrics.add_metric(name="BatchesProcessed", unit=MetricUnit.Count, value=1)
    if failed_count > 0:
        metrics.add_metric(name="FailedMessages", unit=MetricUnit.Count, value=failed_count)

    return response
