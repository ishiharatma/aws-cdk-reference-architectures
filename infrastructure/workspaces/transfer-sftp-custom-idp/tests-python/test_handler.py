import json
import os
import sys
import unittest
from unittest import mock

os.environ.setdefault("USER_TABLE_NAME", "users")

import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("idp_handler", os.path.join(os.path.dirname(__file__), "..", "lambda", "custom_idp", "handler.py"))
handler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(handler)

ROLE = "arn:aws:iam::123456789012:role/TransferSftpRole"
KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample"


def record(**over):
    base = {
        "user": "system01",
        "enabled": True,
        "ipv4_allow_list": {"203.0.113.10/32", "198.51.100.0/24"},
        "config": {"Role": ROLE, "HomeDirectory": "/bucket/system01", "PublicKeys": {KEY}},
    }
    base.update(over)
    return base


def event(**over):
    base = {"username": "system01", "protocol": "SFTP", "serverId": "s-1234567890abcdef0", "sourceIp": "203.0.113.10"}
    base.update(over)
    return base


class HandlerTest(unittest.TestCase):
    def run_with(self, rec, ev):
        with mock.patch.object(handler, "get_user_record", return_value=rec):
            return handler.lambda_handler(ev, None)

    def test_success(self):
        res = self.run_with(record(), event())
        self.assertEqual(res["Role"], ROLE)
        self.assertEqual(res["PublicKeys"], [KEY])
        self.assertEqual(json.loads(res["HomeDirectoryDetails"]), [{"Entry": "/", "Target": "/bucket/system01"}])

    def test_cidr_range(self):
        self.assertTrue(self.run_with(record(), event(sourceIp="198.51.100.77")))

    def test_ip_denied(self):
        self.assertEqual(self.run_with(record(), event(sourceIp="192.0.2.1")), {})

    def test_unknown_user(self):
        self.assertEqual(self.run_with(None, event()), {})

    def test_disabled(self):
        self.assertEqual(self.run_with(record(enabled=False), event()), {})

    def test_enabled_missing(self):
        rec = record()
        del rec["enabled"]
        self.assertEqual(self.run_with(rec, event()), {})

    def test_bad_protocol(self):
        self.assertEqual(self.run_with(record(), event(protocol="FTP")), {})

    def test_password_rejected(self):
        self.assertEqual(self.run_with(record(), event(password="x")), {})

    def test_empty_allow_list(self):
        self.assertEqual(self.run_with(record(ipv4_allow_list=set()), event()), {})

    def test_dynamodb_error(self):
        with mock.patch.object(handler, "get_user_record", side_effect=RuntimeError("boom")):
            self.assertEqual(handler.lambda_handler(event(), None), {})

    def test_invalid_username(self):
        self.assertEqual(self.run_with(record(), event(username="System01")), {})

    def test_ipv6(self):
        self.assertTrue(handler.ip_allowed("2001:db8::1", ["2001:db8::/32"]))
        self.assertFalse(handler.ip_allowed("2001:db8::1", ["203.0.113.0/24"]))
        self.assertFalse(handler.ip_allowed("not-an-ip", ["0.0.0.0/0"]))

    def test_session_policy_scoped(self):
        pol = json.loads(handler.build_session_policy("bucket", "system01"))
        self.assertEqual(pol["Statement"][1]["Resource"], "arn:aws:s3:::bucket/system01/*")

    def test_no_key_logged(self):
        with self.assertLogs(level="INFO") as cm:
            self.run_with(record(), event())
        self.assertNotIn("AAAAC3", "".join(cm.output))


if __name__ == "__main__":
    unittest.main()
