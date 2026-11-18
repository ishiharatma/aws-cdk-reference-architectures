"""Unit tests for the pure helpers of index.py (run: python3 -m unittest discover -s src/lambda/directory_registration)."""

from __future__ import annotations

import os
import sys
import types
import unittest
from unittest import mock

# index.py creates a boto3 client at import time; a Region is all it needs.
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")

# The helpers under test make no AWS calls; stub boto3 / botocore when they are not installed
# locally (the Lambda runtime provides them).
try:
    import boto3  # noqa: F401
except ModuleNotFoundError:
    sys.modules["boto3"] = types.SimpleNamespace(client=mock.MagicMock())  # type: ignore[assignment]
    exceptions = types.ModuleType("botocore.exceptions")
    exceptions.ClientError = type("ClientError", (Exception,), {})  # type: ignore[attr-defined]
    sys.modules["botocore"] = types.ModuleType("botocore")
    sys.modules["botocore.exceptions"] = exceptions

from index import (  # noqa: E402
    DEVICE_TYPES,
    build_access_properties,
    build_creation_properties,
    plan_ip_group_changes,
)


class AccessPropertiesTest(unittest.TestCase):
    def test_only_windows_is_allowed(self) -> None:
        properties = build_access_properties(["DeviceTypeWindows"])
        self.assertEqual(properties["DeviceTypeWindows"], "ALLOW")
        self.assertEqual(set(properties), set(DEVICE_TYPES))
        self.assertEqual({v for k, v in properties.items() if k != "DeviceTypeWindows"}, {"DENY"})

    def test_web_access_is_denied(self) -> None:
        self.assertEqual(build_access_properties(["DeviceTypeWindows"])["DeviceTypeWeb"], "DENY")

    def test_unknown_device_type_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            build_access_properties(["DeviceTypeToaster"])


class CreationPropertiesTest(unittest.TestCase):
    def test_string_booleans_and_fixed_values(self) -> None:
        props = {
            "DefaultOu": "OU=WorkSpaces,OU=Computers,OU=WSDEV,DC=wsdev,DC=example,DC=co,DC=jp",
            "CustomSecurityGroupId": "sg-0123456789abcdef0",
            "UserEnabledAsLocalAdministrator": "false",
        }
        result = build_creation_properties(props)
        self.assertIs(result["UserEnabledAsLocalAdministrator"], False)
        self.assertIs(result["EnableInternetAccess"], False)
        self.assertEqual(result["DefaultOu"], props["DefaultOu"])
        self.assertIs(build_creation_properties({**props, "UserEnabledAsLocalAdministrator": "true"})["UserEnabledAsLocalAdministrator"], True)


class IpGroupPlanTest(unittest.TestCase):
    def test_replaces_unexpected_groups(self) -> None:
        self.assertEqual(plan_ip_group_changes(["wsipg-old", "wsipg-keep"], ["wsipg-keep", "wsipg-new"]), (["wsipg-new"], ["wsipg-old"]))

    def test_no_change(self) -> None:
        self.assertEqual(plan_ip_group_changes(["wsipg-a"], ["wsipg-a"]), ([], []))


if __name__ == "__main__":
    unittest.main()
