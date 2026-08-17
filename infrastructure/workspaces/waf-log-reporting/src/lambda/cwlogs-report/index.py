"""
Daily WAF activity report -- Pattern 1: CloudWatch Logs Insights + Lambda + SNS.

Runs several CloudWatch Logs Insights queries directly against a WAF log
group for the trailing `REPORT_PERIOD_HOURS` (default 24h), builds a
human-readable digest (Block/Count breakdown, top rules/IPs/countries/URIs,
a day-over-day anomaly check), and publishes it to an SNS topic.

Environment variables:
  LOG_GROUP_NAME            - WAF CloudWatch Logs log group to analyze.
  TOPIC_ARN                 - SNS topic ARN to publish the report to.
  REPORT_PERIOD_HOURS        - Hours of log data to analyze per run (default 24).
  TOP_N                      - Number of entries per Top-N section (default 5).
  ANOMALY_THRESHOLD_PERCENT - Request-volume increase (%) that triggers an
                               anomaly warning (default 50).
  LOCALE                    - Report language: "ja" or "en" (default "ja").

Caveat: CloudWatch Logs Insights cannot unnest JSON arrays, so
`query_count_mode_rules` only inspects the first entry of each request's
`nonTerminatingMatchingRules` array. A request that matched more than one
COUNT-mode rule is attributed to its first match only. Pattern 2 (Athena,
`CROSS JOIN UNNEST`) counts every match exactly -- see the athena-report
Lambda for that version.
"""

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

logs_client = boto3.client("logs")
sns = boto3.client("sns")

LOG_GROUP_NAME = os.environ["LOG_GROUP_NAME"]
TOPIC_ARN = os.environ["TOPIC_ARN"]
REPORT_PERIOD_HOURS = int(os.environ.get("REPORT_PERIOD_HOURS", "24"))
TOP_N = int(os.environ.get("TOP_N", "5"))
ANOMALY_THRESHOLD_PERCENT = float(os.environ.get("ANOMALY_THRESHOLD_PERCENT", "50"))
LOCALE = os.environ.get("LOCALE", "ja")

QUERY_TIMEOUT_SECONDS = 60
POLL_INTERVAL_SECONDS = 2


def run_insights_query(start_time: int, end_time: int, query_string: str) -> list[dict]:
    start_resp = logs_client.start_query(
        logGroupName=LOG_GROUP_NAME,
        startTime=start_time,
        endTime=end_time,
        queryString=query_string,
        limit=10000,
    )
    query_id = start_resp["queryId"]

    deadline = time.monotonic() + QUERY_TIMEOUT_SECONDS
    result = logs_client.get_query_results(queryId=query_id)
    while result["status"] in ("Scheduled", "Running") and time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL_SECONDS)
        result = logs_client.get_query_results(queryId=query_id)

    if result["status"] != "Complete":
        if result["status"] in ("Scheduled", "Running"):
            logs_client.stop_query(queryId=query_id)
        raise RuntimeError(f"Logs Insights query did not complete (status={result['status']}): {query_string}")

    return [{field["field"]: field["value"] for field in record} for record in result["results"]]


def query_action_breakdown(start_time: int, end_time: int) -> dict[str, int]:
    rows = run_insights_query(start_time, end_time, "stats count(*) as cnt by action | sort cnt desc")
    return {row["action"]: int(row["cnt"]) for row in rows}


def query_top_blocked(field: str, start_time: int, end_time: int) -> list[tuple[str, int]]:
    query = f'filter action = "BLOCK" | stats count(*) as cnt by {field} | sort cnt desc | limit {TOP_N}'
    rows = run_insights_query(start_time, end_time, query)
    return [(row.get(field, "-"), int(row["cnt"])) for row in rows]


def query_count_mode_rules(start_time: int, end_time: int) -> list[tuple[str, int]]:
    field = "nonTerminatingMatchingRules.0.ruleId"
    query = (
        f"filter ispresent({field}) "
        f"| stats count(*) as cnt by {field} "
        f"| sort cnt desc | limit {TOP_N}"
    )
    rows = run_insights_query(start_time, end_time, query)
    return [(row.get(field, "-"), int(row["cnt"])) for row in rows]


def to_epoch_millis(dt: datetime) -> int:
    return int(dt.timestamp())


