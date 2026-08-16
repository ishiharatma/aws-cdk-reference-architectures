"""
Daily WAF activity report -- Pattern 2: Amazon Athena + Lambda + SNS.

Runs several Athena SQL queries against a Glue table over WAF logs in S3 for
the previous full day, builds a human-readable digest (Block/Count
breakdown, top rules/IPs/countries/URIs, a day-over-day anomaly check), and
publishes it to an SNS topic.

Unlike the CloudWatch Logs Insights version (see the cwlogs-report Lambda),
`query_count_mode_rules` here uses `CROSS JOIN UNNEST` to count every
COUNT-mode rule match per request exactly, including requests that matched
more than one COUNT-mode rule.

Environment variables:
  ATHENA_DATABASE           - Glue database name.
  ATHENA_TABLE               - Glue table name (WAF logs).
  ATHENA_WORKGROUP           - Athena workgroup to run queries in.
  PARTITION_SCHEME           - "hive" (year/month/day string columns, the
                                Firehose sample layout) or "native" (a
                                single `day` date column, the AWS-WAF-native
                                S3 logging layout).
  TOPIC_ARN                  - SNS topic ARN to publish the report to.
  TOP_N                      - Number of entries per Top-N section (default 5).
  ANOMALY_THRESHOLD_PERCENT - Request-volume increase (%) that triggers an
                               anomaly warning (default 50).
  LOCALE                    - Report language: "ja" or "en" (default "ja").
"""

import json
import logging
import os
import time
from datetime import date, datetime, timedelta, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

athena = boto3.client("athena")
sns = boto3.client("sns")

DATABASE = os.environ["ATHENA_DATABASE"]
TABLE = os.environ["ATHENA_TABLE"]
WORKGROUP = os.environ["ATHENA_WORKGROUP"]
PARTITION_SCHEME = os.environ.get("PARTITION_SCHEME", "hive")
TOPIC_ARN = os.environ["TOPIC_ARN"]
TOP_N = int(os.environ.get("TOP_N", "5"))
ANOMALY_THRESHOLD_PERCENT = float(os.environ.get("ANOMALY_THRESHOLD_PERCENT", "50"))
LOCALE = os.environ.get("LOCALE", "ja")

QUERY_TIMEOUT_SECONDS = 120
POLL_INTERVAL_SECONDS = 2

TABLE_FQN = f'"{DATABASE}"."{TABLE}"'


def run_athena_query(sql: str) -> list[dict]:
    start = athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={"Database": DATABASE},
        WorkGroup=WORKGROUP,
    )
    query_execution_id = start["QueryExecutionId"]

    deadline = time.monotonic() + QUERY_TIMEOUT_SECONDS
    state = "QUEUED"
    status = {}
    while state in ("QUEUED", "RUNNING") and time.monotonic() < deadline:
        execution = athena.get_query_execution(QueryExecutionId=query_execution_id)
        status = execution["QueryExecution"]["Status"]
        state = status["State"]
        if state in ("QUEUED", "RUNNING"):
            time.sleep(POLL_INTERVAL_SECONDS)

    if state != "SUCCEEDED":
        if state in ("QUEUED", "RUNNING"):
            athena.stop_query_execution(QueryExecutionId=query_execution_id)
        reason = status.get("StateChangeReason", "unknown reason")
        raise RuntimeError(f"Athena query did not succeed (state={state}, reason={reason}): {sql}")

    rows: list[dict] = []
    columns: list[str] | None = None
    paginator = athena.get_paginator("get_query_results")
    for page in paginator.paginate(QueryExecutionId=query_execution_id):
        result_rows = page["ResultSet"]["Rows"]
        if columns is None:
            columns = [c.get("VarCharValue", "") for c in result_rows[0]["Data"]]
            result_rows = result_rows[1:]
        for row in result_rows:
            values = [cell.get("VarCharValue") for cell in row["Data"]]
            rows.append(dict(zip(columns, values)))
    return rows


def partition_where(target_date: date) -> str:
    if PARTITION_SCHEME == "native":
        return f"day = DATE '{target_date.isoformat()}'"
    return f"year = '{target_date.year:04d}' AND month = '{target_date.month:02d}' AND day = '{target_date.day:02d}'"


