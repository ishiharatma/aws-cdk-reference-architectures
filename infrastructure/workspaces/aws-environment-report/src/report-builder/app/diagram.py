"""Draws the inventory as one draw.io-editable SVG (same format as the
aws-icon-diagram skill: a static SVG preview plus an uncompressed mxGraphModel
in the `content` attribute).

Unlike the skill, nothing is positioned by hand: every container measures its
children and stacks them (grid / row / column), so nodes cannot overlap by
construction; `find_overlaps` re-checks that on the result.
"""
import html
import json
import os
from dataclasses import dataclass, field

from .catalog import CATALOG, SEVERITY_ORDER

ASSETS = os.path.join(os.path.dirname(__file__), "assets")
with open(os.path.join(ASSETS, "icons.json"), encoding="utf-8") as fh:
    ICONS = json.load(fh)
with open(os.path.join(ASSETS, "aws_cloud_badge.json"), encoding="utf-8") as fh:
    AWS_CLOUD_BADGE = json.load(fh)

ICON = 48
CELL_W = 150
CELL_H = 118
GAP = 14
PAD = 18
TITLE_H = 36
AGG_THRESHOLD = 4  # more than this many of one type in one container -> one "×N" node
GRID_COLS = 3
WIDE_GRID_COLS = 7
NAME_MAX = 22

TIER_STYLE = {
    "high": ("#FDE2E1", "#D13212"),
    "mid": ("#FFF1D6", "#F89256"),
    "low": ("#EEF6E8", "#7AA116"),
}

GROUP_POINTS = (
    "points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],"
    "[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];outlineConnect=0;"
    "gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;container=1;"
    "pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;"
)
# group_aws_cloud_alt / group_region / group_vpc / group_availability_zone styles are
# taken verbatim from this repo's own overview.drawio.svg files. The subnet group
# icons (group_public_subnet / group_private_subnet) are draw.io's standard names
# but are not used anywhere else in the repo yet.
GROUP_STYLES = {
    "cloud": GROUP_POINTS + "grIcon=mxgraph.aws4.group_aws_cloud_alt;strokeColor=#232F3E;fillColor=none;"
    "verticalAlign=top;align=left;spacingLeft=30;fontColor=#232F3E;dashed=0;",
    "region": GROUP_POINTS + "grIcon=mxgraph.aws4.group_region;strokeColor=#147EBA;fillColor=none;"
    "verticalAlign=top;align=left;spacingLeft=30;fontColor=#147EBA;dashed=1;",
    "vpc": GROUP_POINTS + "grIcon=mxgraph.aws4.group_vpc;strokeColor=#248814;fillColor=none;"
    "verticalAlign=top;align=left;spacingLeft=30;fontColor=#248814;dashed=0;",
    "az": GROUP_POINTS + "grIcon=mxgraph.aws4.group_availability_zone;strokeColor=#147EBA;fillColor=none;"
    "verticalAlign=top;align=left;spacingLeft=30;fontColor=#147EBA;dashed=1;",
    "public": GROUP_POINTS + "grIcon=mxgraph.aws4.group_public_subnet;strokeColor=#7AA116;fillColor=#F2F6E8;"
    "verticalAlign=top;align=left;spacingLeft=30;fontColor=#248814;dashed=0;",
    "private": GROUP_POINTS + "grIcon=mxgraph.aws4.group_private_subnet;strokeColor=#00A4A6;fillColor=#E6F6F7;"
    "verticalAlign=top;align=left;spacingLeft=30;fontColor=#147EBA;dashed=0;",
    "lane": "rounded=1;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#5A6472;verticalAlign=top;align=left;"
    "spacingLeft=10;spacingTop=6;fontSize=12;fontStyle=1;fontColor=#5A6472;dashed=1;",
}
STATIC_GROUP = {  # stroke, fill, dashed, title color
    "cloud": ("#232F3E", "none", False, "#232F3E"),
    "region": ("#147EBA", "none", True, "#147EBA"),
    "vpc": ("#248814", "none", False, "#248814"),
    "az": ("#147EBA", "none", True, "#147EBA"),
    "public": ("#7AA116", "#F2F6E8", False, "#248814"),
    "private": ("#00A4A6", "#E6F6F7", False, "#147EBA"),
    "lane": ("#5A6472", "none", True, "#5A6472"),
}