def build_report(now: datetime) -> dict:
    period_end = now
    period_start = now - timedelta(hours=REPORT_PERIOD_HOURS)
    prev_period_end = period_start
    prev_period_start = prev_period_end - timedelta(hours=REPORT_PERIOD_HOURS)

    start_time, end_time = to_epoch_millis(period_start), to_epoch_millis(period_end)
    prev_start_time, prev_end_time = to_epoch_millis(prev_period_start), to_epoch_millis(prev_period_end)

    action_breakdown = query_action_breakdown(start_time, end_time)
    prev_action_breakdown = query_action_breakdown(prev_start_time, prev_end_time)

    total = sum(action_breakdown.values())
    prev_total = sum(prev_action_breakdown.values())
    block_total = action_breakdown.get("BLOCK", 0)

    top_blocked_rules = query_top_blocked("terminatingRuleId", start_time, end_time) if block_total else []
    top_blocked_ips = query_top_blocked("httpRequest.clientIp", start_time, end_time) if block_total else []
    top_blocked_countries = query_top_blocked("httpRequest.country", start_time, end_time) if block_total else []
    top_blocked_uris = query_top_blocked("httpRequest.uri", start_time, end_time) if block_total else []
    top_count_mode_rules = query_count_mode_rules(start_time, end_time)

    change_percent = None
    if prev_total > 0:
        change_percent = round((total - prev_total) / prev_total * 100, 1)

    return {
        "period_start": period_start,
        "period_end": period_end,
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
    count_hits = sum(c for _, c in report["top_count_mode_rules"])
    is_anomaly = report["change_percent"] is not None and report["change_percent"] >= ANOMALY_THRESHOLD_PERCENT
    anomaly_emoji = "\U0001F6A8 " if is_anomaly else ""

    if LOCALE == "en":
        title = f"{anomaly_emoji}WAF Daily Report (CloudWatch Logs Insights) -- {LOG_GROUP_NAME}"
        lines = [
            f"Period: {report['period_start'].isoformat()} - {report['period_end'].isoformat()}",
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
            lines.append(f"vs previous {REPORT_PERIOD_HOURS}h: {arrow} {report['change_percent']}%{warn}")
        lines += [
            "",
            f"== Top {TOP_N} Blocked Rules ==" if block_total else "== No BLOCK actions in this period ==",
        ]
        if block_total:
            lines.append(format_top_list(report["top_blocked_rules"], block_total))
            lines += ["", f"== Top {TOP_N} Blocked Source IPs =="]
            lines.append(format_top_list(report["top_blocked_ips"], block_total))
            lines += ["", f"== Top {TOP_N} Blocked Countries =="]
            lines.append(format_top_list(report["top_blocked_countries"], block_total))
            lines += ["", f"== Top {TOP_N} Blocked Request URIs =="]
            lines.append(format_top_list(report["top_blocked_uris"], block_total))
        lines += [
            "",
            f"== Top {TOP_N} COUNT-mode Rule Matches (promotion candidates) ==",
        ]
        if report["top_count_mode_rules"]:
            lines.append(format_top_list(report["top_count_mode_rules"], total))
            lines.append(
                "  Note: counts only the first COUNT-mode match per request "
                "(Logs Insights cannot unnest arrays); see the Athena report for exact counts."
            )
        else:
            lines.append("  (no COUNT-mode rule matched in this period)")
        lines += [
            "",
            f"Report engine: CloudWatch Logs Insights | Log group: {LOG_GROUP_NAME}",
        ]
        subject = f"[WAF Report] {'ANOMALY ' if is_anomaly else ''}{total} requests / {block_total} blocked"
    else:
        title = f"{anomaly_emoji}WAF日次レポート (CloudWatch Logs Insights) -- {LOG_GROUP_NAME}"
        lines = [
            f"集計期間: {report['period_start'].isoformat()} 〜 {report['period_end'].isoformat()}",
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
            lines.append(f"前日比({REPORT_PERIOD_HOURS}時間比): {arrow} {report['change_percent']}%{warn}")
        lines += [
            "",
            f"■ ブロックルール Top{TOP_N}" if block_total else "■ このレポート期間にBLOCKは発生していません",
        ]
        if block_total:
            lines.append(format_top_list(report["top_blocked_rules"], block_total))
            lines += ["", f"■ ブロック送信元IP Top{TOP_N}"]
            lines.append(format_top_list(report["top_blocked_ips"], block_total))
            lines += ["", f"■ ブロック国 Top{TOP_N}"]
            lines.append(format_top_list(report["top_blocked_countries"], block_total))
            lines += ["", f"■ ブロックURI Top{TOP_N}"]
            lines.append(format_top_list(report["top_blocked_uris"], block_total))
        lines += [
            "",
            f"■ Countモード ヒットルール Top{TOP_N} (Block昇格候補)",
        ]
        if report["top_count_mode_rules"]:
            lines.append(format_top_list(report["top_count_mode_rules"], total))
            lines.append(
                "  ※ Logs Insightsは配列を展開できないため、リクエストごとに先頭マッチのみ集計しています。"
                "正確な件数はAthenaレポートを参照してください。"
            )
        else:
            lines.append("  (この期間にCountモードルールのマッチはありません)")
        lines += [
            "",
            f"レポート方式: CloudWatch Logs Insights | ロググループ: {LOG_GROUP_NAME}",
        ]
        subject = f"[WAFレポート] {'異常検知 ' if is_anomaly else ''}総数{total}件 / Block {block_total}件"

    body = title + "\n\n" + "\n".join(lines)
    return subject[:100], body


def lambda_handler(event, context):
    now = datetime.now(timezone.utc)
    report = build_report(now)
    subject, body = build_report_text(report)

    logger.info(json.dumps({"total": report["total"], "changePercent": report["change_percent"]}))

    response = sns.publish(TopicArn=TOPIC_ARN, Subject=subject, Message=body)
    logger.info(f"Published report to SNS, MessageId={response['MessageId']}")
    return {"published": True, "messageId": response["MessageId"], "total": report["total"]}