def query_action_breakdown(target_date: date) -> dict[str, int]:
    sql = f"SELECT action, COUNT(*) AS cnt FROM {TABLE_FQN} WHERE {partition_where(target_date)} GROUP BY action"
    return {row["action"]: int(row["cnt"]) for row in run_athena_query(sql)}


def query_top_blocked(field: str, alias: str, target_date: date) -> list[tuple[str, int]]:
    sql = (
        f"SELECT {field} AS {alias}, COUNT(*) AS cnt FROM {TABLE_FQN} "
        f"WHERE {partition_where(target_date)} AND action = 'BLOCK' "
        f"GROUP BY {field} ORDER BY cnt DESC LIMIT {TOP_N}"
    )
    return [(row[alias] or "-", int(row["cnt"])) for row in run_athena_query(sql)]


def query_count_mode_rules(target_date: date) -> list[tuple[str, int]]:
    sql = (
        f"SELECT rule.ruleid AS rule_id, COUNT(*) AS cnt FROM {TABLE_FQN} "
        f"CROSS JOIN UNNEST(nonterminatingmatchingrules) AS t(rule) "
        f"WHERE {partition_where(target_date)} AND rule.action = 'COUNT' "
        f"GROUP BY rule.ruleid ORDER BY cnt DESC LIMIT {TOP_N}"
    )
    return [(row["rule_id"] or "-", int(row["cnt"])) for row in run_athena_query(sql)]


def build_report(target_date: date, prev_date: date) -> dict:
    action_breakdown = query_action_breakdown(target_date)
    prev_action_breakdown = query_action_breakdown(prev_date)

    total = sum(action_breakdown.values())
    prev_total = sum(prev_action_breakdown.values())
    block_total = action_breakdown.get("BLOCK", 0)

    top_blocked_rules = query_top_blocked("terminatingruleid", "rule_id", target_date) if block_total else []
    top_blocked_ips = query_top_blocked("httprequest.clientip", "client_ip", target_date) if block_total else []
    top_blocked_countries = query_top_blocked("httprequest.country", "country", target_date) if block_total else []
    top_blocked_uris = query_top_blocked("httprequest.uri", "uri", target_date) if block_total else []
    top_count_mode_rules = query_count_mode_rules(target_date)

    change_percent = round((total - prev_total) / prev_total * 100, 1) if prev_total else None

    return {
        "target_date": target_date,
        "total": total,
        "prev_total": prev_total,
        "change_percent": change_percent,
        "action_breakdown": action_breakdown,
        "top_blocked_rules": top_blocked_rules,
        "top_blocked_ips": top_blocked_ips,
        "top_blocked_countries": top_blocked_countries,
        "top_blocked_uris": top_blocked_uris,
        "top_count_mode_rules": top_count_mode_rules,
    }


def format_top_list(entries: list[tuple[str, int]], total: int) -> str:
    if not entries:
        return "  (none)"
    lines = []
    for name, count in entries:
        pct = f"{count / total * 100:.1f}%" if total else "-"
        lines.append(f"  - {name}: {count} ({pct})")
    return "\n".join(lines)


