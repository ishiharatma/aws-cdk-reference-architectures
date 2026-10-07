import os
import sys
import unittest
from unittest import mock

os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")
os.environ.update(
    STACK_TAG="stack-a",
    IDP_FUNCTION_ARN="arn:aws:lambda:ap-northeast-1:123456789012:function:idp",
    LOGGING_ROLE_ARN="arn:aws:iam::123456789012:role/log",
    LOG_GROUP_ARN="arn:aws:logs:ap-northeast-1:123456789012:log-group:/aws/transfer/x",
    SECURITY_POLICY_NAME="TransferSecurityPolicy-2024-01",
    ALARM_PREFIX="p-dev-sftp",
    ALARM_TOPIC_ARN="arn:aws:sns:ap-northeast-1:123456789012:t",
    ALARM_PERIOD_MINUTES="5",
    BYTES_IN_THRESHOLD="1048576",
    BYTES_OUT_THRESHOLD="2097152",
)

import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("controller_handler", os.path.join(os.path.dirname(__file__), "..", "lambda", "server_controller", "handler.py"))
handler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(handler)

SERVER = {"ServerId": "s-1111111111111111a", "Arn": "arn:aws:transfer:ap-northeast-1:123456789012:server/s-1111111111111111a", "State": "ONLINE"}
OWN_TAG = [{"Key": handler.TAG_KEY, "Value": "stack-a"}]


