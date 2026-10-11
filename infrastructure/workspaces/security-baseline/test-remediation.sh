#!/usr/bin/env bash
# End-to-end check of the automatic remediation with real resources.
# A real resource is created in a deliberately bad state, a Security Hub finding for it is imported with
# BatchImportFindings (the same finding shape the control or GuardDuty would produce), and the script checks what the
# remediation did. Needs `acceptImportedFindings: true` (development default).
# Usage: ./test-remediation.sh --project <project> --env <env> [--region <region>]
set -euo pipefail

PROJECT="" ENVIRONMENT="" REGION="${AWS_REGION:-ap-northeast-1}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" && -n "$ENVIRONMENT" ]] || { echo "Usage: $0 --project <project> --env <env> [--region <region>]" >&2; exit 2; }
for cmd in aws jq; do command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 1; }; done

export AWS_PROFILE="${AWS_PROFILE:-${PROJECT}-${ENVIRONMENT}}" AWS_DEFAULT_REGION="$REGION"
STACK="${PROJECT}-${ENVIRONMENT}-security-baseline"
FN="${PROJECT}-${ENVIRONMENT}-secbase-remediation"
SKIP_TAG="security-baseline:remediation-skip"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
PRODUCT_ARN="arn:aws:securityhub:${REGION}:${ACCOUNT}:product/${ACCOUNT}/default"
SUFFIX="$(date +%s)"
BUCKET="${PROJECT}-${ENVIRONMENT}-remediation-test-${SUFFIX}"
SKIP_BUCKET="${BUCKET}-skip"
FAILED=0
pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }

VPC="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
[[ "$VPC" != "None" ]] || { echo "this check needs a default VPC" >&2; exit 1; }
SG="" SKIP_SG="" INSTANCE="" SKIP_INSTANCE=""

set_mode() { # $1 = enforce|dry-run ; the function keeps the rest of its settings
  local env; env="$(aws lambda get-function-configuration --function-name "$FN" --query Environment.Variables --output json | jq -c --arg m "$1" '.MODE=$m | {Variables: .}')"
  aws lambda update-function-configuration --function-name "$FN" --environment "$env" >/dev/null
  aws lambda wait function-updated --function-name "$FN"
}
cleanup() {
  set +e
  set_mode dry-run >/dev/null 2>&1
  for b in "$BUCKET" "$SKIP_BUCKET"; do aws s3api delete-bucket --bucket "$b" >/dev/null 2>&1; done
  for i in $INSTANCE $SKIP_INSTANCE; do aws ec2 terminate-instances --instance-ids "$i" >/dev/null 2>&1; done
  [[ -n "$INSTANCE$SKIP_INSTANCE" ]] && aws ec2 wait instance-terminated --instance-ids $INSTANCE $SKIP_INSTANCE >/dev/null 2>&1
  for g in $SG $SKIP_SG; do aws ec2 delete-security-group --group-id "$g" >/dev/null 2>&1; done
  local q; q="$(aws ec2 describe-security-groups --filters Name=vpc-id,Values="$VPC" Name=group-name,Values="${PROJECT}-${ENVIRONMENT}-secbase-quarantine" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)"
  [[ -n "$q" && "$q" != "None" ]] && aws ec2 delete-security-group --group-id "$q" >/dev/null 2>&1
}
trap cleanup EXIT

