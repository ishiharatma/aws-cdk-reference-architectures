#!/usr/bin/env python3
"""
SQS Test Message Sender

This script sends test messages to an SQS queue for testing Lambda integration.
Each message contains unique data to ensure different processing results.

Usage:
    python send-sqs-messages.py --queue-url <URL> --count <N> [--profile <PROFILE>]

Examples:
    # Send 10 messages with default profile
    python send-sqs-messages.py --queue-url https://sqs.ap-northeast-1.amazonaws.com/123456789012/my-queue --count 10

    # Send 50 messages with specific profile
    python send-sqs-messages.py --queue-url https://sqs.ap-northeast-1.amazonaws.com/123456789012/my-queue --count 50 --profile dev

    # Send messages to FIFO queue with message group
    python send-sqs-messages.py --queue-url https://sqs.ap-northeast-1.amazonaws.com/123456789012/my-queue.fifo --count 10 --fifo --message-group my-group
"""

import argparse
import json
import uuid
import random
import time
from datetime import datetime, timezone
from typing import List, Dict, Any
import sys

try:
    import boto3
    from botocore.exceptions import ClientError, NoCredentialsError
except ImportError:
    print("Error: boto3 is not installed. Please install it with: pip install boto3")
    sys.exit(1)


class SQSMessageSender:
    """SQS message sender for testing purposes"""

    # Sample data for generating diverse test messages
    SAMPLE_PRODUCTS = [
        "Laptop",
        "Smartphone",
        "Tablet",
        "Monitor",
        "Keyboard",
        "Mouse",
        "Headphones",
        "Speaker",
        "Camera",
        "Microphone",
    ]

    SAMPLE_CATEGORIES = ["Electronics", "Computers", "Audio", "Video", "Accessories"]

    SAMPLE_STATUSES = ["pending", "processing", "completed", "failed", "cancelled"]

    SAMPLE_REGIONS = [
        "us-east-1",
        "us-west-2",
        "ap-northeast-1",
        "ap-southeast-1",
        "eu-west-1",
    ]

    def __init__(self, queue_url: str, profile: str = None, region: str = None):
        """
        Initialize SQS message sender

        Args:
            queue_url: SQS queue URL
            profile: AWS profile name (optional)
            region: AWS region (optional)
        """
        self.queue_url = queue_url
        session_kwargs = {}
        if profile:
            session_kwargs["profile_name"] = profile
        if region:
            session_kwargs["region_name"] = region

        try:
            session = boto3.Session(**session_kwargs)
            self.sqs = session.client("sqs")
            print(f"✓ Connected to SQS using profile: {profile or 'default'}")
        except NoCredentialsError:
            print("Error: No AWS credentials found. Please configure your credentials.")
            sys.exit(1)
        except Exception as e:
            print(f"Error: Failed to create SQS client: {e}")
            sys.exit(1)

    def generate_message(self, index: int) -> Dict[str, Any]:
        """
        Generate a unique test message

        Args:
            index: Message sequence number

        Returns:
            Dictionary containing message data
        """
        timestamp = datetime.now(timezone.utc)
        message_id = str(uuid.uuid4())

        # Generate random data
        product = random.choice(self.SAMPLE_PRODUCTS)
        category = random.choice(self.SAMPLE_CATEGORIES)
        status = random.choice(self.SAMPLE_STATUSES)
        region = random.choice(self.SAMPLE_REGIONS)
        quantity = random.randint(1, 100)
        price = round(random.uniform(10.0, 1000.0), 2)

        return {
            "messageId": message_id,
            "timestamp": timestamp.isoformat(),
            "sequenceNumber": index,
            "data": {
                "product": product,
                "category": category,
                "quantity": quantity,
                "price": price,
                "total": round(quantity * price, 2),
                "status": status,
                "region": region,
            },
            "metadata": {
                "source": "test-script",
                "version": "1.0",
                "environment": "test",
            },
        }

    def send_message(
        self,
        message: Dict[str, Any],
        fifo: bool = False,
        message_group_id: str = None,
        deduplication_id: str = None,
    ) -> bool:
        """
        Send a single message to SQS

        Args:
            message: Message data
            fifo: Whether the queue is FIFO
            message_group_id: Message group ID for FIFO queues
            deduplication_id: Deduplication ID for FIFO queues

        Returns:
            True if successful, False otherwise
        """
        try:
            params = {
                "QueueUrl": self.queue_url,
                "MessageBody": json.dumps(message, ensure_ascii=False),
            }

            # Add FIFO-specific parameters
            if fifo:
                if message_group_id:
                    params["MessageGroupId"] = message_group_id
                else:
                    params["MessageGroupId"] = "default-group"

                if deduplication_id:
                    params["MessageDeduplicationId"] = deduplication_id
                else:
                    # Use message ID as deduplication ID
                    params["MessageDeduplicationId"] = message["messageId"]

            response = self.sqs.send_message(**params)
            return True

        except ClientError as e:
            print(f"✗ Error sending message: {e}")
            return False
        except Exception as e:
            print(f"✗ Unexpected error: {e}")
            return False

    def send_messages_batch(
        self,
        messages: List[Dict[str, Any]],
        fifo: bool = False,
        message_group_id: str = None,
    ) -> Dict[str, int]:
        """
        Send messages in batches (max 10 per batch)

        Args:
            messages: List of messages to send
            fifo: Whether the queue is FIFO
            message_group_id: Message group ID for FIFO queues

        Returns:
            Dictionary with success and failure counts
        """
        results = {"success": 0, "failed": 0}
        batch_size = 10

        for i in range(0, len(messages), batch_size):
            batch = messages[i : i + batch_size]
            entries = []

            for j, message in enumerate(batch):
                entry = {
                    "Id": str(i + j),
                    "MessageBody": json.dumps(message, ensure_ascii=False),
                }

                if fifo:
                    if message_group_id:
                        entry["MessageGroupId"] = message_group_id
                    else:
                        entry["MessageGroupId"] = "default-group"

                    entry["MessageDeduplicationId"] = message["messageId"]

                entries.append(entry)

            try:
                response = self.sqs.send_message_batch(
                    QueueUrl=self.queue_url, Entries=entries
                )

                results["success"] += len(response.get("Successful", []))
                results["failed"] += len(response.get("Failed", []))

                # Print failed messages details
                for failed in response.get("Failed", []):
                    print(
                        f"✗ Failed to send message {failed['Id']}: {failed.get('Message', 'Unknown error')}"
                    )

            except ClientError as e:
                print(f"✗ Error sending batch: {e}")
                results["failed"] += len(entries)
            except Exception as e:
                print(f"✗ Unexpected error: {e}")
                results["failed"] += len(entries)

        return results

    def send_test_messages(
        self,
        count: int,
        fifo: bool = False,
        message_group_id: str = None,
        batch: bool = True,
    ) -> None:
        """
        Send multiple test messages to SQS

        Args:
            count: Number of messages to send
            fifo: Whether the queue is FIFO
            message_group_id: Message group ID for FIFO queues
            batch: Whether to use batch sending
        """
        print(f"\n{'=' * 60}")
        print(f"Starting to send {count} messages to SQS queue")
        print(f"Queue URL: {self.queue_url}")
        print(f"Queue Type: {'FIFO' if fifo else 'Standard'}")
        if fifo and message_group_id:
            print(f"Message Group ID: {message_group_id}")
        print(f"{'=' * 60}\n")

        start_time = time.time()

        # Generate messages
        print(f"Generating {count} unique messages...")
        messages = [self.generate_message(i + 1) for i in range(count)]
        print(f"✓ Generated {len(messages)} messages\n")

        # Send messages
        if batch and count > 1:
            print("Sending messages in batches...")
            results = self.send_messages_batch(messages, fifo, message_group_id)
            print(f"\n✓ Successfully sent: {results['success']} messages")
            if results["failed"] > 0:
                print(f"✗ Failed to send: {results['failed']} messages")
        else:
            print("Sending messages one by one...")
            success = 0
            failed = 0
            for i, message in enumerate(messages, 1):
                if self.send_message(message, fifo, message_group_id):
                    success += 1
                    print(f"✓ Sent message {i}/{count}", end="\r")
                else:
                    failed += 1
                    print(f"✗ Failed to send message {i}/{count}")

            print(f"\n✓ Successfully sent: {success} messages")
            if failed > 0:
                print(f"✗ Failed to send: {failed} messages")

        elapsed_time = time.time() - start_time
        print(f"\nCompleted in {elapsed_time:.2f} seconds")
        print(f"Average: {elapsed_time / count:.3f} seconds per message")


