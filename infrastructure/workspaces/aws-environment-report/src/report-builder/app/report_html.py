"""The report page (index.html). Self-contained apart from the diagram files
next to it, so the reports/ prefix works as a static site as-is.

Every value that comes from the account (names, tags, finding titles) is
HTML-escaped: resource names are user-controlled input.
"""
import html

from .catalog import SEVERITY_ORDER

TEXT = {
    "ja": {
        "title": "AWS環境レポート",
        "provisional": "CURが未確定のため、コストは暫定値です。",
        "sources": "データソースの状態",
        "source": "ソース", "status": "状態", "detail": "詳細",
        "summary": "要約（Bedrock）",
        "summary_off": "要約は無効です。",
        "summary_failed": "要約の生成に失敗しました",
        "diagram": "構成図",
        "diagram_links": "draw.ioで編集（SVG） / PNG",
        "diagram_skipped": "構成図は作成していません",
        "cost": "コスト",
        "total": "合計", "previous": "前月", "unallocated": "リソースに割り当てられないコスト",
        "on_diagram": "構成図上のリソースに割り当て", "off_diagram": "構成図に描いていないリソース",
        "top_resources": "コスト上位のリソース", "by_service": "サービス別", "service": "サービス",
        "name": "名前", "type": "タイプ", "region": "リージョン", "amount": "金額",
        "security": "セキュリティ", "top_findings": "主な指摘（重要度順、最大50件）",
        "severity": "重要度", "finding": "指摘", "resource": "リソース",
        "coverage": "網羅性（Resource Explorer にあり AWS Config にないリソース）",
        "coverage_none": "差分はありません。",
        "inventory": "インベントリ（AWS Config 記録件数）", "count": "件数",
        "not_available": "取得できていません",
        "cost_basis": "CUR 2.0 の unblended cost。Savings Plans / RI の償却は反映していません。",
    },
    "en": {
        "title": "AWS Environment Report",
        "provisional": "CUR is not finalized yet: cost figures are provisional.",
        "sources": "Data sources",
        "source": "Source", "status": "Status", "detail": "Detail",
        "summary": "Summary (Bedrock)",
        "summary_off": "Summary is disabled.",
        "summary_failed": "Summary generation failed",
        "diagram": "Diagram",
        "diagram_links": "Edit in draw.io (SVG) / PNG",
        "diagram_skipped": "No diagram was built",
        "cost": "Cost",
        "total": "Total", "previous": "Previous month", "unallocated": "Not attributable to a resource",
        "on_diagram": "On drawn resources", "off_diagram": "On resources not drawn",
        "top_resources": "Top resources by cost", "by_service": "By service", "service": "Service",
        "name": "Name", "type": "Type", "region": "Region", "amount": "Amount",
        "security": "Security", "top_findings": "Top findings (by severity, max 50)",
        "severity": "Severity", "finding": "Finding", "resource": "Resource",
        "coverage": "Coverage (in Resource Explorer, not in AWS Config)",
        "coverage_none": "No gaps.",
        "inventory": "Inventory (AWS Config item counts)", "count": "Count",
        "not_available": "not available",
        "cost_basis": "CUR 2.0 unblended cost. Savings Plans / RI amortization is not applied.",
    },
}

STATUS_COLOR = {"OK": "#1D8102", "PARTIAL": "#B7791F", "DISABLED": "#5A6472", "DENIED": "#D13212", "ERROR": "#D13212"}
SEVERITY_COLOR = {"CRITICAL": "#7D1A0F", "HIGH": "#D13212", "MEDIUM": "#F89256", "LOW": "#879196", "INFORMATIONAL": "#AAB7B8"}


def e(v):
    return html.escape(str(v), quote=True)


def money(n):
    return f"${n:,.2f}"


def table(headers, rows):
    head = "".join(f"<th>{e(h)}</th>" for h in headers)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows)
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def status_chip(status):
    return f'<span class="chip" style="background:{STATUS_COLOR.get(status, "#5A6472")}">{e(status)}</span>'


