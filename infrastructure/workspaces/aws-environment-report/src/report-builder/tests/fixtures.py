"""Synthetic collector output shaped like the real raw/ files (no real account data)."""
ACCOUNT = "111122223333"
R = "ap-northeast-1"


def ci(rtype, rid, region=R, name=None, arn=None, cfg=None, az=None):
    item = {"resourceId": rid, "resourceType": rtype, "awsRegion": region, "configuration": cfg or {}}
    if name:
        item["resourceName"] = name
        item["tags"] = [{"key": "Name", "value": name}]
    if arn:
        item["arn"] = arn
    if az:
        item["availabilityZone"] = az
    return item


def config_items():
    items = [
        ci("AWS::EC2::VPC", "vpc-0aaa", name="prod-vpc", cfg={"cidrBlock": "10.0.0.0/16"}),
        ci("AWS::EC2::VPC", "vpc-0def", name="default", cfg={"cidrBlock": "172.31.0.0/16"}),
        ci("AWS::EC2::Subnet", "subnet-pub-a", name="public-a", cfg={"vpcId": "vpc-0aaa", "availabilityZone": "ap-northeast-1a", "cidrBlock": "10.0.0.0/24"}),
        ci("AWS::EC2::Subnet", "subnet-pub-c", name="public-c", cfg={"vpcId": "vpc-0aaa", "availabilityZone": "ap-northeast-1c", "cidrBlock": "10.0.1.0/24"}),
        ci("AWS::EC2::Subnet", "subnet-pri-a", name="private-a", cfg={"vpcId": "vpc-0aaa", "availabilityZone": "ap-northeast-1a", "cidrBlock": "10.0.10.0/24"}),
        ci("AWS::EC2::Subnet", "subnet-pri-c", name="private-c", cfg={"vpcId": "vpc-0aaa", "availabilityZone": "ap-northeast-1c", "cidrBlock": "10.0.11.0/24"}),
        ci("AWS::EC2::Subnet", "subnet-def-a", cfg={"vpcId": "vpc-0def", "availabilityZone": "ap-northeast-1a", "cidrBlock": "172.31.0.0/20"}),
        ci("AWS::EC2::RouteTable", "rtb-pub", cfg={"vpcId": "vpc-0aaa", "routes": [{"gatewayId": "igw-0aaa", "destinationCidrBlock": "0.0.0.0/0"}],
           "associations": [{"subnetId": "subnet-pub-a"}, {"subnetId": "subnet-pub-c"}]}),
        ci("AWS::EC2::RouteTable", "rtb-main", cfg={"vpcId": "vpc-0aaa", "routes": [{"natGatewayId": "nat-0aaa"}], "associations": [{"main": True}]}),
        ci("AWS::EC2::InternetGateway", "igw-0aaa", cfg={"attachments": [{"vpcId": "vpc-0aaa", "state": "available"}]}),
        ci("AWS::EC2::NatGateway", "nat-0aaa", arn=f"arn:aws:ec2:{R}:{ACCOUNT}:natgateway/nat-0aaa", cfg={"vpcId": "vpc-0aaa", "subnetId": "subnet-pub-a"}),
        ci("AWS::ElasticLoadBalancingV2::LoadBalancer", f"arn:aws:elasticloadbalancing:{R}:{ACCOUNT}:loadbalancer/app/web/1", name="web-alb",
           arn=f"arn:aws:elasticloadbalancing:{R}:{ACCOUNT}:loadbalancer/app/web/1",
           cfg={"vpcId": "vpc-0aaa", "availabilityZones": [{"zoneName": "ap-northeast-1a", "subnetId": "subnet-pub-a"}, {"zoneName": "ap-northeast-1c", "subnetId": "subnet-pub-c"}]}),
        ci("AWS::EC2::Instance", "i-0123456789abcdef0", name="app-1", arn=f"arn:aws:ec2:{R}:{ACCOUNT}:instance/i-0123456789abcdef0",
           cfg={"vpcId": "vpc-0aaa", "subnetId": "subnet-pri-a"}),
        ci("AWS::EC2::Instance", "i-0fedcba9876543210", name="app-2 <script>", arn=f"arn:aws:ec2:{R}:{ACCOUNT}:instance/i-0fedcba9876543210",
           cfg={"vpcId": "vpc-0aaa", "subnetId": "subnet-pri-c"}),
        ci("AWS::EC2::Volume", "vol-0aaa", cfg={"attachments": [{"instanceId": "i-0123456789abcdef0"}]}),
        ci("AWS::RDS::DBCluster", "cluster-ABC", name="orders-db", arn=f"arn:aws:rds:{R}:{ACCOUNT}:cluster:orders-db",
           cfg={"dBSubnetGroup": "orders", "vpcSecurityGroups": [], "availabilityZones": ["ap-northeast-1a"]}),
        ci("AWS::RDS::DBInstance", "db-XYZ", name="orders-db-1", arn=f"arn:aws:rds:{R}:{ACCOUNT}:db:orders-db-1",
           cfg={"dBSubnetGroup": {"vpcId": "vpc-0aaa", "subnets": [{"subnetIdentifier": "subnet-pri-a"}, {"subnetIdentifier": "subnet-pri-c"}]}}),
        ci("AWS::EC2::SecurityGroup", "sg-0aaa", cfg={"vpcId": "vpc-0aaa"}),
        ci("AWS::DynamoDB::Table", "orders", name="orders", arn=f"arn:aws:dynamodb:{R}:{ACCOUNT}:table/orders"),
        ci("AWS::SNS::Topic", f"arn:aws:sns:{R}:{ACCOUNT}:alerts", name="alerts", arn=f"arn:aws:sns:{R}:{ACCOUNT}:alerts"),
        ci("AWS::SQS::Queue", "https://sqs/queue", name="jobs", arn=f"arn:aws:sqs:{R}:{ACCOUNT}:jobs"),
        ci("AWS::S3::Bucket", "logs-bucket", name="logs-bucket", arn="arn:aws:s3:::logs-bucket", region="us-east-1"),
        ci("AWS::CloudFront::Distribution", "E123", arn=f"arn:aws:cloudfront::{ACCOUNT}:distribution/E123", region="us-east-1"),
        ci("AWS::Route53::HostedZone", "Z123", name="example.com.", region="us-east-1"),
        ci("AWS::IAM::Role", "AROA123", name="app-role", region="us-east-1"),
    ]
    for i in range(6):
        items.append(ci("AWS::Lambda::Function", f"fn-{i}", name=f"fn-{i}", arn=f"arn:aws:lambda:{R}:{ACCOUNT}:function:fn-{i}"))
    return items