def build_report_text(report: dict) -> tuple[str, str]:
    total = report["total"]
    block_total = report["action_breakdown"].get("BLOCK", 0)
    is_anomaly = report["change_percent"] is not None and report["change_percent"] >= ANOMALY_THRESHOLD_PERCENT
    anomaly_emoji = "\U0001F6A8 " if is_anomaly else ""
    target_date = report["target_date"]

    if LOCALE == "en":
        title = f"{anomaly_emoji}WAF Daily Report (Athena) -- {target_date.isoformat()}"
        lines = [
            f"Date: {target_date.isoformat()}",
            "",
            "== Summary ==",
            f"Total requests evaluated: {total}",
        ]
        for action, count in sorted(report["action_breakdown"].items(), key=lambda kv: -kv[1]):
            pct = f"{count / total * 100:.1f}%" if total else "-"
            lines.append(f"  - {action}: {count} ({pct})")
        if report["change_percent"] is not None:
            arrow = "UP" if report["change_percent"] >= 0 else "DOWN"
            warn = " -- ANOMALY THRESHOLD EXCEEDED" if is_anomaly else ""
            lines.append(f"vs previous day: {arrow} {report['change_percent']}%{warn}")
        lines += ["", f"== Top {TOP_N} Blocked Rules ==" if block_total else "== No BLOCK actions on this day =="]
        if block_total:
            lines.append(format_top_list(report["top_blocked_rules"], block_total))
            lines += ["", f"== Top {TOP_N} Blocked Source IPs =="]
            lines.append(format_top_list(report["top_blocked_ips"], block_total))
            lines += ["", f"== Top {TOP_N} Blocked Countries =="]
            lines.append(format_top_list(report["top_blocked_countries"], block_total))
            lines += ["", f"== Top {TOP_N} Blocked Request URIs =="]
            lines.append(format_top_list(report["top_blocked_uris"], block_total))
        lines += ["", f"== Top {TOP_N} COUNT-mode Rule Matches (promotion candidates) =="]
        lines.append(
            format_top_list(report["top_count_mode_rules"], total)
            if report["top_count_mode_rules"]
            else "  (no COUNT-mode rule matched on this day)"
        )
        lines += ["", f"Report engine: Amazon Athena (exact UNNEST count) | Table: {TABLE_FQN}"]
        subject = f"[WAF Report] {'ANOMALY ' if is_anomaly else ''}{total} requests / {block_total} blocked"
    else:
        title = f"{anomaly_emoji}WAF日次レポート (Athena) -- {target_date.isoformat()}"
        lines = [
            f"対象日: {target_date.isoformat()}",
            "",
            "■ サマリー",
            f"総リクエスト数: {total}",
        ]
        for action, count in sorted(report["action_breakdown"].items(), key=lambda kv: -kv[1]):
            pct = f"{count / total * 100:.1f}%" if total else "-"
            lines.append(f"  - {action}: {count}件 ({pct})")
        if report["change_percent"] is not None:
            arrow = "増加" if report["change_percent"] >= 0 else "減少"
            warn = " ※閾値超過" if is_anomaly else ""
            lines.append(f"前日比: {arrow} {report['change_percent']}%{warn}")
        lines += ["", f"■ ブロックルール Top{TOP_N}" if block_total else "■ この日にBLOCKは発生していません"]
        if block_total:
            lines.append(format_top_list(report["top_blocked_rules"], block_total))
            lines += ["", f"■ ブロック送信元IP Top{TOP_N}"]
            lines.append(format_top_list(report["top_blocked_ips"], block_total))
            lines += ["", f"■ ブロック国 Top{TOP_N}"]
            lines.append(format_top_list(report["top_blocked_countries"], block_total))
            lines += ["", f"■ ブロックURI Top{TOP_N}"]
            lines.append(format_top_list(report["top_blocked_uris"], block_total))
        lines += ["", f"■ Countモード ヒットルール Top{TOP_N} (Block昇格候補、リクエストごとの全マッチを正確に集計)"]
        lines.append(
            format_top_list(report["top_count_mode_rules"], total)
            if report["top_count_mode_rules"]
            else "  (この日にCountモードルールのマッチはありません)"
        )
        lines += ["", f"レポート方式: Amazon Athena (UNNESTによる正確集計) | テーブル: {TABLE_FQN}"]
        subject = f"[WAFレポート] {'異常検知 ' if is_anomaly else ''}総数{total}件 / Block {block_total}件"

    body = title + "\n\n" + "\n".join(lines)
    return subject[:100], body


def lambda_handler(event, context):
    now = datetime.now(timezone.utc)
    target_date = (now - timedelta(days=1)).date()
    prev_date = target_date - timedelta(days=1)

    report = build_report(target_date, prev_date)
    subject, body = build_report_text(report)

    logger.info(json.dumps({"targetDate": target_date.isoformat(), "total": report["total"]}))

    response = sns.publish(TopicArn=TOPIC_ARN, Subject=subject, Message=body)
    logger.info(f"Published report to SNS, MessageId={response['MessageId']}")
    return {"published": True, "messageId": response["MessageId"], "total": report["total"]}