def render_html(ctx, locale):
    t = TEXT.get(locale, TEXT["en"])
    out = []
    out.append(f"<h1>{e(t['title'])} — {e(ctx['targetMonth'])}</h1>")
    out.append(f"<p class=\"muted\">{e(ctx['generatedAt'])}</p>")
    if ctx["provisional"]:
        out.append(f"<p class=\"warn\">{e(t['provisional'])}</p>")
    for w in ctx["warnings"]:
        out.append(f"<p class=\"warn\">{e(w)}</p>")

    # Data sources
    rows = []
    for s in ctx["sources"]:
        detail = ", ".join(f"{r['region']}={r['status']}" for r in s.get("regions") or [])
        if s.get("message"):
            detail = f"{detail} {s['message']}".strip()
        rows.append([e(s["source"]), status_chip(s["status"]), e(detail)])
    out.append(f"<h2>{e(t['sources'])}</h2>" + table([t["source"], t["status"], t["detail"]], rows))

    # Summary
    out.append(f"<h2>{e(t['summary'])}</h2>")
    status, text = ctx["summary"]
    if status == "OK":
        out.append(f"<pre class=\"summary\">{e(text)}</pre>")
    elif status == "DISABLED":
        out.append(f"<p class=\"muted\">{e(t['summary_off'])}</p>")
    else:
        out.append(f"<p class=\"warn\">{e(t['summary_failed'])}: {e(text)}</p>")

    # Diagram
    out.append(f"<h2>{e(t['diagram'])}</h2>")
    diagram = ctx["diagram"]
    if diagram["status"] in ("OK", "PARTIAL"):
        png = ' / <a href="diagram.png">PNG</a>' if diagram.get("png") else ""
        out.append(f'<p><a href="diagram.drawio.svg">{e(t["diagram_links"].split(" / ")[0])}</a>{png}</p>')
        out.append('<div class="diagram"><img src="diagram.drawio.svg" alt="diagram"></div>')
        if diagram.get("message"):
            out.append(f"<p class=\"muted\">{e(diagram['message'])}</p>")
    else:
        out.append(f"<p class=\"warn\">{e(t['diagram_skipped'])}: {e(diagram.get('message', ''))}</p>")

    # Cost
    out.append(f"<h2>{e(t['cost'])}</h2>")
    cost = ctx.get("cost")
    if cost:
        prev = cost.get("previousTotal")
        out.append(table(
            [t["total"], t["previous"], t["on_diagram"], t["off_diagram"], t["unallocated"]],
            [[money(cost["total"]), money(prev) if prev is not None else "-", money(cost["onDiagram"]),
              money(cost["offDiagram"]), money(cost["unallocated"])]],
        ))
        out.append(f"<p class=\"muted\">{e(t['cost_basis'])}</p>")
        out.append(f"<h3>{e(t['top_resources'])}</h3>" + table(
            [t["name"], t["type"], t["region"], t["amount"]],
            [[e(r["name"]), e(r["type"]), e(r["region"]), money(r["cost"])] for r in cost["topResources"]],
        ))
        out.append(f"<h3>{e(t['by_service'])}</h3>" + table(
            [t["service"], t["amount"]], [[e(k), money(v)] for k, v in cost["byService"]],
        ))
    else:
        out.append(f"<p class=\"muted\">{e(t['not_available'])}</p>")

    # Security
    out.append(f"<h2>{e(t['security'])}</h2>")
    counts = ctx["findingCounts"]
    rows = [[e(src)] + [str(c.get(s, 0)) for s in SEVERITY_ORDER] for src, c in counts.items()]
    out.append(table([t["source"]] + SEVERITY_ORDER, rows))
    out.append(f"<h3>{e(t['top_findings'])}</h3>")
    rows = []
    for f in ctx["topFindings"]:
        sev = f.get("severity", "INFORMATIONAL")
        rows.append([
            f'<span class="chip" style="background:{SEVERITY_COLOR.get(sev, "#879196")}">{e(sev)}</span>',
            e(f.get("source", "")), e(f.get("region", "")), e(f.get("title", "")),
            e(", ".join(f.get("resourceIds") or [])[:200]),
        ])
    out.append(table([t["severity"], t["source"], t["region"], t["finding"], t["resource"]], rows))

    # Coverage
    out.append(f"<h2>{e(t['coverage'])}</h2>")
    gaps = ctx.get("coverageGaps")
    if gaps is None:
        out.append(f"<p class=\"muted\">{e(t['not_available'])}</p>")
    elif not gaps:
        out.append(f"<p>{e(t['coverage_none'])}</p>")
    else:
        out.append(table([t["type"], t["count"]], [[e(k), str(v)] for k, v in gaps]))

    # Inventory
    out.append(f"<h2>{e(t['inventory'])}</h2>")
    out.append(table([t["type"], t["count"]], [[e(k), str(v)] for k, v in ctx["typeCounts"].items()]))

    return f"""<!doctype html>
<html lang="{e(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(t['title'])} {e(ctx['targetMonth'])}</title>
<style>
body{{font-family:-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;margin:0 auto;max-width:1200px;padding:16px;color:#16191F;background:#fff}}
h1{{font-size:24px;border-bottom:3px solid #E7157B;padding-bottom:6px}} h2{{font-size:19px;margin-top:32px}} h3{{font-size:15px}}
table{{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px;display:block;overflow-x:auto}}
th,td{{border:1px solid #D5DBDB;padding:4px 8px;text-align:left;vertical-align:top}} th{{background:#F2F3F3}}
.chip{{color:#fff;border-radius:10px;padding:1px 8px;font-size:12px;white-space:nowrap}}
.muted{{color:#5A6472;font-size:13px}} .warn{{color:#B7791F;font-weight:600}}
.summary{{white-space:pre-wrap;background:#F7F8F8;padding:12px;border-radius:6px;font-family:inherit}}
.diagram{{overflow:auto;border:1px solid #D5DBDB}} .diagram img{{max-width:none}}
</style></head><body>
{chr(10).join(out)}
</body></html>"""
