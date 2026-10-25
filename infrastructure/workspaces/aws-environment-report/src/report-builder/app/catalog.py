"""Which AWS Config resource types are drawn, and how.

Types not listed here are still counted in the inventory table of the report;
they are just not drawn (security groups, ENIs, IAM entities and the like
would bury the diagram).

`icon` is the draw.io AWS4 name used in the editable model. Names with
`shape: "fixed"` are standalone shapes (`shape=mxgraph.aws4.<icon>`), the rest
are `resourceIcon` cells (`resIcon=mxgraph.aws4.<icon>`). The static preview
uses the icon from assets/icons.json (official AWS Architecture Icons, or
icons extracted from this repo's overview.drawio.svg files) and falls back to a
colored square with a short code for a name missing there (draw.io still
renders the real icon from the model).
"""
from dataclasses import dataclass

COMPUTE = "#ED7100"
STORAGE = "#7AA116"
DATABASE = "#C925D1"
NETWORK = "#8C4FFF"
INTEGRATION = "#E7157B"
SECURITY = "#DD344C"
MANAGEMENT = "#E7157B"


@dataclass(frozen=True)
class TypeSpec:
    label: str
    icon: str
    fill: str
    short: str
    shape: str = "resource"  # "resource" or "fixed"


CATALOG = {
    # Compute
    "AWS::EC2::Instance": TypeSpec("EC2", "ec2", COMPUTE, "EC2"),
    "AWS::Lambda::Function": TypeSpec("Lambda", "lambda", COMPUTE, "λ"),
    "AWS::ECS::Cluster": TypeSpec("ECS Cluster", "ecs", COMPUTE, "ECS"),
    "AWS::ECS::Service": TypeSpec("ECS Service", "ecs_service", COMPUTE, "SVC", "fixed"),
    "AWS::EKS::Cluster": TypeSpec("EKS", "eks", COMPUTE, "EKS"),
    "AWS::ECR::Repository": TypeSpec("ECR", "ecr", COMPUTE, "ECR"),
    "AWS::AutoScaling::AutoScalingGroup": TypeSpec("Auto Scaling", "auto_scaling2", COMPUTE, "ASG"),
    # Storage
    "AWS::S3::Bucket": TypeSpec("S3", "s3", STORAGE, "S3"),
    "AWS::EFS::FileSystem": TypeSpec("EFS", "elastic_file_system", STORAGE, "EFS"),
    # Database
    "AWS::RDS::DBInstance": TypeSpec("RDS", "rds", DATABASE, "RDS"),
    "AWS::RDS::DBCluster": TypeSpec("Aurora", "aurora", DATABASE, "AUR"),
    "AWS::DynamoDB::Table": TypeSpec("DynamoDB", "dynamodb", DATABASE, "DDB"),
    "AWS::ElastiCache::CacheCluster": TypeSpec("ElastiCache", "elasticache", DATABASE, "EC"),
    # Networking
    "AWS::EC2::NatGateway": TypeSpec("NAT Gateway", "nat_gateway", NETWORK, "NAT", "fixed"),
    "AWS::EC2::InternetGateway": TypeSpec("Internet Gateway", "internet_gateway", NETWORK, "IGW", "fixed"),
    "AWS::EC2::VPCEndpoint": TypeSpec("VPC Endpoint", "endpoints", NETWORK, "VPCE", "fixed"),
    "AWS::EC2::TransitGateway": TypeSpec("Transit Gateway", "transit_gateway", NETWORK, "TGW"),
    "AWS::ElasticLoadBalancingV2::LoadBalancer": TypeSpec("Load Balancer", "application_load_balancer", NETWORK, "ELB", "fixed"),
    "AWS::CloudFront::Distribution": TypeSpec("CloudFront", "cloudfront", NETWORK, "CF"),
    "AWS::Route53::HostedZone": TypeSpec("Route 53", "route_53", NETWORK, "R53"),
    "AWS::ApiGateway::RestApi": TypeSpec("API Gateway", "api_gateway", INTEGRATION, "API"),
    "AWS::ApiGatewayV2::Api": TypeSpec("API Gateway", "api_gateway", INTEGRATION, "API"),
    # Application integration
    "AWS::SNS::Topic": TypeSpec("SNS", "sns", INTEGRATION, "SNS"),
    "AWS::SQS::Queue": TypeSpec("SQS", "sqs", INTEGRATION, "SQS"),
    "AWS::StepFunctions::StateMachine": TypeSpec("Step Functions", "step_functions", INTEGRATION, "SFN"),
    "AWS::Events::EventBus": TypeSpec("EventBridge", "eventbridge", INTEGRATION, "EB"),
    "AWS::Kinesis::Stream": TypeSpec("Kinesis", "kinesis_data_streams", NETWORK, "KDS"),
    "AWS::KinesisFirehose::DeliveryStream": TypeSpec("Firehose", "kinesis_data_firehose", NETWORK, "KDF"),
    # Security
    "AWS::WAFv2::WebACL": TypeSpec("WAF", "waf", SECURITY, "WAF"),
    "AWS::KMS::Key": TypeSpec("KMS", "key_management_service", SECURITY, "KMS"),
    "AWS::SecretsManager::Secret": TypeSpec("Secrets Manager", "secrets_manager", SECURITY, "SEC"),
}

# Types AWS Config records in us-east-1 but that are global by nature.
GLOBAL_TYPES = {"AWS::CloudFront::Distribution", "AWS::Route53::HostedZone"}

# Costs of these resources are drawn on the resource they belong to.
# resourceType -> function(configuration) -> parent resourceId or None
def _volume_parent(cfg):
    for att in (cfg or {}).get("attachments") or []:
        if isinstance(att, dict) and att.get("instanceId"):
            return att["instanceId"]
    return None


COST_PARENTS = {"AWS::EC2::Volume": _volume_parent}

# The VPC itself and its subnets/route tables are drawn as containers.
VPC_TYPE = "AWS::EC2::VPC"
SUBNET_TYPE = "AWS::EC2::Subnet"
ROUTE_TABLE_TYPE = "AWS::EC2::RouteTable"

SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"]