RES_TEMPLATE = (
    "sketch=0;points=[[0,0,0],[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0,0],[0,1,0],[0.25,1,0],[0.5,1,0],"
    "[0.75,1,0],[1,1,0],[0,0.25,0],[0,0.5,0],[0,0.75,0],[1,0.25,0],[1,0.5,0],[1,0.75,0]];"
    "outlineConnect=0;fontColor=#232F3E;fillColor={fill};strokeColor=#ffffff;dashed=0;"
    "verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=11;fontStyle=0;"
    "aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.{icon};"
)
FIXED_TEMPLATE = (
    "sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor={fill};"
    "strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;"
    "html=1;fontSize=11;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.{icon};"
)


def esc(s):
    return html.escape(str(s), quote=True)


def money(n):
    return f"${n:,.2f}"


def short(name, limit=NAME_MAX):
    name = str(name)
    return name if len(name) <= limit else name[: limit - 1] + "…"


# ---------------------------------------------------------------------------
# Layout tree
# ---------------------------------------------------------------------------
@dataclass
class Leaf:
    resource_type: str
    name: str
    sublabels: list
    cost: float
    findings: dict
    count: int = 1
    tier: str = "none"
    x: float = 0
    y: float = 0
    w: float = CELL_W
    h: float = CELL_H

    def measure(self):
        return self.w, self.h

    def place(self, x, y):
        self.x, self.y = x, y


@dataclass
class Box:
    kind: str
    title: str
    children: list = field(default_factory=list)
    layout: str = "grid"  # grid | row | column
    cols: int = GRID_COLS
    min_w: float = CELL_W + 2 * PAD
    x: float = 0
    y: float = 0
    w: float = 0
    h: float = 0

    def _rows(self):
        if self.layout == "row":
            return [self.children]
        if self.layout == "column":
            return [[c] for c in self.children]
        return [self.children[i : i + self.cols] for i in range(0, len(self.children), self.cols)]

    def _pad(self):
        return 0 if self.kind == "plain" else PAD

    def _title_h(self):
        return 0 if self.kind == "plain" else TITLE_H

    def measure(self):
        rows = self._rows()
        width = 0
        height = 0
        for row in rows:
            sizes = [c.measure() for c in row]
            width = max(width, sum(s[0] for s in sizes) + GAP * (len(sizes) - 1))
            height += max(s[1] for s in sizes) + GAP
        height = height - GAP if rows else 0
        pad = self._pad()
        # Rough text width (no font metrics here) so the title never runs past the frame.
        title_w = len(self.title) * 7.4 + (44 if self.kind in ("lane",) else 60) if self.title else 0
        self.w = max(self.min_w if self.kind != "plain" else 0, title_w, width + 2 * pad)
        self.h = self._title_h() + max(height, 20) + pad
        return self.w, self.h

    def place(self, x, y):
        self.x, self.y = x, y
        cy = y + self._title_h()
        for row in self._rows():
            cx = x + self._pad()
            row_h = 0
            for c in row:
                cw, ch = c.measure()
                c.place(cx, cy)
                cx += cw + GAP
                row_h = max(row_h, ch)
            cy += row_h + GAP

    def walk(self):
        yield self
        for c in self.children:
            if isinstance(c, Box):
                yield from c.walk()
            else:
                yield c


# ---------------------------------------------------------------------------
# Inventory -> layout tree
# ---------------------------------------------------------------------------
def _type_order(rtype):
    keys = list(CATALOG)
    return keys.index(rtype) if rtype in keys else len(keys)


