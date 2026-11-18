"""Pure functions that turn WorkSpaces API responses into the usage report (no AWS calls)."""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from datetime import datetime, timezone, tzinfo
from typing import Any, Iterable

CSV_HEADER = [
    "UserName",
    "WorkspaceId",
    "DirectoryId",
    "State",
    "ComputeType",
    "RunningMode",
    "ConnectionState",
    "LastConnected",
    "DaysSinceLastConnection",
    "Status",
]

STATUS_ACTIVE = "ACTIVE"
STATUS_INACTIVE = "INACTIVE"
STATUS_NEVER = "NEVER_CONNECTED"


@dataclass(frozen=True)
class UsageRow:
    user_name: str
    workspace_id: str
    directory_id: str
    state: str
    compute_type: str
    running_mode: str
    connection_state: str
    last_connected: datetime | None
    days_since: int | None
    status: str


def classify(last_connected: datetime | None, now: datetime, threshold_days: int) -> tuple[int | None, str]:
    """Return (days since last connection, status)."""
    if last_connected is None:
        return None, STATUS_NEVER
    days = (now - last_connected).days
    return days, (STATUS_INACTIVE if days >= threshold_days else STATUS_ACTIVE)


def build_rows(
    workspaces: Iterable[dict[str, Any]],
    connection_status: dict[str, dict[str, Any]],
    now: datetime,
    threshold_days: int,
) -> list[UsageRow]:
    """Join DescribeWorkspaces and DescribeWorkspacesConnectionStatus by WorkspaceId.

    Rows are sorted so that the WorkSpaces needing attention come first: never connected,
    then the longest unused, then by user name.
    """
    rows: list[UsageRow] = []
    for workspace in workspaces:
        workspace_id = workspace["WorkspaceId"]
        status = connection_status.get(workspace_id, {})
        last_connected = status.get("LastKnownUserConnectionTimestamp")
        days, label = classify(last_connected, now, threshold_days)
        properties = workspace.get("WorkspaceProperties", {})
        rows.append(
            UsageRow(
                user_name=workspace.get("UserName", ""),
                workspace_id=workspace_id,
                directory_id=workspace.get("DirectoryId", ""),
                state=workspace.get("State", ""),
                compute_type=properties.get("ComputeTypeName", ""),
                running_mode=properties.get("RunningMode", ""),
                connection_state=status.get("ConnectionState", "UNKNOWN"),
                last_connected=last_connected,
                days_since=days,
                status=label,
            )
        )
    order = {STATUS_NEVER: 0, STATUS_INACTIVE: 1, STATUS_ACTIVE: 2}
    rows.sort(key=lambda row: (order[row.status], -(row.days_since or 0), row.user_name.lower()))
    return rows


def to_csv(rows: list[UsageRow], tz: tzinfo) -> str:
    """CSV with a UTF-8 BOM so that Excel opens Japanese user names correctly."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(CSV_HEADER)
    for row in rows:
        writer.writerow(
            [
                row.user_name,
                row.workspace_id,
                row.directory_id,
                row.state,
                row.compute_type,
                row.running_mode,
                row.connection_state,
                row.last_connected.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S") if row.last_connected else "",
                "" if row.days_since is None else row.days_since,
                row.status,
            ]
        )
    return "﻿" + buffer.getvalue()


def build_message(
    rows: list[UsageRow],
    now: datetime,
    tz: tzinfo,
    threshold_days: int,
    s3_uri: str,
    max_listed: int = 50,
) -> tuple[str, str]:
    """Return (subject, body) of the SNS notification."""
    counts = {label: sum(1 for row in rows if row.status == label) for label in (STATUS_ACTIVE, STATUS_INACTIVE, STATUS_NEVER)}
    local_now = now.astimezone(tz)
    subject = f"WorkSpaces usage report {local_now:%Y-%m} ({len(rows)} WorkSpaces)"
    # SNS subjects are limited to 100 ASCII characters.
    subject = subject[:100]

    lines = [
        f"WorkSpaces usage report generated at {local_now:%Y-%m-%d %H:%M %Z}",
        "",
        f"Total WorkSpaces          : {len(rows)}",
        f"Used within {threshold_days} days       : {counts[STATUS_ACTIVE]}",
        f"Not used for {threshold_days}+ days     : {counts[STATUS_INACTIVE]}",
        f"Never connected           : {counts[STATUS_NEVER]}",
        "",
        f"Full CSV: {s3_uri}",
    ]
    attention = [row for row in rows if row.status != STATUS_ACTIVE]
    if attention:
        lines += ["", "WorkSpaces needing attention (user / workspace / last connected / days):"]
        for row in attention[:max_listed]:
            last = row.last_connected.astimezone(tz).strftime("%Y-%m-%d") if row.last_connected else "never"
            days = "-" if row.days_since is None else str(row.days_since)
            lines.append(f"- {row.user_name} / {row.workspace_id} / {last} / {days}")
        if len(attention) > max_listed:
            lines.append(f"... and {len(attention) - max_listed} more (see the CSV)")
    return subject, "\n".join(lines)


def report_key(prefix: str, now: datetime, tz: tzinfo) -> str:
    local_now = now.astimezone(tz)
    return f"{prefix.rstrip('/')}/{local_now:%Y/%m}/workspaces-usage-{local_now:%Y%m%d-%H%M%S}.csv"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