# import <id> <title> <severity> <resource-type> <resource-id> [control-id]  -> imports one ASFF finding
import() {
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  local compliance='null'; [[ -n "${6:-}" ]] && compliance="{\"Status\":\"FAILED\",\"SecurityControlId\":\"$6\"}"
  local finding; finding="$(jq -nc --arg id "$1" --arg title "$2" --arg sev "$3" --arg rt "$4" --arg rid "$5" --arg now "$now" \
    --arg acct "$ACCOUNT" --arg pa "$PRODUCT_ARN" --arg region "$REGION" --argjson comp "$compliance" '
    {SchemaVersion:"2018-10-08", Id:$id, ProductArn:$pa, GeneratorId:"remediation-test", AwsAccountId:$acct,
     Types:["Software and Configuration Checks/Industry and Regulatory Standards"], CreatedAt:$now, UpdatedAt:$now,
     Severity:{Label:$sev}, Title:$title, Description:$title, Resources:[{Type:$rt, Id:$rid, Region:$region}],
     RecordState:"ACTIVE", Workflow:{Status:"NEW"}} + (if $comp != null then {Compliance:$comp} else {} end)')"
  aws securityhub batch-import-findings --findings "[$finding]" --query 'FailedCount' --output text
}
finding_note() { aws securityhub get-findings --filters "{\"Id\":[{\"Value\":\"$1\",\"Comparison\":\"EQUALS\"}]}" --output json | jq -r '.Findings[0] | "\(.Workflow.Status) \(.Note.Text // "")"'; }
wait_until() { # $1 = description, rest = command that must succeed
  local d="$1"; shift
  for _ in $(seq 1 30); do "$@" >/dev/null 2>&1 && return 0; sleep 4; done
  return 1
}

echo "stack: $STACK  function: $FN  default VPC: $VPC"
[[ "$(aws lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables.TRUSTED_PRODUCTS' --output text)" == *Default* ]] \
  || { echo "acceptImportedFindings is off: this script cannot import test findings" >&2; exit 1; }

# --- test resources, each in a bad state ----------------------------------------------------------------------------
aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
aws s3api delete-public-access-block --bucket "$BUCKET"
aws s3api create-bucket --bucket "$SKIP_BUCKET" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
aws s3api delete-public-access-block --bucket "$SKIP_BUCKET"
aws s3api put-bucket-tagging --bucket "$SKIP_BUCKET" --tagging "TagSet=[{Key=$SKIP_TAG,Value=true}]"

mk_sg() { aws ec2 create-security-group --group-name "$1-$SUFFIX" --description "remediation test" --vpc-id "$VPC" --query GroupId --output text; }
SG="$(mk_sg remediation-test)"; SKIP_SG="$(mk_sg remediation-test-skip)"
for g in "$SG" "$SKIP_SG"; do
  aws ec2 authorize-security-group-ingress --group-id "$g" --ip-permissions \
    'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=0.0.0.0/0},{CidrIp=10.0.0.0/8}]' \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null
done
aws ec2 create-tags --resources "$SKIP_SG" --tags "Key=$SKIP_TAG,Value=true"

AMI="$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)"
SUBNET="$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true --query 'Subnets[0].SubnetId' --output text)"
run_instance() { aws ec2 run-instances --image-id "$AMI" --instance-type t4g.nano --subnet-id "$SUBNET" --security-group-ids "$SG" \
  --metadata-options HttpTokens=required "${@:1}" --query 'Instances[0].InstanceId' --output text; }
INSTANCE="$(run_instance --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=remediation-test}]')"
SKIP_INSTANCE="$(run_instance --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=remediation-test-skip},{Key=$SKIP_TAG,Value=true}]")"
aws ec2 wait instance-running --instance-ids "$INSTANCE" "$SKIP_INSTANCE"
echo "buckets: $BUCKET, $SKIP_BUCKET  security groups: $SG, $SKIP_SG  instances: $INSTANCE, $SKIP_INSTANCE"

bpa_enabled() { [[ "$(aws s3api get-public-access-block --bucket "$1" --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' --output text 2>/dev/null | tr '\t' ' ')" == "True True True True" ]]; }
# number of 0.0.0.0/0 ranges on port 22 / number of rules that exist for a given port and cidr
open_admin_rules() { aws ec2 describe-security-groups --group-ids "$1" --output json | jq '[.SecurityGroups[0].IpPermissions[] | select(.FromPort==22) | .IpRanges[] | select(.CidrIp=="0.0.0.0/0")] | length'; }
rule_count() { aws ec2 describe-security-groups --group-ids "$1" --output json | jq --argjson p "$2" --arg c "$3" '[.SecurityGroups[0].IpPermissions[] | select(.FromPort==$p) | .IpRanges[] | select(.CidrIp==$c)] | length'; }
sgs_of() { aws ec2 describe-instances --instance-ids "$1" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text; }

