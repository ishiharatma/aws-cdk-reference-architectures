"""Creates and deletes the Transfer Family server on demand.

A stopped (OFFLINE) Transfer Family server is still billed, so "stop" means delete and "start" means
create. The server is found by a tag, so no state is stored. The same function also handles the
CloudFormation custom resource events of the stack (Delete removes a server created by this function).

Invoke with {"action": "start" | "stop" | "status"} (EventBridge Scheduler or `aws lambda invoke`).
"""

import json
import logging
import os
import urllib.request
from typing import Optional

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TAG_KEY = "sftp-custom-idp-stack"
STACK_TAG = os.environ.get("STACK_TAG", "")
REGION = os.environ.get("AWS_REGION", "")

transfer = boto3.client("transfer")
cloudwatch = boto3.client("cloudwatch")

ALARM_PREFIX = os.environ.get("ALARM_PREFIX", "")
ALARM_METRICS = ("BytesIn", "BytesOut")


def find_servers() -> list:
    found = []
    for page in transfer.get_paginator("list_servers").paginate():
        for server in page["Servers"]:
            tags = transfer.list_tags_for_resource(Arn=server["Arn"]).get("Tags", [])
            if any(t["Key"] == TAG_KEY and t["Value"] == STACK_TAG for t in tags):
                found.append(server)
    return sorted(found, key=lambda s: s["ServerId"])


def find_server() -> Optional[dict]:
    servers = find_servers()
    return servers[0] if servers else None


def remove_duplicates() -> None:
    """Two overlapping start calls can each create a server (CreateServer has no idempotency token and the
    account may not allow reserved concurrency). Every caller keeps the lowest server ID and deletes the rest,
    so concurrent callers converge on the same server."""
    for duplicate in find_servers()[1:]:
        logger.warning(json.dumps({"action": "start", "result": "duplicate_deleted", "serverId": duplicate["ServerId"]}))
        transfer.delete_server(ServerId=duplicate["ServerId"])


def describe(server: Optional[dict]) -> dict:
    if server is None:
        return {"state": "ABSENT"}
    server_id = server["ServerId"]
    return {
        "state": server.get("State", "UNKNOWN"),
        "serverId": server_id,
        "endpoint": f"{server_id}.server.transfer.{REGION}.amazonaws.com",
    }


def put_alarms(server_id: str) -> None:
    """Alarms on the AWS/Transfer metrics of the current server (the server ID changes on every start)."""
    if not ALARM_PREFIX:
        return
    thresholds = {"BytesIn": float(os.environ["BYTES_IN_THRESHOLD"]), "BytesOut": float(os.environ["BYTES_OUT_THRESHOLD"])}
    period_minutes = int(os.environ["ALARM_PERIOD_MINUTES"])
    for metric in ALARM_METRICS:
        cloudwatch.put_metric_alarm(
            AlarmName=f"{ALARM_PREFIX}-{metric}",
            AlarmDescription=f"{metric} of the SFTP server {server_id} exceeded {thresholds[metric] / 1048576:g} MB in {period_minutes} minutes",
            Namespace="AWS/Transfer",
            MetricName=metric,
            Dimensions=[{"Name": "ServerId", "Value": server_id}],
            Statistic="Sum",
            Period=period_minutes * 60,
            EvaluationPeriods=1,
            Threshold=thresholds[metric],
            ComparisonOperator="GreaterThanThreshold",
            TreatMissingData="notBreaching",
            AlarmActions=[os.environ["ALARM_TOPIC_ARN"]],
        )


def delete_alarms() -> None:
    if ALARM_PREFIX:
        cloudwatch.delete_alarms(AlarmNames=[f"{ALARM_PREFIX}-{m}" for m in ALARM_METRICS])


def start() -> dict:
    existing = find_server()
    if existing is not None:
        logger.info(json.dumps({"action": "start", "result": "already_exists", "serverId": existing["ServerId"]}))
        put_alarms(existing["ServerId"])  # keep monitoring in place even if the alarms were removed by hand
        return describe(existing)

    params = {
        "Domain": "S3",
        "EndpointType": "PUBLIC",
        "IdentityProviderType": "AWS_LAMBDA",
        "IdentityProviderDetails": {
            "Function": os.environ["IDP_FUNCTION_ARN"],
            "SftpAuthenticationMethods": "PUBLIC_KEY",
        },
        "Protocols": ["SFTP"],
        "SecurityPolicyName": os.environ["SECURITY_POLICY_NAME"],
        "LoggingRole": os.environ["LOGGING_ROLE_ARN"],
        "StructuredLogDestinations": [os.environ["LOG_GROUP_ARN"]],
        "Tags": [{"Key": TAG_KEY, "Value": STACK_TAG}],
    }
    secret_arn = os.environ.get("HOST_KEY_SECRET_ARN")
    if secret_arn:
        # A fixed host key keeps the server fingerprint across delete / create cycles.
        secret = boto3.client("secretsmanager").get_secret_value(SecretId=secret_arn)["SecretString"]
        params["HostKey"] = secret
    created = transfer.create_server(**params)
    remove_duplicates()
    keeper = find_server() or {"ServerId": created["ServerId"]}
    put_alarms(keeper["ServerId"])
    logger.info(json.dumps({"action": "start", "result": "created", "serverId": keeper["ServerId"]}))
    return {
        "state": "STARTING",
        "serverId": keeper["ServerId"],
        "endpoint": f"{keeper['ServerId']}.server.transfer.{REGION}.amazonaws.com",
    }


def stop() -> dict:
    servers = find_servers()
    existing = servers[0] if servers else None
    delete_alarms()  # no server, no server alarms (an alarm on a missing server would only show missing data)
    if existing is None:
        return {"state": "ABSENT"}
    for server in servers:
        transfer.delete_server(ServerId=server["ServerId"])
    logger.info(json.dumps({"action": "stop", "result": "deleted", "serverId": existing["ServerId"]}))
    return {"state": "DELETING", "serverId": existing["ServerId"]}


def status() -> dict:
    return describe(find_server())


ACTIONS = {"start": start, "stop": stop, "status": status}


def send_cfn_response(event: dict, context, ok: bool, reason: str = "") -> None:
    body = json.dumps(
        {
            "Status": "SUCCESS" if ok else "FAILED",
            "Reason": reason or f"See CloudWatch Logs: {context.log_stream_name}",
            "PhysicalResourceId": event.get("PhysicalResourceId") or "server-cleanup",
            "StackId": event["StackId"],
            "RequestId": event["RequestId"],
            "LogicalResourceId": event["LogicalResourceId"],
            "Data": {},
        }
    ).encode()
    request = urllib.request.Request(event["ResponseURL"], data=body, method="PUT", headers={"Content-Type": ""})
    urllib.request.urlopen(request, timeout=10)  # noqa: S310 (pre-signed CloudFormation URL)


def lambda_handler(event: dict, context) -> Optional[dict]:
    if "RequestType" in event:  # CloudFormation custom resource: delete the on-demand server with the stack
        try:
            if event["RequestType"] == "Delete":
                stop()
            send_cfn_response(event, context, True)
        except Exception as e:  # always answer CloudFormation, otherwise the stack waits for an hour
            logger.exception("cleanup_failed")
            send_cfn_response(event, context, False, str(e))
        return None

    action = event.get("action")
    if action not in ACTIONS:
        raise ValueError(f"unknown action: {action!r} (expected start, stop or status)")
    return ACTIONS[action]()