def leaves_for(resources):
    """One leaf per resource, or one "×N" leaf per type when a container holds many of it."""
    by_type = {}
    for r in resources:
        by_type.setdefault(r.resource_type, []).append(r)
    leaves = []
    for rtype in sorted(by_type, key=_type_order):
        group = by_type[rtype]
        spec = CATALOG[rtype]
        if len(group) > AGG_THRESHOLD:
            findings = {}
            for r in group:
                for k, v in r.findings.items():
                    findings[k] = findings.get(k, 0) + v
            cost = sum(r.cost for r in group)
            leaves.append(Leaf(rtype, f"{spec.label} ×{len(group)}", [], cost, findings, count=len(group)))
        else:
            for r in sorted(group, key=lambda r: (-r.cost, r.name)):
                leaves.append(Leaf(rtype, r.name, [spec.label], r.cost, dict(r.findings)))
    return leaves


def _cost_total(resources):
    return sum(r.cost for r in resources)


def build_tree(inv):
    """Returns (root Box, list of empty VPC ids not drawn)."""
    cloud = Box("cloud", "AWS Cloud", layout="column")
    empty_vpcs = []
    if inv.global_resources:
        cloud.children.append(
            Box("lane", f"Global — {money(_cost_total(inv.global_resources))}/mo",
                leaves_for(inv.global_resources), cols=WIDE_GRID_COLS)
        )
    for region_name in sorted(inv.regions):
        region = inv.regions[region_name]
        region_resources = list(region.resources)
        region_box = Box("region", "", layout="column")
        for vpc in sorted(region.vpcs.values(), key=lambda v: v.name):
            vpc_resources = list(vpc.resources) + [r for s in vpc.subnets.values() for r in s.resources]
            if not vpc_resources:
                empty_vpcs.append(f"{region_name}/{vpc.vpc_id}")
                continue
            region_resources.extend(vpc_resources)
            vpc_box = Box("vpc", f"{vpc.name} ({vpc.cidr}) — {money(_cost_total(vpc_resources))}/mo", layout="column")
            if vpc.resources:
                vpc_box.children.append(Box("lane", "VPC-wide (spans subnets)", leaves_for(vpc.resources), cols=WIDE_GRID_COLS))
            azs = {}
            for subnet in vpc.subnets.values():
                azs.setdefault(subnet.az or "unknown AZ", []).append(subnet)
            az_row = Box("plain", "", layout="row")
            for az in sorted(azs):
                az_box = Box("az", az, layout="column")
                for subnet in sorted(azs[az], key=lambda s: (not s.public, s.name)):
                    title = f"{'Public' if subnet.public else 'Private'}: {short(subnet.name, 28)} ({subnet.cidr})"
                    az_box.children.append(
                        Box("public" if subnet.public else "private", title, leaves_for(subnet.resources), min_w=2 * CELL_W + GAP + 2 * PAD)
                    )
                az_row.children.append(az_box)
            if az_row.children:
                vpc_box.children.append(az_row)
            region_box.children.append(vpc_box)
        if region.resources:
            region_box.children.append(
                Box("lane", f"Regional services (outside VPC) — {money(_cost_total(region.resources))}/mo",
                    leaves_for(region.resources), cols=WIDE_GRID_COLS)
            )
        if region_box.children:
            region_box.title = f"Region {region_name} — {money(_cost_total(region_resources))}/mo"
            cloud.children.append(region_box)
    return cloud, empty_vpcs


def assign_tiers(leaves):
    """Ranks non-zero leaf costs: top 10% high, next 20% mid, rest low."""
    costed = sorted((l for l in leaves if l.cost > 0.005), key=lambda l: -l.cost)
    n = len(costed)
    high = max(1, round(n * 0.1)) if n else 0  # with few resources, still mark the most expensive
    mid = max(high, round(n * 0.3))
    for i, leaf in enumerate(costed):
        leaf.tier = "high" if i < high else "mid" if i < mid else "low"