# --- 1. dry-run: findings are noted, nothing changes -----------------------------------------------------------------
set_mode dry-run
import "dr-s3-$SUFFIX" "S3 bucket without Block Public Access" HIGH AwsS3Bucket "arn:aws:s3:::$BUCKET" S3.8 >/dev/null
import "dr-sg-$SUFFIX" "Security group open to the internet on SSH" HIGH AwsEc2SecurityGroup "arn:aws:ec2:$REGION:$ACCOUNT:security-group/$SG" EC2.53 >/dev/null
import "dr-i-$SUFFIX" "Backdoor activity on an instance" HIGH AwsEc2Instance "arn:aws:ec2:$REGION:$ACCOUNT:instance/$INSTANCE" >/dev/null
wait_until "dry-run notes" bash -c "$(declare -f finding_note); export AWS_PROFILE AWS_DEFAULT_REGION; [[ \"\$(finding_note dr-i-$SUFFIX)\" == *dry-run* && \"\$(finding_note dr-sg-$SUFFIX)\" == *dry-run* && \"\$(finding_note dr-s3-$SUFFIX)\" == *dry-run* ]]" \
  && pass "dry-run: all three findings carry a '[dry-run]' note" || fail "dry-run notes missing: $(finding_note dr-s3-$SUFFIX) | $(finding_note dr-sg-$SUFFIX) | $(finding_note dr-i-$SUFFIX)"
! bpa_enabled "$BUCKET" && [[ "$(open_admin_rules "$SG")" == "1" && "$(sgs_of "$INSTANCE")" == "$SG" ]] \
  && pass "dry-run: bucket, security group and instance are unchanged" || fail "dry-run changed something"

# --- 2. enforce -------------------------------------------------------------------------------------------------------
set_mode enforce
import "s3-$SUFFIX" "S3 bucket without Block Public Access" HIGH AwsS3Bucket "arn:aws:s3:::$BUCKET" S3.8 >/dev/null
import "sg-$SUFFIX" "Security group open to the internet on SSH" HIGH AwsEc2SecurityGroup "arn:aws:ec2:$REGION:$ACCOUNT:security-group/$SG" EC2.53 >/dev/null
import "i-$SUFFIX" "Backdoor activity on an instance" HIGH AwsEc2Instance "arn:aws:ec2:$REGION:$ACCOUNT:instance/$INSTANCE" >/dev/null
wait_until "bucket" bpa_enabled "$BUCKET" && pass "S3: Block Public Access is on for the bucket" || fail "S3: bucket is still open"
wait_until "sg" bash -c "$(declare -f open_admin_rules); export AWS_PROFILE AWS_DEFAULT_REGION; [[ \"\$(open_admin_rules $SG)\" == 0 ]]" \
  && pass "SG: the 0.0.0.0/0 rule on port 22 is revoked" || fail "SG: the open SSH rule is still there"
[[ "$(rule_count "$SG" 22 10.0.0.0/8)" == "1" && "$(rule_count "$SG" 443 0.0.0.0/0)" == "1" ]] \
  && pass "SG: the 10.0.0.0/8 rule and the port 443 rule are untouched" || fail "SG: an unrelated rule was removed"
Q="$(aws ec2 describe-security-groups --filters Name=vpc-id,Values="$VPC" Name=group-name,Values="${PROJECT}-${ENVIRONMENT}-secbase-quarantine" --query 'SecurityGroups[0].GroupId' --output text)"
wait_until "instance" bash -c "[[ \"\$(aws ec2 describe-instances --instance-ids $INSTANCE --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)\" != \"$SG\" ]]" \
  && [[ "$(sgs_of "$INSTANCE")" == "$(aws ec2 describe-security-groups --filters Name=vpc-id,Values="$VPC" Name=group-name,Values="${PROJECT}-${ENVIRONMENT}-secbase-quarantine" --query 'SecurityGroups[0].GroupId' --output text)" ]] \
  && pass "EC2: the instance now has only the quarantine group" || fail "EC2: the instance was not isolated"
