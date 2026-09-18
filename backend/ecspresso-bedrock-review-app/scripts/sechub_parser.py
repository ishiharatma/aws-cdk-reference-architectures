#!/usr/bin/env python3
"""Trivy の JSON スキャン結果を AWS Security Finding Format (ASFF) に変換する。

参考実装:
  https://aws.amazon.com/jp/blogs/security/how-to-build-ci-cd-pipeline-container-vulnerability-scanning-trivy-and-aws-security-hub/
  https://github.com/aws-samples/aws-security-hub-scan-with-trivy/blob/master/sechub_parser.py

元記事のスクリプトが前提にしていた Trivy 出力（`data[0]['Vulnerabilities']`)は
古い形式のため、本スクリプトは現行の Trivy JSON 出力（`Results[].Vulnerabilities[]`）
に合わせて読み替えている。

SECURITYHUB_IMPORT_ENABLED=true の場合のみ BatchImportFindings で Security Hub へ
実送信する。既定（未設定 / true 以外）では ASFF への変換結果を標準出力に
ログ出力するだけで、Security Hub への送信は行わない。
"""
import datetime
import json
import os

import boto3

# Trivy severity → ASFF Severity（元記事の重み付けを踏襲）
TRIVY_SEVERITY_TO_ASFF = {
    'LOW': 1,
    'MEDIUM': 4,
    'HIGH': 7,
    'CRITICAL': 9,
}
# BatchImportFindings は1リクエストあたり最大100件までしか受け付けない
BATCH_SIZE = 100


def iter_vulnerabilities(trivy_report):
    """Trivy v0.18+ の `Results[].Vulnerabilities[]` から脆弱性を1件ずつ返す。"""
    for result in trivy_report.get('Results') or []:
        target = result.get('Target', '')
        for vuln in result.get('Vulnerabilities') or []:
            yield target, vuln


def to_asff_finding(target, vuln, *, aws_region, aws_account_id, container_name,
                     container_tag, generator_id, iso8601_time):
    cve_id = str(vuln.get('VulnerabilityID', 'UNKNOWN'))
    title = str(vuln.get('Title') or cve_id)
    description = str(vuln.get('Description') or '')
    # ASFF の Description は 1024 文字まで
    description = (description[:1021] + '..') if len(description) > 1021 else description
    package_name = str(vuln.get('PkgName', 'unknown'))
    installed_version = str(vuln.get('InstalledVersion', 'unknown'))
    fixed_version = str(vuln.get('FixedVersion', 'not fixed'))
    severity = str(vuln.get('Severity', 'LOW')).upper()
    references = vuln.get('References') or []
    reference_url = str(references[0]) if references else f'https://nvd.nist.gov/vuln/detail/{cve_id}'

    product_severity = TRIVY_SEVERITY_TO_ASFF.get(severity, 1)
    normalized_severity = product_severity * 10

    return {
        'SchemaVersion': '2018-10-08',
        'Id': f'{container_name}:{container_tag}/{target}/{cve_id}',
        'ProductArn': f'arn:aws:securityhub:{aws_region}::product/aquasecurity/aquasecurity',
        'GeneratorId': generator_id,
        'AwsAccountId': aws_account_id,
        'Types': ['Software and Configuration Checks/Vulnerabilities/CVE'],
        'CreatedAt': iso8601_time,
        'UpdatedAt': iso8601_time,
        'Severity': {'Product': product_severity, 'Normalized': normalized_severity},
        'Title': f'Trivy found a vulnerability to {cve_id} in container {container_name}',
        'Description': description,
        'Remediation': {
            'Recommendation': {
                'Text': 'More information on this vulnerability is provided in the hyperlink',
                'Url': reference_url,
            }
        },
        'ProductFields': {'Product Name': 'Trivy'},
        'Resources': [
            {
                'Type': 'Container',
                'Id': f'{container_name}:{container_tag}',
                'Partition': 'aws',
                'Region': aws_region,
                'Details': {
                    'Container': {'ImageName': f'{container_name}:{container_tag}'},
                    'Other': {
                        'CVE ID': cve_id,
                        'CVE Title': title,
                        'Installed Package': f'{package_name} {installed_version}',
                        'Patched Package': f'{package_name} {fixed_version}',
                    },
                },
            },
        ],
        'RecordState': 'ACTIVE',
    }


def chunked(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def main():
    results_file = os.environ.get('TRIVY_RESULTS_FILE', 'results.json')
    import_enabled = os.environ.get('SECURITYHUB_IMPORT_ENABLED', 'false').strip().lower() == 'true'
    container_name = os.environ.get('CONTAINER_NAME') or os.environ.get('ECR_REPO_URI', 'unknown')
    container_tag = os.environ.get('CONTAINER_TAG') or os.environ.get('IMAGE_TAG', 'latest')
    aws_region = os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION')
    generator_id = os.environ.get('CODEBUILD_BUILD_ARN', 'sechub_parser.py')

    if not os.path.exists(results_file):
        print(f'Trivy results file not found: {results_file} — nothing to convert.')
        return

    with open(results_file) as f:
        trivy_report = json.load(f)

    vulnerabilities = list(iter_vulnerabilities(trivy_report))
    if not vulnerabilities:
        print('No vulnerabilities found in Trivy results. Nothing to convert.')
        return

    sts = boto3.client('sts')
    aws_account_id = sts.get_caller_identity()['Account']
    iso8601_time = datetime.datetime.now(datetime.timezone.utc).isoformat()

    findings = [
        to_asff_finding(
            target, vuln,
            aws_region=aws_region,
            aws_account_id=aws_account_id,
            container_name=container_name,
            container_tag=container_tag,
            generator_id=generator_id,
            iso8601_time=iso8601_time,
        )
        for target, vuln in vulnerabilities
    ]

    print(f'Converted {len(findings)} Trivy finding(s) to ASFF.')

    if not import_enabled:
        print('SECURITYHUB_IMPORT_ENABLED is not "true" — skipping Security Hub import; logging ASFF findings only.')
        print(json.dumps(findings, indent=2, ensure_ascii=False))
        return

    securityhub = boto3.client('securityhub')
    for batch in chunked(findings, BATCH_SIZE):
        try:
            response = securityhub.batch_import_findings(Findings=batch)
            print(f'Imported {len(batch)} finding(s) to Security Hub: '
                  f'{response["SuccessCount"]} succeeded, {response["FailedCount"]} failed.')
            if response['FailedCount'] > 0:
                print(json.dumps(response['FailedFindings'], indent=2, ensure_ascii=False))
        except Exception as e:
            print(f'Failed to import findings to Security Hub: {e}')
            raise


if __name__ == '__main__':
    main()
