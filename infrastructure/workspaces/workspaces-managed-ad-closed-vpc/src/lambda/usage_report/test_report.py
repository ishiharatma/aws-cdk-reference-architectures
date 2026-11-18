"""Unit tests for report.py (run: python3 -m unittest discover -s src/lambda/usage_report)."""

from __future__ import annotations

import csv
import io
import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from report import (
    CSV_HEADER,
    STATUS_ACTIVE,
    STATUS_INACTIVE,
    STATUS_NEVER,
    build_message,
    build_rows,
    classify,
    report_key,
    to_csv,
)

NOW = datetime(2026, 12, 1, 0, 0, tzinfo=timezone.utc)
JST = ZoneInfo("Asia/Tokyo")


def workspace(workspace_id: str, user: str) -> dict:
    return {
        "WorkspaceId": workspace_id,
        "UserName": user,
        "DirectoryId": "d-1234567890",
        "State": "AVAILABLE",
        "WorkspaceProperties": {"ComputeTypeName": "STANDARD", "RunningMode": "AUTO_STOP"},
    }


class ClassifyTest(unittest.TestCase):
    def test_never_connected(self) -> None:
        self.assertEqual(classify(None, NOW, 30), (None, STATUS_NEVER))

    def test_threshold_is_inclusive(self) -> None:
        self.assertEqual(classify(NOW - timedelta(days=30), NOW, 30), (30, STATUS_INACTIVE))
        self.assertEqual(classify(NOW - timedelta(days=29, hours=23), NOW, 30), (29, STATUS_ACTIVE))


class BuildRowsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = build_rows(
            [workspace("ws-a", "alice"), workspace("ws-b", "bob"), workspace("ws-c", "carol"), workspace("ws-d", "dave")],
            {
                "ws-a": {"WorkspaceId": "ws-a", "LastKnownUserConnectionTimestamp": NOW - timedelta(days=2), "ConnectionState": "CONNECTED"},
                "ws-b": {"WorkspaceId": "ws-b", "LastKnownUserConnectionTimestamp": NOW - timedelta(days=45), "ConnectionState": "DISCONNECTED"},
                "ws-c": {"WorkspaceId": "ws-c", "ConnectionState": "DISCONNECTED"},
                "ws-d": {"WorkspaceId": "ws-d", "LastKnownUserConnectionTimestamp": NOW - timedelta(days=90), "ConnectionState": "DISCONNECTED"},
            },
            NOW,
            30,
        )

    def test_attention_first(self) -> None:
        # never connected, then the longest unused, then active
        self.assertEqual([row.workspace_id for row in self.rows], ["ws-c", "ws-d", "ws-b", "ws-a"])

    def test_missing_status_is_unknown(self) -> None:
        rows = build_rows([workspace("ws-x", "xavier")], {}, NOW, 30)
        self.assertEqual(rows[0].connection_state, "UNKNOWN")
        self.assertEqual(rows[0].status, STATUS_NEVER)


class CsvTest(unittest.TestCase):
    def test_bom_header_and_local_time(self) -> None:
        rows = build_rows(
            [workspace("ws-a", "山田")],
            {"ws-a": {"WorkspaceId": "ws-a", "LastKnownUserConnectionTimestamp": datetime(2026, 11, 30, 15, 0, tzinfo=timezone.utc)}},
            NOW,
            30,
        )
        text = to_csv(rows, JST)
        self.assertTrue(text.startswith("﻿"))
        parsed = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
        self.assertEqual(parsed[0], CSV_HEADER)
        self.assertEqual(parsed[1][0], "山田")
        self.assertEqual(parsed[1][7], "2026-12-01 00:00:00")  # 15:00 UTC = 00:00 JST next day


class MessageTest(unittest.TestCase):
    def test_subject_and_counts(self) -> None:
        rows = build_rows(
            [workspace("ws-a", "alice"), workspace("ws-c", "carol")],
            {"ws-a": {"WorkspaceId": "ws-a", "LastKnownUserConnectionTimestamp": NOW - timedelta(days=1)}},
            NOW,
            30,
        )
        subject, body = build_message(rows, NOW, JST, 30, "s3://bucket/key.csv")
        self.assertEqual(subject, "WorkSpaces usage report 2026-12 (2 WorkSpaces)")
        self.assertLessEqual(len(subject), 100)
        self.assertIn("Never connected           : 1", body)
        self.assertIn("- carol / ws-c / never / -", body)
        self.assertNotIn("alice", body)

    def test_list_is_truncated(self) -> None:
        rows = build_rows([workspace(f"ws-{i}", f"user{i}") for i in range(5)], {}, NOW, 30)
        _, body = build_message(rows, NOW, JST, 30, "s3://b/k", max_listed=2)
        self.assertIn("... and 3 more (see the CSV)", body)


class KeyTest(unittest.TestCase):
    def test_key_uses_local_month(self) -> None:
        self.assertEqual(
            report_key("reports/", NOW, JST),
            "reports/2026/12/workspaces-usage-20261201-090000.csv",
        )


if __name__ == "__main__":
    unittest.main()
