import html
import json
import re
import xml.etree.ElementTree as ET

from app.catalog import CATALOG
from app.diagram import GROUP_GLYPHS, GROUP_STYLES, ICONS, Box, Leaf, build_tree, find_overlaps, render
from app.handler import build, previous_month
from app.inventory import build_inventory
from app.summary import mask

from . import fixtures as fx


def inventory():
    return build_inventory(fx.config_items(), fx.cost_raw(), fx.findings())


def all_resources(inv):
    out = list(inv.global_resources)
    for region in inv.regions.values():
        out += region.resources
        for vpc in region.vpcs.values():
            out += vpc.resources
            for s in vpc.subnets.values():
                out += s.resources
    return {r.resource_id: r for r in out}


def test_placement_follows_configuration():
    inv = inventory()
    vpc = inv.regions[fx.R].vpcs["vpc-0aaa"]
    assert vpc.subnets["subnet-pub-a"].public is True
    assert vpc.subnets["subnet-pri-a"].public is False  # main table routes to NAT, not IGW
    assert [r.resource_id for r in vpc.subnets["subnet-pri-a"].resources] == ["i-0123456789abcdef0"]
    assert "nat-0aaa" in [r.resource_id for r in vpc.subnets["subnet-pub-a"].resources]
    vpc_wide = {r.resource_id for r in vpc.resources}
    assert any(rid.endswith("loadbalancer/app/web/1") for rid in vpc_wide)  # spans two subnets
    assert "db-XYZ" in vpc_wide and "igw-0aaa" in vpc_wide
    assert {r.resource_id for r in inv.global_resources} == {"E123", "Z123"}
    assert "logs-bucket" in {r.resource_id for r in inv.regions["us-east-1"].resources}


def test_cost_matching_and_rollup():
    inv = inventory()
    res = all_resources(inv)
    assert res["i-0123456789abcdef0"].cost == 220.0  # instance + its attached volume
    assert res["nat-0aaa"].cost == 45.0  # ARN in CUR, bare ID in Config
    assert res["logs-bucket"].cost == 40.0
    assert inv.cost_on_diagram == 690.0
    assert inv.cost_off_diagram == 210.0


def test_findings_are_attached_to_resources():
    inv = inventory()
    res = all_resources(inv)
    assert res["i-0123456789abcdef0"].findings == {"MEDIUM": 1, "CRITICAL": 1}
    assert res["logs-bucket"].findings == {"HIGH": 1}
    assert inv.findings_placed == 3


def test_aggregation_and_empty_vpc():
    inv = inventory()
    root, empty = build_tree(inv)
    leaves = [n for n in root.walk() if isinstance(n, Leaf)]
    lambdas = [l for l in leaves if l.resource_type == "AWS::Lambda::Function"]
    assert len(lambdas) == 1 and lambdas[0].count == 6 and lambdas[0].cost == 60.0
    assert empty == [f"{fx.R}/vpc-0def"]


def test_layout_has_no_overlaps():
    inv = inventory()
    root, _ = build_tree(inv)
    root.measure()
    root.place(30, 84)
    assert find_overlaps(root) == []


def test_overlap_check_detects_overlap():
    box = Box("lane", "t", [Leaf("AWS::S3::Bucket", "a", [], 0, {}), Leaf("AWS::S3::Bucket", "b", [], 0, {})])
    box.measure()
    box.place(0, 0)
    box.children[1].place(box.children[0].x + 10, box.children[0].y)
    assert find_overlaps(box)


def test_svg_is_valid_and_editable():
    svg, stats = render(inventory(), "Title", "Sub")
    ET.fromstring(svg)
    m = re.search(r'content="(.*?)" xmlns:xlink', svg, re.S)
    root = ET.fromstring(html.unescape(m.group(1)))
    diagram = root.find("diagram")
    assert (diagram.text or "").strip() == ""
    assert diagram.find("mxGraphModel") is not None
    assert stats["overlaps"] == 0
    assert "<script>" not in svg  # resource names are escaped
    assert "resIcon=mxgraph.aws4.ec2" in html.unescape(m.group(1))


def test_every_drawn_type_and_group_badge_has_a_static_icon():
    # A missing entry falls back to a colored square with a short code.
    assert {spec.icon for spec in CATALOG.values()} - set(ICONS) == set()
    assert set(GROUP_GLYPHS.values()) - set(ICONS) == set()


def test_subnet_groups_use_draw_io_icon_names():
    # draw.io has no group_public_subnet / group_private_subnet stencil.
    for kind in ("public", "private"):
        assert "grIcon=mxgraph.aws4.group_security_group;" in GROUP_STYLES[kind]


def test_svg_without_cost_data_has_no_cost_labels():
    # Container titles only: per-icon cost labels are already hidden when the cost is zero.
    svg, _ = render(inventory(), "Title", "Sub", show_cost=False)
    assert "— $" not in svg
    assert "Top 10% cost" not in svg
    with_cost, _ = render(inventory(), "Title", "Sub")
    assert "— $" in with_cost


def test_build_writes_manifest_last_and_summary_payload():
    store = fx.MemoryStore({
        "raw/2026-09/config.json": {"items": fx.config_items()},
        "raw/2026-09/cost.json": fx.cost_raw(),
        "raw/2026-09/security.json": {"sources": {"inspector": {"findings": fx.findings()}}},
        "reports/2026-08/manifest.json": {"cost": {"total": 800.0}},
    })
    event = {
        "targetMonth": "2026-09",
        "provisional": True,
        "collectors": [
            {"collector": "config", "results": [{"source": "config", "status": "OK", "s3Key": "raw/2026-09/config.json"}]},
            {"collector": "cost", "results": [{"source": "cur", "status": "OK", "s3Key": "raw/2026-09/cost.json"}]},
            {"collector": "resource-explorer", "source": "resource-explorer", "status": "ERROR", "message": "States.TaskFailed"},
            {"collector": "security", "results": [{"source": "inspector", "status": "OK", "s3Key": "raw/2026-09/security.json"}]},
        ],
    }
    out = build(event, store, locale="ja")
    month_keys = [k for k in store.order if k.startswith("reports/2026-09/")]
    assert month_keys[-1] == "reports/2026-09/manifest.json"
    assert "reports/latest/manifest.json" in store.order
    assert out["cost"]["previousTotal"] == 800.0
    assert out["findings"]["CRITICAL"] == 1
    assert any("provisional" in w for w in out["warnings"])
    page = store.objects["reports/2026-09/index.html"].decode()
    assert "<script>" not in page
    manifest = json.loads(store.objects["reports/2026-09/manifest.json"])
    assert manifest["diagram"]["status"] == "OK"
    assert {"source": "resource-explorer", "status": "ERROR", "message": "States.TaskFailed"} in out["sources"]


def test_build_without_config_skips_diagram():
    store = fx.MemoryStore()
    event = {"targetMonth": "2026-01", "collectors": [
        {"collector": "config", "results": [{"source": "config", "status": "DISABLED"}]}]}
    out = build(event, store, locale="en")
    assert out["diagram"]["status"] == "SKIPPED"
    assert "reports/2026-01/diagram.drawio.svg" not in store.objects


def test_previous_month_and_mask():
    assert previous_month("2026-01") == "2025-12"
    assert previous_month("2026-10") == "2026-09"
    assert mask('{"a":"arn:aws:iam::111122223333:role/x","b":"111122223333"}') == '{"a":"<arn>","b":"<account>"}'
