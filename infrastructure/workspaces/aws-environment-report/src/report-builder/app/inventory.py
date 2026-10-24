"""Turns raw collector output into the placement tree the diagram draws.

Placement comes from the configuration items themselves (vpcId / subnetId
fields), not from AWS Config relationships, so it does not depend on which
relationship types a given resource type happens to record.
"""
from collections import defaultdict
from dataclasses import dataclass, field

from .catalog import (
    CATALOG,
    COST_PARENTS,
    GLOBAL_TYPES,
    ROUTE_TABLE_TYPE,
    SEVERITY_ORDER,
    SUBNET_TYPE,
    VPC_TYPE,
)


@dataclass
class Resource:
    key: str  # stable unique id: arn, or region|type|resourceId
    resource_type: str
    resource_id: str
    name: str
    region: str
    arn: str = ""
    vpc_id: str = ""
    subnet_ids: list = field(default_factory=list)
    cost: float = 0.0
    findings: dict = field(default_factory=dict)  # severity -> count

    @property
    def finding_count(self):
        return sum(v for k, v in self.findings.items() if k != "INFORMATIONAL")


@dataclass
class Subnet:
    subnet_id: str
    name: str
    az: str
    cidr: str
    public: bool
    resources: list = field(default_factory=list)


@dataclass
class Vpc:
    vpc_id: str
    name: str
    cidr: str
    region: str
    subnets: dict = field(default_factory=dict)  # subnet_id -> Subnet
    resources: list = field(default_factory=list)  # VPC-level (multi-subnet or no subnet)


@dataclass
class Region:
    name: str
    vpcs: dict = field(default_factory=dict)
    resources: list = field(default_factory=list)  # regional, outside any VPC


@dataclass
class Inventory:
    regions: dict = field(default_factory=dict)
    global_resources: list = field(default_factory=list)
    type_counts: dict = field(default_factory=dict)  # resourceType -> count (all recorded types)
    drawn: int = 0
    not_drawn: int = 0
    by_identifier: dict = field(default_factory=dict)  # arn / resourceId / name -> Resource
    cost_on_diagram: float = 0.0  # CUR cost matched to a drawn resource
    cost_off_diagram: float = 0.0  # CUR cost with a resource ID that is not drawn (or not in Config)
    findings_placed: int = 0


def _tag_name(item):
    for tag in item.get("tags") or []:
        if isinstance(tag, dict) and tag.get("key") == "Name" and tag.get("value"):
            return tag["value"]
    return None


def _find_strings(value, keys, depth=0):
    """All string values (or string list items) of the given keys anywhere in the configuration."""
    found = []
    if depth > 5:
        return found
    if isinstance(value, dict):
        for k, v in value.items():
            if k in keys:
                if isinstance(v, str) and v:
                    found.append(v)
                elif isinstance(v, list):
                    found.extend(x for x in v if isinstance(x, str) and x)
            found.extend(_find_strings(v, keys, depth + 1))
    elif isinstance(value, list):
        for v in value:
            found.extend(_find_strings(v, keys, depth + 1))
    return found


def _unique(seq):
    return list(dict.fromkeys(seq))


def _public_subnets(items):
    """Subnets whose route table (explicit association, else the VPC main table) routes to an internet gateway."""
    main_public = {}
    explicit = {}
    for item in items:
        if item.get("resourceType") != ROUTE_TABLE_TYPE:
            continue
        cfg = item.get("configuration") or {}
        to_igw = any(
            str(r.get("gatewayId", "")).startswith("igw-") for r in cfg.get("routes") or [] if isinstance(r, dict)
        )
        for assoc in cfg.get("associations") or []:
            if not isinstance(assoc, dict):
                continue
            if assoc.get("main"):
                main_public[cfg.get("vpcId")] = to_igw
            elif assoc.get("subnetId"):
                explicit[assoc["subnetId"]] = to_igw
    return main_public, explicit


