"""AWS Transfer Family custom identity provider (SSH public key only, with IP allow list).

Request/response contract:
https://docs.aws.amazon.com/transfer/latest/userguide/custom-lambda-idp.html

An empty dict ({}) is returned for every rejection (fail closed). Transfer Family treats a
response without `Role` as an authentication failure. Verification of the SSH signature itself is
done by Transfer Family; this function only returns the public keys registered for the user.

NOTE: The IP check below is an authentication-time check on the `sourceIp` supplied by Transfer
Family. It is NOT a network-level restriction: TCP/22 of the PUBLIC endpoint is reachable from the
internet and unauthorized clients are rejected after the SSH handshake has started.
"""

import ipaddress
import json
import logging
import os
import re
import time
from typing import Any, Optional

import boto3
from boto3.dynamodb.types import TypeDeserializer

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

TABLE_NAME = os.environ.get("USER_TABLE_NAME", "")
IDENTITY_PROVIDER_KEY = os.environ.get("IDENTITY_PROVIDER_KEY", "publickeys")

# Lower-case only: DynamoDB look-ups are case sensitive and the user table stores lower-case names.
USERNAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,63}$")
ROLE_ARN_PATTERN = re.compile(r"^arn:aws[a-z-]*:iam::\d{12}:role/[\w+=,.@/-]+$")
HOME_DIRECTORY_PATTERN = re.compile(r"^/[a-z0-9.-]{3,63}(/[^/\0]+)*$")

_dynamodb = None
_deserializer = TypeDeserializer()


def _client():
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.client("dynamodb")
    return _dynamodb


def log_event(result: str, reason: str, event: dict, **extra: Any) -> None:
    """Emit one JSON log line. Public keys and passwords are never logged."""
    record = {
        "ts": int(time.time()),
        "result": result,
        "reason": reason,
        "username": event.get("username"),
        "sourceIp": event.get("sourceIp"),
        "serverId": event.get("serverId"),
        "protocol": event.get("protocol"),
    }
    record.update(extra)
    line = json.dumps(record, default=str)
    if result == "SUCCESS":
        logger.info(line)
    else:
        logger.warning(line)


def ip_allowed(source_ip: str, allowed_ranges: list) -> bool:
    """Return True if source_ip is inside at least one CIDR of allowed_ranges (IPv4 and IPv6)."""
    try:
        ip = ipaddress.ip_address(source_ip)
    except (ValueError, TypeError):
        return False
    for cidr in allowed_ranges:
        try:
            network = ipaddress.ip_network(cidr, strict=False)
        except ValueError:
            # A malformed entry never grants access.
            continue
        if ip.version == network.version and ip in network:
            return True
    return False


def _as_list(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, (set, list, tuple)):
        return sorted(str(v) for v in value)
    return [str(value)]


def get_user_record(username: str) -> Optional[dict]:
    """Fetch the user item. The schema follows the AWS custom IdP solution (users table)."""
    response = _client().get_item(
        TableName=TABLE_NAME,
        Key={"user": {"S": username}, "identity_provider_key": {"S": IDENTITY_PROVIDER_KEY}},
        ConsistentRead=True,
    )
    item = response.get("Item")
    if not item:
        return None
    return {k: _deserializer.deserialize(v) for k, v in item.items()}


def build_session_policy(bucket: str, prefix: str) -> str:
    """Session policy that scopes the (possibly shared) role down to the user's own prefix."""
    object_arn = f"arn:aws:s3:::{bucket}/{prefix}/*" if prefix else f"arn:aws:s3:::{bucket}/*"
    list_prefixes = [f"{prefix}/*", prefix] if prefix else ["*"]
    return json.dumps(
        {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "AllowListingOfUserFolder",
                    "Effect": "Allow",
                    "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
                    "Resource": f"arn:aws:s3:::{bucket}",
                    "Condition": {"StringLike": {"s3:prefix": list_prefixes}},
                },
                {
                    "Sid": "AllowObjectAccessInUserFolder",
                    "Effect": "Allow",
                    "Action": [
                        "s3:GetObject",
                        "s3:GetObjectVersion",
                        "s3:GetObjectAttributes",
                        "s3:PutObject",
                        "s3:DeleteObject",
                        "s3:DeleteObjectVersion",
                    ],
                    "Resource": object_arn,
                },
            ],
        }
    )


def authenticate(event: dict) -> tuple:
    """Return (response, reason). response == {} means rejected."""
    if event.get("protocol") != "SFTP":
        return {}, "protocol_not_allowed"

    # Key-only server: Transfer Family does not send a password in the key phase.
    # A password in the event means the flow is not the public key flow.
    if event.get("password"):
        return {}, "password_not_allowed"

    username = event.get("username")
    if not isinstance(username, str) or not USERNAME_PATTERN.match(username):
        return {}, "invalid_username"

    try:
        record = get_user_record(username)
    except Exception:  # fail closed on any DynamoDB error
        logger.exception("dynamodb_error")
        return {}, "dynamodb_error"

    if record is None:
        return {}, "user_not_found"

    if record.get("enabled") is not True:
        return {}, "user_disabled"

    allow_list = _as_list(record.get("ipv4_allow_list"))
    if not allow_list:
        return {}, "ip_allow_list_empty"
    ip_ok = ip_allowed(str(event.get("sourceIp", "")), allow_list)
    if not ip_ok:
        return {}, "ip_not_allowed"

    server_allow_list = _as_list(record.get("server_id_allow_list"))
    if server_allow_list and event.get("serverId") not in server_allow_list:
        return {}, "server_not_allowed"

    config = record.get("config") or {}
    public_keys = _as_list(config.get("PublicKeys"))
    role = config.get("Role")
    home_directory = config.get("HomeDirectory")
    if not public_keys:
        return {}, "no_public_keys"
    if not isinstance(role, str) or not ROLE_ARN_PATTERN.match(role):
        return {}, "invalid_role"
    if not isinstance(home_directory, str) or not HOME_DIRECTORY_PATTERN.match(home_directory):
        return {}, "invalid_home_directory"

    # "/bucket/prefix" -> bucket, prefix
    parts = home_directory.strip("/").split("/", 1)
    bucket = parts[0]
    prefix = parts[1].strip("/") if len(parts) > 1 else ""

    response = {
        "Role": role,
        "PublicKeys": public_keys,
        "Policy": build_session_policy(bucket, prefix),
        # LOGICAL: the client sees only "/" (its own prefix), not the bucket name or other prefixes.
        "HomeDirectoryType": "LOGICAL",
        "HomeDirectoryDetails": json.dumps([{"Entry": "/", "Target": home_directory}]),
    }
    return response, "ok"


def lambda_handler(event: dict, context: Any) -> dict:
    try:
        response, reason = authenticate(event)
    except Exception:  # never let an unexpected error produce a permissive response
        logger.exception("unexpected_error")
        response, reason = {}, "unexpected_error"

    if response:
        log_event("SUCCESS", reason, event, ipAllowListCheck="passed", publicKeyCount=len(response["PublicKeys"]))
    else:
        log_event(
            "FAILURE",
            reason,
            event,
            ipAllowListCheck="failed" if reason == "ip_not_allowed" else "not_evaluated",
        )
    return response