def cost_raw():
    return {
        "totalCost": 1000.0,
        "allocatedCost": 900.0,
        "unallocatedCost": 100.0,
        "byProduct": {"AmazonEC2": 500.0, "AmazonRDS": 300.0, "AWSLambda": 60.0, "AmazonS3": 40.0},
        "byResource": {
            "i-0123456789abcdef0": {"cost": 200.0, "productCode": "AmazonEC2"},
            "vol-0aaa": {"cost": 20.0, "productCode": "AmazonEC2"},
            f"arn:aws:ec2:{R}:{ACCOUNT}:natgateway/nat-0aaa": {"cost": 45.0, "productCode": "AmazonEC2"},
            f"arn:aws:elasticloadbalancing:{R}:{ACCOUNT}:loadbalancer/app/web/1": {"cost": 25.0, "productCode": "AWSELB"},
            f"arn:aws:rds:{R}:{ACCOUNT}:db:orders-db-1": {"cost": 300.0, "productCode": "AmazonRDS"},
            f"arn:aws:lambda:{R}:{ACCOUNT}:function:fn-1": {"cost": 60.0, "productCode": "AWSLambda"},
            "logs-bucket": {"cost": 40.0, "productCode": "AmazonS3"},
            "sg-unknown-thing": {"cost": 210.0, "productCode": "AmazonEC2"},
        },
    }


def findings():
    return [
        {"source": "securityhub", "region": "us-east-1", "severity": "HIGH", "title": "S3.8 block public access",
         "resourceIds": ["arn:aws:s3:::logs-bucket"]},
        {"source": "guardduty", "region": R, "severity": "MEDIUM", "title": "Recon:EC2/PortProbeUnprotectedPort",
         "resourceIds": ["i-0123456789abcdef0"]},
        {"source": "inspector", "region": R, "severity": "CRITICAL", "title": "CVE-2026-0001",
         "resourceIds": [f"arn:aws:ec2:{R}:{ACCOUNT}:instance/i-0123456789abcdef0"]},
        {"source": "inspector", "region": R, "severity": "LOW", "title": "unplaced", "resourceIds": ["arn:aws:ecr:x"]},
    ]


class MemoryStore:
    bucket = "test-bucket"

    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.order = []

    def get_json(self, key):
        import json
        v = self.objects.get(key)
        return None if v is None else (json.loads(v) if isinstance(v, (bytes, str)) else v)

    def put(self, key, body, content_type):
        self.objects[key] = body
        self.order.append(key)