def build_inventory(config_items, cost=None, findings=None):
    """config_items: raw/…/config.json "items"; cost: raw cost.json; findings: list of normalized findings."""
    inv = Inventory()
    main_public, explicit_public = _public_subnets(config_items)
    counts = defaultdict(int)

    def region_of(name):
        return inv.regions.setdefault(name, Region(name))

    # Pass 1: VPCs and subnets (the containers).
    subnet_index = {}
    for item in config_items:
        rtype = item.get("resourceType")
        counts[rtype] += 1
        cfg = item.get("configuration") or {}
        if rtype == VPC_TYPE:
            region = region_of(item.get("awsRegion", "unknown"))
            vid = item.get("resourceId")
            region.vpcs[vid] = Vpc(vid, _tag_name(item) or vid, cfg.get("cidrBlock", ""), region.name)
    for item in config_items:
        if item.get("resourceType") != SUBNET_TYPE:
            continue
        cfg = item.get("configuration") or {}
        region = region_of(item.get("awsRegion", "unknown"))
        vpc = region.vpcs.get(cfg.get("vpcId"))
        if not vpc:
            continue
        sid = item.get("resourceId")
        public = explicit_public.get(sid, main_public.get(vpc.vpc_id, False))
        subnet = Subnet(sid, _tag_name(item) or sid, cfg.get("availabilityZone") or item.get("availabilityZone") or "",
                        cfg.get("cidrBlock", ""), public)
        vpc.subnets[sid] = subnet
        subnet_index[sid] = (vpc, subnet)

    # Pass 2: drawable resources.
    for item in config_items:
        rtype = item.get("resourceType")
        spec = CATALOG.get(rtype)
        rid = item.get("resourceId") or ""
        res = Resource(
            key=item.get("arn") or f"{item.get('awsRegion')}|{rtype}|{rid}",
            resource_type=rtype,
            resource_id=rid,
            name=_tag_name(item) or item.get("resourceName") or rid,
            region=item.get("awsRegion", "unknown"),
            arn=item.get("arn") or "",
        )
        for ident in (res.arn, rid, item.get("resourceName")):
            if ident:
                inv.by_identifier.setdefault(ident, res)
        if not spec:
            if rtype not in (VPC_TYPE, SUBNET_TYPE):
                inv.not_drawn += 1
            continue
        inv.drawn += 1

        cfg = item.get("configuration") or {}
        subnet_ids = [s for s in _unique(_find_strings(cfg, {"subnetId", "subnetIds", "subnets", "subnetIdentifier"})) if s.startswith("subnet-")]
        vpc_ids = [v for v in _unique(_find_strings(cfg, {"vpcId"})) if v.startswith("vpc-")]
        if not vpc_ids and rtype == "AWS::EC2::InternetGateway":
            vpc_ids = [a.get("vpcId") for a in cfg.get("attachments") or [] if isinstance(a, dict) and a.get("vpcId")]
        res.subnet_ids = subnet_ids
        res.vpc_id = vpc_ids[0] if vpc_ids else ""

        if rtype in GLOBAL_TYPES:
            inv.global_resources.append(res)
            continue
        region = region_of(res.region)
        if len(subnet_ids) == 1 and subnet_ids[0] in subnet_index:
            subnet_index[subnet_ids[0]][1].resources.append(res)
        elif subnet_ids and subnet_ids[0] in subnet_index:
            subnet_index[subnet_ids[0]][0].resources.append(res)
        elif res.vpc_id and res.vpc_id in region.vpcs:
            region.vpcs[res.vpc_id].resources.append(res)
        else:
            region.resources.append(res)

    inv.type_counts = dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0] or "")))

    # Cost parents: e.g. an EBS volume's cost is drawn on its instance.
    parents = {}
    for item in config_items:
        fn = COST_PARENTS.get(item.get("resourceType"))
        if fn:
            parent = fn(item.get("configuration"))
            if parent:
                parents[item.get("resourceId")] = parent
                if item.get("arn"):
                    parents[item["arn"]] = parent

    if cost:
        _apply_cost(inv, cost, parents)
    if findings:
        _apply_findings(inv, findings)
    return inv


def _lookup(inv, identifier):
    if identifier in inv.by_identifier:
        return inv.by_identifier[identifier]
    # CUR and some findings use an ARN where Config has the bare ID (or vice versa).
    for sep in ("/", ":"):
        tail = identifier.rsplit(sep, 1)[-1]
        if tail and tail in inv.by_identifier:
            return inv.by_identifier[tail]
    return None


def _apply_cost(inv, cost, parents):
    on_diagram = 0.0
    off_diagram = 0.0
    for rid, entry in (cost.get("byResource") or {}).items():
        amount = float(entry.get("cost", 0))
        target = _lookup(inv, parents.get(rid, rid))
        if target is None and rid in parents:
            target = _lookup(inv, rid)
        if target is not None and target.resource_type in CATALOG:
            target.cost += amount
            on_diagram += amount
        else:
            off_diagram += amount
    inv.cost_on_diagram = round(on_diagram, 2)
    inv.cost_off_diagram = round(off_diagram, 2)


def _apply_findings(inv, findings):
    placed = 0
    for f in findings:
        sev = f.get("severity", "INFORMATIONAL")
        for rid in f.get("resourceIds") or []:
            target = _lookup(inv, rid)
            if target is not None:
                target.findings[sev] = target.findings.get(sev, 0) + 1
                placed += 1
                break
    inv.findings_placed = placed


def severity_counts(findings):
    counts = {s: 0 for s in SEVERITY_ORDER}
    for f in findings:
        counts[f.get("severity", "INFORMATIONAL")] = counts.get(f.get("severity", "INFORMATIONAL"), 0) + 1
    return counts