def main():
    """Main function"""
    parser = argparse.ArgumentParser(
        description="Send test messages to SQS queue",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument("--queue-url", required=True, help="SQS queue URL")

    parser.add_argument(
        "--count", type=int, default=10, help="Number of messages to send (default: 10)"
    )

    parser.add_argument("--profile", help="AWS profile name to use")

    parser.add_argument(
        "--region",
        help="AWS region (optional, will use profile default if not specified)",
    )

    parser.add_argument("--fifo", action="store_true", help="Queue is FIFO queue")

    parser.add_argument(
        "--message-group",
        dest="message_group_id",
        help="Message group ID for FIFO queues",
    )

    parser.add_argument(
        "--no-batch",
        action="store_true",
        help="Disable batch sending (send one by one)",
    )

    args = parser.parse_args()

    # Validate arguments
    if args.count < 1:
        print("Error: count must be at least 1")
        sys.exit(1)

    if args.count > 1000:
        print("Warning: Sending more than 1000 messages may take a long time")
        response = input("Do you want to continue? (y/N): ")
        if response.lower() != "y":
            print("Cancelled")
            sys.exit(0)

    # Create sender and send messages
    sender = SQSMessageSender(
        queue_url=args.queue_url, profile=args.profile, region=args.region
    )

    sender.send_test_messages(
        count=args.count,
        fifo=args.fifo,
        message_group_id=args.message_group_id,
        batch=not args.no_batch,
    )


if __name__ == "__main__":
    main()
