"""BuildReport Lambda: raw/YYYY-MM/*.json -> reports/YYYY-MM/ (+ reports/latest/).

Writes index.html, diagram.drawio.svg, diagram.png, report.json and finally
manifest.json; the preflight step treats manifest.json as "this month is
done", so it must be the last object written.
"""
import json
import os
from datetime import datetime, timezone

from .catalog import SEVERITY_ORDER
from .diagram import render
from .inventory import build_inventory, severity_counts
from .report_html import render_html
from .summary import summarize

USABLE = ("OK", "PARTIAL")
CONTENT_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "diagram.drawio.svg": "image/svg+xml",
    "diagram.png": "image/png",
    "report.json": "application/json",
    "manifest.json": "application/json",
}


def previous_month(month):
    y, m = (int(x) for x in month.split("-"))
    return f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"


def flatten_sources(collectors):
    """Collector outputs carry `results`; a caught collector failure is a flat {source, status, message}."""
    sources = []
    for c in collectors or []:
        if "results" in c:
            sources.extend(c.get("results") or [])
        elif c.get("source"):
            sources.append({k: c[k] for k in ("source", "status", "message") if k in c})
    return sources


def source(sources, name):
    return next((s for s in sources if s.get("source") == name), None)


def coverage_gaps(explorer_items, inv):
    """Resource types Resource Explorer lists but AWS Config has no item for."""
    gaps = {}
    for item in explorer_items:
        arn = item.get("arn", "")
        tail = arn.rsplit("/", 1)[-1].rsplit(":", 1)[-1]
        if arn in inv.by_identifier or tail in inv.by_identifier:
            continue
        rtype = item.get("cfnResourceType") or item.get("resourceType") or "unknown"
        gaps[rtype] = gaps.get(rtype, 0) + 1
    return sorted(gaps.items(), key=lambda kv: (-kv[1], kv[0]))[:30]


def cost_section(cost_raw, inv, previous_total):
    resources = []
    for region in inv.regions.values():
        resources.extend(region.resources)
        for vpc in region.vpcs.values():
            resources.extend(vpc.resources)
            for subnet in vpc.subnets.values():
                resources.extend(subnet.resources)
    resources.extend(inv.global_resources)
    top = sorted((r for r in resources if r.cost > 0.005), key=lambda r: -r.cost)[:20]
    by_service = sorted((cost_raw.get("byProduct") or {}).items(), key=lambda kv: -kv[1])[:15]
    return {
        "total": cost_raw.get("totalCost", 0.0),
        "previousTotal": previous_total,
        "unallocated": cost_raw.get("unallocatedCost", 0.0),
        "onDiagram": inv.cost_on_diagram,
        "offDiagram": inv.cost_off_diagram,
        "currency": "USD",
        "topResources": [{"name": r.name, "type": r.resource_type, "region": r.region, "cost": round(r.cost, 2)} for r in top],
        "byService": by_service,
    }


