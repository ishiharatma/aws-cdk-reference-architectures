"""Custom resource: register a Managed AD directory with WorkSpaces Personal and lock its settings.

aws-cdk-lib has no L1 for AWS::WorkSpaces::Directory, so registration and the settings that the
operator role is denied from changing are applied here:

- RegisterWorkspaceDirectory (subnets, self-service off, shared tenancy)
- ModifyWorkspaceCreationProperties (default OU, no public IP, extra security group, local admin)
- ModifyWorkspaceAccessProperties (Windows client only)
- ModifyClientProperties (reconnect / saved credentials disabled)
- ModifySelfservicePermissions (all disabled)
- Associate / disassociate IP access control groups

on_event starts the asynchronous registration; is_complete waits for REGISTERED, then applies
the settings, so a failed setting fails the stack instead of leaving a half-configured directory.
"""

from __future__ import annotations

import logging
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

workspaces = boto3.client("workspaces")

DEVICE_TYPES = [
    "DeviceTypeWindows",
    "DeviceTypeOsx",
    "DeviceTypeWeb",
    "DeviceTypeIos",
    "DeviceTypeAndroid",
    "DeviceTypeChromeOs",
    "DeviceTypeZeroClient",
    "DeviceTypeLinux",
    "DeviceTypeWorkSpacesThinClient",
]


def _to_bool(value: Any) -> bool:
    # CloudFormation passes every custom resource property as a string.
    return str(value).lower() == "true"


def _describe(directory_id: str) -> dict[str, Any] | None:
    response = workspaces.describe_workspace_directories(DirectoryIds=[directory_id])
    directories = response.get("Directories", [])
    return directories[0] if directories else None


def build_access_properties(allowed_device_types: list[str]) -> dict[str, str]:
    """ALLOW only the listed device types and DENY every other known one."""
    unknown = set(allowed_device_types) - set(DEVICE_TYPES)
    if unknown:
        raise ValueError(f"Unknown device types: {sorted(unknown)}")
    return {device: ("ALLOW" if device in allowed_device_types else "DENY") for device in DEVICE_TYPES}


def build_creation_properties(props: dict[str, Any]) -> dict[str, Any]:
    return {
        "EnableInternetAccess": False,
        "DefaultOu": props["DefaultOu"],
        "CustomSecurityGroupId": props["CustomSecurityGroupId"],
        "UserEnabledAsLocalAdministrator": _to_bool(props["UserEnabledAsLocalAdministrator"]),
        "EnableMaintenanceMode": True,
    }


def plan_ip_group_changes(current: list[str], desired: list[str]) -> tuple[list[str], list[str]]:
    """Return (to_associate, to_disassociate)."""
    to_associate = [group for group in desired if group not in current]
    to_disassociate = [group for group in current if group not in desired]
    return to_associate, to_disassociate


def _apply_settings(directory_id: str, props: dict[str, Any], current_ip_groups: list[str]) -> None:
    workspaces.modify_workspace_creation_properties(
        ResourceId=directory_id,
        WorkspaceCreationProperties=build_creation_properties(props),
    )
    workspaces.modify_workspace_access_properties(
        ResourceId=directory_id,
        WorkspaceAccessProperties=build_access_properties(props["AllowedDeviceTypes"]),
    )
    workspaces.modify_client_properties(
        ResourceId=directory_id,
        ClientProperties={"ReconnectEnabled": "DISABLED"},
    )
    workspaces.modify_selfservice_permissions(
        ResourceId=directory_id,
        SelfservicePermissions={
            "RestartWorkspace": "DISABLED",
            "IncreaseVolumeSize": "DISABLED",
            "ChangeComputeType": "DISABLED",
            "SwitchRunningMode": "DISABLED",
            "RebuildWorkspace": "DISABLED",
        },
    )
    to_associate, to_disassociate = plan_ip_group_changes(current_ip_groups, props["IpGroupIds"])
    if to_disassociate:
        workspaces.disassociate_ip_groups(DirectoryId=directory_id, GroupIds=to_disassociate)
    if to_associate:
        workspaces.associate_ip_groups(DirectoryId=directory_id, GroupIds=to_associate)


def on_event(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    request_type = event["RequestType"]
    props = event["ResourceProperties"]
    directory_id = props["DirectoryId"]
    logger.info("%s for directory %s", request_type, directory_id)

    if request_type == "Create" or (
        request_type == "Update" and event["OldResourceProperties"]["DirectoryId"] != directory_id
    ):
        # A changed DirectoryId is a replacement: CloudFormation sends Delete for the old one.
        existing = _describe(directory_id)
        if existing is None or existing.get("State") == "DEREGISTERED":
            workspaces.register_workspace_directory(
                DirectoryId=directory_id,
                SubnetIds=props["SubnetIds"],
                EnableSelfService=False,
                Tenancy="SHARED",
            )
        return {"PhysicalResourceId": directory_id}

    if request_type == "Update":
        return {"PhysicalResourceId": event["PhysicalResourceId"]}

    # Delete
    physical_id = event["PhysicalResourceId"]
    existing = _describe(physical_id)
    if existing is not None and existing.get("State") != "DEREGISTERED":
        ip_groups = existing.get("ipGroupIds", [])
        if ip_groups:
            workspaces.disassociate_ip_groups(DirectoryId=physical_id, GroupIds=ip_groups)
        try:
            workspaces.deregister_workspace_directory(DirectoryId=physical_id)
        except ClientError as error:
            # Deregistration fails while WorkSpaces exist; surface it instead of orphaning them.
            raise RuntimeError(
                f"Cannot deregister {physical_id}: terminate its WorkSpaces first ({error})"
            ) from error
    return {"PhysicalResourceId": physical_id}


def is_complete(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    request_type = event["RequestType"]
    props = event["ResourceProperties"]
    directory_id = event.get("PhysicalResourceId") or props["DirectoryId"]
    directory = _describe(directory_id)

    if request_type == "Delete":
        done = directory is None or directory.get("State") == "DEREGISTERED"
        return {"IsComplete": done}

    if directory is None:
        return {"IsComplete": False}
    state = directory.get("State")
    logger.info("Directory %s state: %s", directory_id, state)
    if state == "ERROR":
        raise RuntimeError(f"Directory registration failed for {directory_id}")
    if state != "REGISTERED":
        return {"IsComplete": False}

    _apply_settings(directory_id, props, directory.get("ipGroupIds", []))
    return {
        "IsComplete": True,
        "Data": {
            "RegistrationCode": directory.get("RegistrationCode", ""),
            "WorkspaceSecurityGroupId": directory.get("WorkspaceSecurityGroupId", ""),
        },
    }