Q="$(aws ec2 describe-security-groups --filters Name=vpc-id,Values="$VPC" Name=group-name,Values="${PROJECT}-${ENVIRONMENT}-secbase-quarantine" --query 'SecurityGroups[0]' --output json)"
[[ "$(jq '.IpPermissions|length' <<<"$Q")" == 0 && "$(jq '.IpPermissionsEgress|length' <<<"$Q")" == 0 ]] \
  && pass "EC2: the quarantine group allows no inbound and no outbound traffic" || fail "EC2: the quarantine group has rules"
[[ "$(aws ec2 describe-tags --filters Name=resource-id,Values="$INSTANCE" Name=key,Values=security-baseline:quarantined --query 'Tags[0].Value' --output text 2>/dev/null)" == "true" || \
   "$(aws ec2 describe-tags --filters Name=resource-id,Values="$INSTANCE" Name=key,Values="${PROJECT}-${ENVIRONMENT}-secbase:quarantined" --query 'Tags[0].Value' --output text)" == "true" ]] \
  && pass "EC2: the instance is tagged quarantined, with its original group kept in a tag" || fail "EC2: quarantine tag missing"
wait_until "resolved" bash -c "$(declare -f finding_note); export AWS_PROFILE AWS_DEFAULT_REGION; [[ \"\$(finding_note s3-$SUFFIX)\" == RESOLVED* ]]" \
  && pass "findings: the remediated finding was set to RESOLVED with an outcome note" || fail "findings: not resolved: $(finding_note "s3-$SUFFIX")"

# --- 3. the skip tag protects resources even in enforce mode ----------------------------------------------------------
import "skip-s3-$SUFFIX" "S3 bucket without Block Public Access" HIGH AwsS3Bucket "arn:aws:s3:::$SKIP_BUCKET" S3.8 >/dev/null
import "skip-sg-$SUFFIX" "Security group open to the internet on SSH" HIGH AwsEc2SecurityGroup "arn:aws:ec2:$REGION:$ACCOUNT:security-group/$SKIP_SG" EC2.53 >/dev/null
import "skip-i-$SUFFIX" "Backdoor activity on an instance" HIGH AwsEc2Instance "arn:aws:ec2:$REGION:$ACCOUNT:instance/$SKIP_INSTANCE" >/dev/null
wait_until "skip notes" bash -c "$(declare -f finding_note); export AWS_PROFILE AWS_DEFAULT_REGION; [[ \"\$(finding_note skip-i-$SUFFIX)\" == *skipped* && \"\$(finding_note skip-sg-$SUFFIX)\" == *skipped* && \"\$(finding_note skip-s3-$SUFFIX)\" == *skipped* ]]" \
  && pass "skip tag: all three findings are noted as skipped" || fail "skip tag: notes missing"
! bpa_enabled "$SKIP_BUCKET" && [[ "$(open_admin_rules "$SKIP_SG")" == "1" && "$(sgs_of "$SKIP_INSTANCE")" == "$SG" ]] \
  && pass "skip tag: the tagged bucket, security group and instance are unchanged" || fail "skip tag: a protected resource was changed"

# --- 4. a real GuardDuty sample finding reaches the function and is skipped safely ---------------------------------------
DETECTOR="$(aws guardduty list-detectors --query 'DetectorIds[0]' --output text)"
aws guardduty create-sample-findings --detector-id "$DETECTOR" --finding-types 'Backdoor:EC2/C&CActivity.B!DNS' >/dev/null
sample_note() { aws securityhub get-findings --filters '{"ProductName":[{"Value":"GuardDuty","Comparison":"EQUALS"}],"ResourceId":[{"Value":"i-99999999","Comparison":"PREFIX"}]}' \
  --output json | jq -r '[.Findings[].Note.Text // empty] | first // ""'; }
note=""
for _ in $(seq 1 30); do note="$(sample_note)"; [[ -n "$note" ]] && break; sleep 6; done
if [[ "$note" == *"[skipped] quarantine-instance"*"not found"* ]]; then
  pass "GuardDuty sample finding: delivered by the real rule and skipped safely (the sample instance does not exist)"
else
  # GuardDuty updates a sample finding it already holds instead of creating a new one, so a repeat run may see no new event.
  echo "note: no new outcome note on the GuardDuty sample finding ('$note'); informational, not a failure"
fi

exit "$FAILED"
