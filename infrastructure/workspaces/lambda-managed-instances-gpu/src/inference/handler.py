"""GPU image classification handler for Lambda Managed Instances.

Triggered by an SQS event source mapping. Each SQS message carries an S3
ObjectCreated notification; all images in one invocation are classified as a
single GPU batch and the top-5 labels are written to DynamoDB.

Lambda Managed Instances runs several invocations concurrently in one execution
environment (PerExecutionEnvironmentMaxConcurrency). For Python each concurrent
slot is a separate worker process, so the module-level model below is loaded
once per worker and shared by all invocations that worker serves.
"""

import io
import json
import logging
import os
import time
import urllib.parse
from datetime import datetime, timezone
from decimal import Decimal

import boto3
import torch
from PIL import Image
from torchvision.models import ResNet50_Weights, resnet50

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TABLE_NAME = os.environ["TABLE_NAME"]
RESULT_TTL_DAYS = int(os.environ.get("RESULT_TTL_DAYS", "7"))
TOP_K = 5

# ---------------------------------------------------------------- init (once per worker)
_init_started = time.perf_counter()
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
GPU_NAME = torch.cuda.get_device_name(0) if DEVICE.type == "cuda" else "none"

# Weights are baked into the image at build time (TORCH_HOME), so nothing is
# downloaded at runtime and the isolated subnets need no internet access.
WEIGHTS = ResNet50_Weights.IMAGENET1K_V2
MODEL = resnet50(weights=WEIGHTS).eval().to(DEVICE)
PREPROCESS = WEIGHTS.transforms()
CATEGORIES = WEIGHTS.meta["categories"]

# Warm up CUDA kernels so the first real invocation does not pay for them.
with torch.inference_mode():
    MODEL(torch.zeros(1, 3, 224, 224, device=DEVICE))
if DEVICE.type == "cuda":
    torch.cuda.synchronize()

INIT_MS = round((time.perf_counter() - _init_started) * 1000)
logger.info(json.dumps({"event": "init", "device": DEVICE.type, "gpuName": GPU_NAME, "initMs": INIT_MS,
                        "torch": torch.__version__, "cuda": torch.version.cuda}))

s3 = boto3.client("s3")
table = boto3.resource("dynamodb").Table(TABLE_NAME)


def _s3_objects(message_body: str) -> list[tuple[str, str]]:
    """Extract (bucket, key) pairs from an S3 event notification body."""
    body = json.loads(message_body)
    # S3 sends a one-off s3:TestEvent when the notification is configured.
    if body.get("Event") == "s3:TestEvent":
        return []
    return [
        (r["s3"]["bucket"]["name"], urllib.parse.unquote_plus(r["s3"]["object"]["key"]))
        for r in body.get("Records", [])
    ]


def _load_image(bucket: str, key: str) -> torch.Tensor:
    obj = s3.get_object(Bucket=bucket, Key=key)
    image = Image.open(io.BytesIO(obj["Body"].read())).convert("RGB")
    return PREPROCESS(image)


def handler(event, context):
    failures: list[dict] = []
    # (messageId, objectKey, tensor)
    items: list[tuple[str, str, torch.Tensor]] = []

    for record in event.get("Records", []):
        message_id = record["messageId"]
        try:
            for bucket, key in _s3_objects(record["body"]):
                items.append((message_id, key, _load_image(bucket, key)))
        except Exception:  # noqa: BLE001 - report the message as failed and keep the rest of the batch
            logger.exception("failed to load message %s", message_id)
            failures.append({"itemIdentifier": message_id})

    if not items:
        return {"batchItemFailures": failures}

    failed_ids = {f["itemIdentifier"] for f in failures}
    started = time.perf_counter()
    try:
        batch = torch.stack([t for _, _, t in items]).to(DEVICE, non_blocking=True)
        with torch.inference_mode():
            probabilities = MODEL(batch).softmax(dim=1)
            top_prob, top_idx = probabilities.topk(TOP_K, dim=1)
        if DEVICE.type == "cuda":
            torch.cuda.synchronize()
    except Exception:  # noqa: BLE001 - a failed batch is retried message by message by SQS
        logger.exception("batch inference failed")
        return {"batchItemFailures": failures + [{"itemIdentifier": m} for m in {m for m, _, _ in items} - failed_ids]}
    inference_ms = round((time.perf_counter() - started) * 1000, 2)

    now = datetime.now(timezone.utc)
    expires_at = int(now.timestamp()) + RESULT_TTL_DAYS * 86400
    with table.batch_writer() as writer:
        for i, (message_id, key, _) in enumerate(items):
            if message_id in failed_ids:
                continue
            writer.put_item(Item={
                "objectKey": key,
                "labels": [
                    {"label": CATEGORIES[idx], "score": Decimal(str(round(prob, 6)))}
                    for prob, idx in zip(top_prob[i].tolist(), top_idx[i].tolist())
                ],
                "device": DEVICE.type,
                "gpuName": GPU_NAME,
                "batchSize": len(items),
                "batchInferenceMs": Decimal(str(inference_ms)),
                "workerInitMs": INIT_MS,
                "workerPid": os.getpid(),
                "requestId": context.aws_request_id,
                "functionVersion": context.function_version,
                "processedAt": now.isoformat(),
                "expiresAt": expires_at,
            })

    logger.info(json.dumps({"event": "batch", "images": len(items), "inferenceMs": inference_ms,
                            "gpuName": GPU_NAME, "failures": len(failures)}))
    return {"batchItemFailures": failures}