def build(event, store, bedrock=None, locale="ja", model_id="", summary_enabled=False, now=None):
    """Pure-ish core: `store` is get_json(key)/put(key, body, content_type); returns the notify payload."""
    now = now or datetime.now(timezone.utc)
    month = event["targetMonth"]
    sources = flatten_sources(event.get("collectors"))
    warnings = []

    def load(name):
        s = source(sources, name)
        if s and s.get("status") in USABLE and s.get("s3Key"):
            return store.get_json(s["s3Key"])
        return None

    config_raw = load("config")
    cost_s = source(sources, "cur")
    cost_raw = store.get_json(cost_s["s3Key"]) if cost_s and cost_s.get("status") == "OK" else None
    explorer_raw = load("resource-explorer")
    security_key = next((s["s3Key"] for s in sources if s.get("s3Key", "").endswith("/security.json")), None)
    security_raw = store.get_json(security_key) if security_key else None

    findings = []
    finding_counts = {}
    for name, data in ((security_raw or {}).get("sources") or {}).items():
        items = data.get("findings") or []
        findings.extend(items)
        finding_counts[name] = severity_counts(items)
    totals = {s: sum(c.get(s, 0) for c in finding_counts.values()) for s in SEVERITY_ORDER}

    inv = build_inventory((config_raw or {}).get("items") or [], cost_raw, findings)

    files = {}
    diagram = {"status": "SKIPPED", "message": "AWS Config is not usable in any target region"}
    if config_raw is not None:
        title = f"AWS Environment Overview — {month}"
        regions = ", ".join(sorted(inv.regions)) or "-"
        subtitle = f"Regions: {regions}. Generated {now.strftime('%Y-%m-%d %H:%M UTC')} from AWS Config" + (
            " + CUR" if cost_raw else "") + (" + security findings" if findings else "")
        svg, stats = render(inv, title, subtitle, show_cost=cost_raw is not None)
        files["diagram.drawio.svg"] = svg.encode("utf-8")
        cfg = source(sources, "config")
        diagram = {"status": cfg["status"], "nodes": stats["nodes"], "overlaps": stats["overlaps"]}
        if cfg["status"] == "PARTIAL":
            diagram["message"] = "AWS Config is not fully usable in every region; some resources may be missing"
        if stats["overlaps"]:
            warnings.append(f"diagram layout check found {stats['overlaps']} overlapping elements")
        try:
            import cairosvg  # native cairo; optional so a missing library only loses the PNG

            files["diagram.png"] = cairosvg.svg2png(bytestring=files["diagram.drawio.svg"], scale=1.2)
            diagram["png"] = True
        except Exception as e:  # noqa: BLE001
            diagram["png"] = False
            warnings.append(f"PNG rendering failed: {type(e).__name__}")
    else:
        warnings.append("AWS Config is not usable: the diagram was not built")

    previous = store.get_json(f"reports/{previous_month(month)}/manifest.json")
    previous_total = ((previous or {}).get("cost") or {}).get("total")
    cost = cost_section(cost_raw, inv, previous_total) if cost_raw else None
    if event.get("provisional") and cost:
        warnings.append("CUR is not finalized: cost figures are provisional")

    explorer_items = (explorer_raw or {}).get("items")
    gaps = coverage_gaps(explorer_items, inv) if explorer_items is not None and config_raw is not None else None

    sev_rank = {s: i for i, s in enumerate(SEVERITY_ORDER)}
    top_findings = sorted(findings, key=lambda f: sev_rank.get(f.get("severity"), 9))[:50]

    if summary_enabled and bedrock is not None:
        facts = {
            "month": month,
            "provisionalCost": bool(event.get("provisional")),
            "dataSources": [{"source": s["source"], "status": s["status"]} for s in sources],
            "cost": None if not cost else {
                "total": cost["total"], "previousTotal": cost["previousTotal"], "unallocated": cost["unallocated"],
                "byService": cost["byService"][:10],
                "topResourceTypes": [{"type": r["type"], "cost": r["cost"]} for r in cost["topResources"][:10]],
            },
            "findingCounts": finding_counts,
            "topFindings": [{"severity": f.get("severity"), "source": f.get("source"), "title": f.get("title"),
                             "resourceType": f.get("resourceType")} for f in top_findings[:20]],
            "inventoryTopTypes": list(inv.type_counts.items())[:15],
            "coverageGaps": gaps,
        }
        summary = summarize(bedrock, model_id, locale, facts)
    else:
        summary = ("DISABLED", "")

    ctx = {
        "targetMonth": month,
        "generatedAt": now.isoformat(),
        "provisional": bool(event.get("provisional")),
        "warnings": warnings,
        "sources": sources,
        "summary": summary,
        "diagram": diagram,
        "cost": cost,
        "findingCounts": finding_counts,
        "topFindings": top_findings,
        "coverageGaps": gaps,
        "typeCounts": inv.type_counts,
    }
    files["index.html"] = render_html(ctx, locale).encode("utf-8")
    files["report.json"] = json.dumps(ctx, ensure_ascii=False, default=str).encode("utf-8")

    manifest = {
        "targetMonth": month,
        "generatedAt": now.isoformat(),
        "provisional": bool(event.get("provisional")),
        "curState": event.get("curState"),
        "sources": [{k: s.get(k) for k in ("source", "status", "message", "regions", "itemCount")} for s in sources],
        "diagram": diagram,
        "summaryStatus": summary[0],
        "cost": None if not cost else {"total": cost["total"], "previousTotal": previous_total, "unallocated": cost["unallocated"]},
        "findings": totals,
        "files": sorted(list(files) + ["manifest.json"]),
    }
    files["manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")

    for prefix in (f"reports/{month}/", "reports/latest/"):
        for name in [n for n in files if n != "manifest.json"] + ["manifest.json"]:
            store.put(prefix + name, files[name], CONTENT_TYPES[name])

    return {
        "targetMonth": month,
        "provisional": bool(event.get("provisional")),
        "reportLocation": f"s3://{store.bucket}/reports/{month}/index.html",
        "sources": [{"source": s["source"], "status": s["status"], **({"message": s["message"]} if s.get("message") else {})}
                    for s in sources],
        "cost": None if not cost else {"total": cost["total"], "previousTotal": previous_total,
                                        "unallocated": cost["unallocated"], "currency": "USD"},
        "findings": totals,
        "diagram": {"status": diagram["status"], **({"message": diagram["message"]} if diagram.get("message") else {})},
        "warnings": warnings,
    }


class S3Store:
    def __init__(self, client, bucket):
        self.client = client
        self.bucket = bucket

    def get_json(self, key):
        try:
            body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.client.exceptions.NoSuchKey:
            return None
        return json.loads(body)

    def put(self, key, body, content_type):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType=content_type)


def handler(event, _context):
    import boto3

    store = S3Store(boto3.client("s3"), os.environ["BUCKET_NAME"])
    enabled = os.environ.get("SUMMARY_ENABLED") == "true"
    bedrock = boto3.client("bedrock-runtime") if enabled else None
    return build(event, store, bedrock=bedrock, locale=os.environ.get("LOCALE", "ja"),
                 model_id=os.environ.get("BEDROCK_MODEL_ID", ""), summary_enabled=enabled)