def finding_badge(findings):
    """(count, color) of the badge, or None when there is nothing at LOW or above."""
    count = sum(findings.get(s, 0) for s in SEVERITY_ORDER if s != "INFORMATIONAL")
    if count == 0:
        return None
    if findings.get("CRITICAL") or findings.get("HIGH"):
        return count, "#D13212"
    if findings.get("MEDIUM"):
        return count, "#F89256"
    return count, "#879196"


def find_overlaps(root):
    """Pairs of sibling elements whose rectangles intersect (should always be empty)."""
    problems = []
    for box in [b for b in root.walk() if isinstance(b, Box)]:
        kids = box.children
        for i in range(len(kids)):
            for j in range(i + 1, len(kids)):
                a, b = kids[i], kids[j]
                if a.x < b.x + b.w and b.x < a.x + a.w and a.y < b.y + b.h and b.y < a.y + a.h:
                    problems.append((box.title, i, j))
        for k in kids:
            if k.x < box.x or k.y < box.y or k.x + k.w > box.x + box.w + 0.5 or k.y + k.h > box.y + box.h + 0.5:
                problems.append((box.title, "outside", kids.index(k)))
    return problems


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
def _icon_svg(spec, x, y):
    icon = ICONS.get(spec.icon)
    if icon:
        scale = ICON / icon["w"]
        tx = x - icon["x0"] * scale
        ty = y - icon["y0"] * scale
        return f'<g transform="translate({tx:.2f},{ty:.2f}) scale({scale:.4f})">{icon["markup"]}</g>'
    font = 15 if len(spec.short) <= 3 else 12
    return (
        f'<g transform="translate({x:.2f},{y:.2f})"><rect width="{ICON}" height="{ICON}" fill="{spec.fill}"/>'
        f'<text x="{ICON / 2}" y="{ICON / 2 + font / 3:.1f}" font-size="{font}px" font-weight="700" fill="#ffffff" '
        f'text-anchor="middle">{esc(spec.short)}</text></g>'
    )