class ControllerTest(unittest.TestCase):
    def setUp(self):
        self.client = mock.MagicMock()
        self.client.get_paginator.return_value.paginate.return_value = [{"Servers": []}]
        patcher = mock.patch.object(handler, "transfer", self.client)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.cw = mock.MagicMock()
        cw_patcher = mock.patch.object(handler, "cloudwatch", self.cw)
        cw_patcher.start()
        self.addCleanup(cw_patcher.stop)

    def with_server(self, tags):
        self.client.get_paginator.return_value.paginate.return_value = [{"Servers": [SERVER]}]
        self.client.list_tags_for_resource.return_value = {"Tags": tags}

    def test_status_absent(self):
        self.assertEqual(handler.lambda_handler({"action": "status"}, None), {"state": "ABSENT"})

    def test_start_creates_a_key_only_public_server(self):
        self.client.create_server.return_value = {"ServerId": "s-2222222222222222b"}
        res = handler.lambda_handler({"action": "start"}, None)
        kwargs = self.client.create_server.call_args.kwargs
        self.assertEqual(kwargs["EndpointType"], "PUBLIC")
        self.assertEqual(kwargs["Protocols"], ["SFTP"])
        self.assertEqual(kwargs["IdentityProviderDetails"]["SftpAuthenticationMethods"], "PUBLIC_KEY")
        self.assertEqual(kwargs["Tags"], OWN_TAG)
        self.assertNotIn("HostKey", kwargs)
        self.assertEqual(res["state"], "STARTING")

    def test_start_creates_alarms_for_the_new_server(self):
        self.client.create_server.return_value = {"ServerId": "s-2222222222222222b"}
        handler.lambda_handler({"action": "start"}, None)
        calls = {c.kwargs["AlarmName"]: c.kwargs for c in self.cw.put_metric_alarm.call_args_list}
        self.assertEqual(set(calls), {"p-dev-sftp-BytesIn", "p-dev-sftp-BytesOut"})
        self.assertEqual(calls["p-dev-sftp-BytesIn"]["Dimensions"], [{"Name": "ServerId", "Value": "s-2222222222222222b"}])
        self.assertEqual(calls["p-dev-sftp-BytesOut"]["Threshold"], 2097152.0)
        self.assertEqual(calls["p-dev-sftp-BytesIn"]["Period"], 300)
        self.assertEqual(calls["p-dev-sftp-BytesIn"]["AlarmActions"], [os.environ["ALARM_TOPIC_ARN"]])

    def test_start_on_existing_server_restores_alarms(self):
        self.with_server(OWN_TAG)
        handler.lambda_handler({"action": "start"}, None)
        self.assertEqual(self.cw.put_metric_alarm.call_count, 2)

    def test_stop_deletes_the_alarms(self):
        self.with_server(OWN_TAG)
        handler.lambda_handler({"action": "stop"}, None)
        self.cw.delete_alarms.assert_called_once_with(AlarmNames=["p-dev-sftp-BytesIn", "p-dev-sftp-BytesOut"])

    def test_stop_without_server_still_deletes_alarms(self):
        handler.lambda_handler({"action": "stop"}, None)
        self.cw.delete_alarms.assert_called_once()

    def test_overlapping_start_keeps_the_lowest_server_id(self):
        other = {"ServerId": "s-0000000000000000a", "Arn": "arn:aws:transfer:ap-northeast-1:123456789012:server/s-0000000000000000a"}
        self.client.get_paginator.return_value.paginate.side_effect = [
            [{"Servers": []}],
            [{"Servers": [SERVER, other]}],
            [{"Servers": [SERVER, other]}],
        ]
        self.client.list_tags_for_resource.return_value = {"Tags": OWN_TAG}
        self.client.create_server.return_value = {"ServerId": SERVER["ServerId"]}
        res = handler.lambda_handler({"action": "start"}, None)
        self.client.delete_server.assert_called_once_with(ServerId=SERVER["ServerId"])
        self.assertEqual(res["serverId"], "s-0000000000000000a")

    def test_start_is_idempotent(self):
        self.with_server(OWN_TAG)
        res = handler.lambda_handler({"action": "start"}, None)
        self.client.create_server.assert_not_called()
        self.assertEqual(res["serverId"], SERVER["ServerId"])

    def test_servers_of_other_stacks_are_ignored(self):
        self.with_server([{"Key": handler.TAG_KEY, "Value": "other-stack"}])
        self.assertEqual(handler.lambda_handler({"action": "status"}, None), {"state": "ABSENT"})
        handler.lambda_handler({"action": "stop"}, None)
        self.client.delete_server.assert_not_called()

    def test_stop_deletes_own_server(self):
        self.with_server(OWN_TAG)
        handler.lambda_handler({"action": "stop"}, None)
        self.client.delete_server.assert_called_once_with(ServerId=SERVER["ServerId"])

    def test_unknown_action(self):
        with self.assertRaises(ValueError):
            handler.lambda_handler({"action": "restart"}, None)

    def test_host_key_comes_from_secret(self):
        self.client.create_server.return_value = {"ServerId": "s-3333333333333333c"}
        sm = mock.MagicMock()
        sm.get_secret_value.return_value = {"SecretString": "PRIVATE-KEY"}
        with mock.patch.dict(os.environ, {"HOST_KEY_SECRET_ARN": "arn:secret"}), mock.patch.object(handler.boto3, "client", return_value=sm):
            handler.start()
        self.assertEqual(self.client.create_server.call_args.kwargs["HostKey"], "PRIVATE-KEY")

    def test_cloudformation_delete_removes_server_and_always_responds(self):
        self.with_server(OWN_TAG)
        event = {"RequestType": "Delete", "StackId": "s", "RequestId": "r", "LogicalResourceId": "l", "ResponseURL": "https://example.invalid"}
        ctx = mock.MagicMock(log_stream_name="x")
        with mock.patch.object(handler, "send_cfn_response") as send:
            handler.lambda_handler(event, ctx)
        self.client.delete_server.assert_called_once()
        self.assertTrue(send.call_args.args[2])

    def test_cloudformation_delete_failure_still_responds(self):
        self.with_server(OWN_TAG)
        self.client.delete_server.side_effect = RuntimeError("boom")
        event = {"RequestType": "Delete", "StackId": "s", "RequestId": "r", "LogicalResourceId": "l", "ResponseURL": "https://example.invalid"}
        with mock.patch.object(handler, "send_cfn_response") as send:
            handler.lambda_handler(event, mock.MagicMock())
        self.assertFalse(send.call_args.args[2])


if __name__ == "__main__":
    unittest.main()