def _xml(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


class Renderer:
    def __init__(self):
        self.svg = []
        self.cells = []
        self._id = 10

    def _next(self):
        self._id += 1
        return str(self._id)

    def vertex(self, x, y, w, h, value, style):
        cid = self._next()
        self.cells.append(
            f'<mxCell id="{cid}" value="{_xml(value)}" style="{_xml(style)}" parent="1" vertex="1">'
            f'<mxGeometry x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" as="geometry"/></mxCell>'
        )

    def text(self, x, y, w, h, value, size, bold=False, color="#16191F"):
        self.vertex(x, y, w, h, value,
                    "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;"
                    f"rounded=0;fontSize={size};fontStyle={1 if bold else 0};fontColor={color};")

    def box(self, b):
        if b.kind == "plain":
            return
        stroke, fill, dashed, title_color = STATIC_GROUP[b.kind]
        dash = ' stroke-dasharray="6,4"' if dashed else ""
        rx = ' rx="10" ry="10"' if b.kind == "lane" else ""
        self.svg.append(f'<rect x="{b.x:.1f}" y="{b.y:.1f}" width="{b.w:.1f}" height="{b.h:.1f}"{rx} '
                        f'fill="{fill}" stroke="{stroke}" stroke-width="1.4"{dash}/>')
        if b.kind == "cloud":
            d, bbox = AWS_CLOUD_BADGE["d"], AWS_CLOUD_BADGE["bbox"]
            self.svg.append(f'<g transform="translate({b.x - bbox[0]:.2f},{b.y - bbox[1]:.2f})">'
                            f'<path d="{d}" fill="{AWS_CLOUD_BADGE["fill"]}" stroke="none"/></g>')
            title_x = b.x + 32
        elif b.kind == "lane":
            title_x = b.x + 12
        else:
            self.svg.append(f'<rect x="{b.x:.1f}" y="{b.y:.1f}" width="24" height="24" fill="{stroke}"/>')
            title_x = b.x + 32
        self.svg.append(f'<text x="{title_x:.1f}" y="{b.y + 17:.1f}" class="groupTitle" fill="{title_color}">{esc(b.title)}</text>')
        self.vertex(b.x, b.y, b.w, b.h, esc(b.title), GROUP_STYLES[b.kind])

    def leaf(self, l):
        spec = CATALOG[l.resource_type]
        if l.tier in TIER_STYLE:
            fill, stroke = TIER_STYLE[l.tier]
            self.svg.append(f'<rect x="{l.x:.1f}" y="{l.y:.1f}" width="{l.w:.1f}" height="{l.h:.1f}" rx="8" ry="8" '
                            f'fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>')
            self.vertex(l.x, l.y, l.w, l.h, "", f"rounded=1;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};")
        ix = l.x + (l.w - ICON) / 2
        iy = l.y + 8
        self.svg.append(_icon_svg(spec, ix, iy))
        lines = [short(l.name)] + list(l.sublabels)
        if l.cost > 0.005:
            lines.append(f"{money(l.cost)}/mo")
        cx = l.x + l.w / 2
        ty = iy + ICON + 16
        for i, line in enumerate(lines):
            cls = "label" if i == 0 else "sublabel"
            self.svg.append(f'<text class="{cls}" x="{cx:.1f}" y="{ty + i * 14:.1f}">{esc(line)}</text>')
        template = FIXED_TEMPLATE if spec.shape == "fixed" else RES_TEMPLATE
        self.vertex(ix, iy, ICON, ICON, "<br>".join(esc(x) for x in lines), template.format(fill=spec.fill, icon=spec.icon))
        badge = finding_badge(l.findings)
        if badge:
            count, color = badge
            bx, by = ix + ICON - 6, iy - 6
            self.svg.append(f'<circle cx="{bx + 9:.1f}" cy="{by + 9:.1f}" r="10" fill="{color}" stroke="#ffffff" stroke-width="1.5"/>'
                            f'<text class="badge" x="{bx + 9:.1f}" y="{by + 13:.1f}">{count}</text>')
            self.vertex(bx - 1, by - 1, 20, 20, str(count),
                        f"ellipse;whiteSpace=wrap;html=1;fillColor={color};strokeColor=#ffffff;fontColor=#ffffff;fontSize=10;fontStyle=1;")


def render(inv, title, subtitle):
    """Returns (svg text, stats dict)."""
    root, empty_vpcs = build_tree(inv)
    leaves = [n for n in root.walk() if isinstance(n, Leaf)]
    assign_tiers(leaves)

    top = 84
    root.measure()
    root.place(30, top)
    legend_y = root.y + root.h + 24
    width = int(max(root.w + 60, 760))
    height = int(legend_y + 110)

    r = Renderer()
    for node in root.walk():
        if isinstance(node, Box):
            r.box(node)
    for node in leaves:
        r.leaf(node)

    # Legend (static + model).
    legend = [
        ("high", "Top 10% cost"), ("mid", "Next 20% cost"), ("low", "Other costed resources"),
    ]
    lx = 30
    for tier, text in legend:
        fill, stroke = TIER_STYLE[tier]
        r.svg.append(f'<rect x="{lx}" y="{legend_y}" width="18" height="14" rx="3" fill="{fill}" stroke="{stroke}"/>'
                     f'<text class="legend" x="{lx + 24}" y="{legend_y + 11}">{esc(text)}</text>')
        r.vertex(lx, legend_y, 18, 14, "", f"rounded=1;html=1;fillColor={fill};strokeColor={stroke};")
        r.text(lx + 22, legend_y - 3, 170, 20, esc(text), 11)
        lx += 200
    lx, legend_y = 30, legend_y + 26
    for color, text in [("#D13212", "Findings incl. CRITICAL/HIGH"), ("#F89256", "Findings, MEDIUM max"), ("#879196", "Findings, LOW only")]:
        r.svg.append(f'<circle cx="{lx + 9}" cy="{legend_y + 7}" r="8" fill="{color}"/>'
                     f'<text class="legend" x="{lx + 24}" y="{legend_y + 11}">{esc(text)}</text>')
        r.vertex(lx + 1, legend_y - 1, 16, 16, "", f"ellipse;html=1;fillColor={color};strokeColor=none;")
        r.text(lx + 22, legend_y - 3, 200, 20, esc(text), 11)
        lx += 230
    note = (f"Costs: CUR unblended, per resource. Not drawn: {inv.not_drawn} recorded items of undrawn types"
            + (f"; empty VPCs: {len(empty_vpcs)}" if empty_vpcs else "")
            + f". Groups of more than {AGG_THRESHOLD} of one type are merged into one ×N icon.")
    r.svg.append(f'<text class="legend" x="30" y="{legend_y + 44}">{esc(note)}</text>')
    r.text(30, legend_y + 30, width - 60, 20, esc(note), 11, color="#5A6472")

    # Title / subtitle / rule: also model cells, or draw.io drops them on save.
    r.text(30, 14, width - 60, 28, esc(title), 19, bold=True)
    r.text(30, 42, width - 60, 18, esc(subtitle), 12, color="#5A6472")
    r.vertex(30, 66, width - 60, 2.5, "", "rounded=0;whiteSpace=wrap;html=1;fillColor=#E7157B;strokeColor=none;")

    visual = f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {width} {height}" width="{width}px" height="{height}px" font-family="Helvetica, Arial, sans-serif">
  <style>
    .label {{ font-size: 11.5px; font-weight: 600; fill: #16191F; text-anchor: middle; }}
    .sublabel {{ font-size: 10px; fill: #5A6472; text-anchor: middle; }}
    .groupTitle {{ font-size: 12.5px; font-weight: 700; }}
    .badge {{ font-size: 10.5px; font-weight: 700; fill: #ffffff; text-anchor: middle; }}
    .legend {{ font-size: 11px; fill: #40474F; }}
  </style>
  <rect x="0" y="0" width="{width}" height="{height}" fill="#ffffff"/>
  <text x="30" y="34" font-size="19px" font-weight="700" fill="#16191F">{esc(title)}</text>
  <text x="30" y="54" font-size="12px" fill="#5A6472">{esc(subtitle)}</text>
  <line x1="30" y1="66" x2="{width - 30}" y2="66" stroke="#E7157B" stroke-width="2.5"/>
{chr(10).join(r.svg)}
</svg>'''

    model = (
        f'<mxGraphModel dx="1024" dy="768" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" '
        f'fold="1" page="1" pageScale="1" pageWidth="{width}" pageHeight="{height}" background="#ffffff" math="0" shadow="0">'
        f'<root><mxCell id="0"/><mxCell id="1" parent="0"/>{"".join(r.cells)}</root></mxGraphModel>'
    )
    # <diagram> must hold the model as a child element with no text, or draw.io
    # reads it as compressed base64 and fails.
    mxfile = (f'<mxfile host="app.diagrams.net" agent="aws-environment-report" version="24.0.0">'
              f'<diagram id="overview" name="Overview">{model}</diagram></mxfile>')
    final = visual.replace('<svg xmlns="http://www.w3.org/2000/svg"',
                           f'<svg xmlns="http://www.w3.org/2000/svg" content="{_xml(mxfile)}"', 1)
    stats = {
        "nodes": len(leaves),
        "overlaps": len(find_overlaps(root)),
        "emptyVpcs": empty_vpcs,
        "width": width,
        "height": height,
    }
    return final, stats
