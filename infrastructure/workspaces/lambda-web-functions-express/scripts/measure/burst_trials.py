#!/usr/bin/env python3
"""
burst_trials.py

Measures how a *new* Lambda Web Function absorbs repeated bursts while its dynamic
per-environment concurrency limit is still being learned, with and without a client
retry policy (exponential backoff + full jitter).

Lambda remembers the learned limit after an endpoint scales to zero, so a cold trial
needs a brand-new Web Function. Each trial therefore creates its own function
(revision + IamAuth endpoint in one CreateWebFunction call), sends signed requests
straight to the endpoint (no CloudFront / WAF in the path), and deletes it.

Shared scaffolding (a versioned code bucket and an execution role) is created once per
run and always deleted at the end.

Usage:
  python burst_trials.py --profile drillexercises-dev --code-dir ../../cdk.out/asset.<hash> \
      --modes none,retry --trials 3 --bursts 8 --out results/
  # Re-check after the endpoint scaled to zero (learned limit kept or reset?)
  python burst_trials.py ... --modes none --trials 1 --idle-recheck-minutes 10

Requires: boto3 (lambda-web client), aiohttp.
"""
import argparse
import asyncio
import hashlib
import io
import json
import random
import sys
import time
import uuid
import zipfile
from pathlib import Path

import aiohttp
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

EMPTY_SHA256 = hashlib.sha256(b'').hexdigest()
RUNTIME = 'nodejs24.x'


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


# --------------------------------------------------------------------------
# Scaffolding: code bucket + execution role, shared by all trials of a run
# --------------------------------------------------------------------------
class Scaffold:
    def __init__(self, session, region, prefix, code_dir):
        self.s3 = session.client('s3', region_name=region)
        self.iam = session.client('iam')
        self.account = session.client('sts').get_caller_identity()['Account']
        self.region = region
        self.prefix = prefix
        self.code_dir = Path(code_dir)
        self.bucket = f'{prefix}-{self.account}'
        self.role_name = f'{prefix}-exec'
        self.role_arn = None
        self.key = 'code.zip'
        self.version_id = None

    def create(self):
        self.s3.create_bucket(Bucket=self.bucket, CreateBucketConfiguration={'LocationConstraint': self.region})
        self.s3.put_bucket_versioning(Bucket=self.bucket, VersioningConfiguration={'Status': 'Enabled'})
        self.s3.put_bucket_policy(Bucket=self.bucket, Policy=json.dumps({
            'Version': '2012-10-17',
            'Statement': [{
                'Sid': 'AllowLambdaWebFunctionsRead',
                'Effect': 'Allow',
                'Principal': {'Service': 'lambda.amazonaws.com'},
                'Action': ['s3:GetObject', 's3:GetObjectVersion'],
                'Resource': f'arn:aws:s3:::{self.bucket}/*',
                'Condition': {
                    'StringEquals': {'aws:SourceAccount': self.account},
                    # Source ARN is the revision under the function, so it must end with /*
                    'ArnLike': {'aws:SourceArn': f'arn:aws:lambda:{self.region}:{self.account}:web-function/{self.prefix}-*/*'},
                },
            }],
        }))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
            z.write(self.code_dir / 'index.js', 'index.js')
        self.version_id = self.s3.put_object(Bucket=self.bucket, Key=self.key, Body=buf.getvalue())['VersionId']

        self.role_arn = self.iam.create_role(
            RoleName=self.role_name,
            AssumeRolePolicyDocument=json.dumps({
                'Version': '2012-10-17',
                'Statement': [{'Effect': 'Allow', 'Principal': {'Service': 'lambda.amazonaws.com'}, 'Action': 'sts:AssumeRole'}],
            }),
        )['Role']['Arn']
        self.iam.attach_role_policy(
            RoleName=self.role_name, PolicyArn='arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')
        log(f'scaffold created: s3://{self.bucket}, {self.role_arn}; waiting for IAM propagation')
        time.sleep(15)

    def delete(self):
        try:
            versions = self.s3.list_object_versions(Bucket=self.bucket)
            objs = [{'Key': v['Key'], 'VersionId': v['VersionId']}
                    for v in versions.get('Versions', []) + versions.get('DeleteMarkers', [])]
            if objs:
                self.s3.delete_objects(Bucket=self.bucket, Delete={'Objects': objs})
            self.s3.delete_bucket(Bucket=self.bucket)
        except Exception as e:  # keep cleaning up the rest
            log(f'WARN bucket cleanup: {e}')
        try:
            self.iam.detach_role_policy(
                RoleName=self.role_name, PolicyArn='arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')
            self.iam.delete_role(RoleName=self.role_name)
        except Exception as e:
            log(f'WARN role cleanup: {e}')
        log('scaffold deleted')


# --------------------------------------------------------------------------
# One trial = one brand-new Web Function
# --------------------------------------------------------------------------
class TrialFunction:
    def __init__(self, session, region, scaffold, name, max_env, rate_limit):
        self.web = session.client('lambda-web', region_name=region)
        self.logs = session.client('logs', region_name=region)
        self.scaffold = scaffold
        self.name = name
        self.max_env = max_env
        self.rate_limit = rate_limit
        self.domain = None

    def create(self):
        endpoint = {'endpointName': 'measure', 'endpointType': 'HomeRegion', 'authType': 'IamAuth',
                    'autoDeploymentMode': 'LatestRevision'}
        if self.max_env:
            endpoint['scalingConfig'] = {'maxEnvironments': self.max_env}
        if self.rate_limit:
            endpoint['throttleConfig'] = {'rateLimit': self.rate_limit}
        t0 = time.monotonic()
        self.web.create_web_function(
            functionName=self.name,
            revisionConfig={
                'buildConfig': {
                    'codeConfig': {'s3Object': {'bucket': self.scaffold.bucket, 'key': self.scaffold.key,
                                                'versionId': self.scaffold.version_id}},
                    'runtimeConfig': {'runtime': RUNTIME},
                },
                'serviceConfig': {
                    'executionRoleArn': self.scaffold.role_arn,
                    'timeoutSeconds': 30,
                    'maxConcurrencyPerEnvironment': 64,
                    'environmentVariables': {'ENABLE_DEBUG_ROUTES': 'true', 'TABLE_NAME': 'unused'},
                },
            },
            endpointConfig=endpoint,
        )
        while True:
            ep = self.web.get_web_function_endpoint(functionName=self.name, endpointName='measure')
            if ep['state'] == 'Active' and ep['revisionWeights']:
                break
            if ep['state'] == 'Failed':
                raise RuntimeError(f'endpoint failed: {ep["stateReason"]}')
            time.sleep(2)
        self.domain = ep['domainName']
        log(f'{self.name} active in {time.monotonic() - t0:.1f}s ({self.domain})')

    def delete(self):
        try:
            for e in self.web.list_web_function_endpoints(functionName=self.name).get('endpoints', []):
                self.web.delete_web_function_endpoint(functionName=self.name, endpointName=e['endpointName'])
            # Revisions go with the function; wait until the endpoint is gone first.
            for _ in range(60):
                if not self.web.list_web_function_endpoints(functionName=self.name).get('endpoints'):
                    break
                time.sleep(2)
            self.web.delete_web_function(functionName=self.name)
        except Exception as e:
            log(f'WARN delete {self.name}: {e}')
        # The service creates both groups without retention; remove them with the trial.
        for group in (f'/aws/lambda/web/{self.name}', f'/aws/lambda/web/{self.name}.local'):
            try:
                self.logs.delete_log_group(logGroupName=group)
            except self.logs.exceptions.ResourceNotFoundException:
                pass
        log(f'{self.name} deleted')


def sweep_log_groups(session, region, prefix, delay_s):
    """Delete every log group of this run once more after a delay. Execution environments
    outlive a deleted Web Function for a while, and their last log lines recreate
    /aws/lambda/web/<name> and <name>.local without retention (seen for 7 of 8 functions)."""
    logs = session.client('logs', region_name=region)
    log(f'waiting {delay_s}s before the final log group sweep')
    time.sleep(delay_s)
    for page in logs.get_paginator('describe_log_groups').paginate(logGroupNamePrefix=f'/aws/lambda/web/{prefix}-'):
        for g in page['logGroups']:
            logs.delete_log_group(logGroupName=g['logGroupName'])
            log(f'deleted recreated log group {g["logGroupName"]}')


# --------------------------------------------------------------------------
# Load generation
# --------------------------------------------------------------------------
class Client:
    def __init__(self, session, region, domain, retry, max_attempts, base_s, cap_s):
        self.creds = session.get_credentials()
        self.region = region
        self.domain = domain
        self.retry = retry
        self.max_attempts = max_attempts if retry else 1
        self.base_s = base_s
        self.cap_s = cap_s

    def _headers(self, url):
        req = AWSRequest(method='GET', url=url, headers={'X-Amz-Content-SHA256': EMPTY_SHA256})
        SigV4Auth(self.creds.get_frozen_credentials(), 'lambda', self.region).add_auth(req)
        return dict(req.headers)

    @staticmethod
    def retryable(status, error_type):
        # 429: every throttle type. 503: load shedding (no error type) only;
        # Platform.EndpointDisabled (rateLimit=0) does not clear by retrying.
        return status == 429 or (status == 503 and error_type != 'Platform.EndpointDisabled')

    async def call(self, http, path, t_ref):
        url = f'https://{self.domain}{path}'
        sent = time.monotonic()
        attempts = []
        body = None
        for attempt in range(self.max_attempts):
            try:
                async with http.get(url, headers=self._headers(url)) as r:
                    status = r.status
                    error_type = r.headers.get('lambda-web-error-type')
                    body = await r.json(content_type=None) if status == 200 else None
            except Exception as e:  # connection errors count as a failed attempt
                status, error_type = 0, type(e).__name__
            attempts.append({'status': status, 'errorType': error_type})
            if status == 200 or not self.retryable(status, error_type) or attempt == self.max_attempts - 1:
                break
            # Full jitter: sleep uniform(0, min(cap, base * 2^attempt))
            await asyncio.sleep(random.uniform(0, min(self.cap_s, self.base_s * 2 ** attempt)))
        done = time.monotonic()
        return {
            'startS': round(sent - t_ref, 3),
            'latencyS': round(done - sent, 3),
            'status': attempts[-1]['status'],
            'errorType': attempts[-1]['errorType'],
            'attempts': attempts,
            'environmentId': body.get('environmentId') if body else None,
            'inFlight': body.get('inFlight') if body else None,
        }


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    return round(s[min(len(s) - 1, int(round(p / 100 * (len(s) - 1))))], 3)


def summarize(burst, results, t_burst):
    ok = [r for r in results if r['status'] == 200]
    by_status = {}
    for r in results:
        key = f"{r['status']} {r['errorType'] or ''}".strip()
        by_status[key] = by_status.get(key, 0) + 1
    envs = {r['environmentId'] for r in ok}
    return {
        'burst': burst,
        'atS': round(t_burst, 1),
        'requests': len(results),
        'ok': len(ok),
        'okFirstTry': sum(1 for r in results if r['attempts'][0]['status'] == 200),
        'finalByStatus': by_status,
        'attemptsTotal': sum(len(r['attempts']) for r in results),
        'environments': len(envs),
        'maxInFlight': max((r['inFlight'] or 0) for r in ok) if ok else 0,
        'p50S': pct([r['latencyS'] for r in ok], 50),
        'p99S': pct([r['latencyS'] for r in ok], 99),
        'maxS': max((r['latencyS'] for r in ok), default=None),
    }


async def run_bursts(client, label, bursts, parallel, sleep_ms, gap_s, t_ref, out_rows):
    path = f'/debug/sleep?ms={sleep_ms}'
    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout, connector=aiohttp.TCPConnector(limit=0)) as http:
        summaries = []
        for b in range(1, bursts + 1):
            t_burst = time.monotonic() - t_ref
            results = await asyncio.gather(*[client.call(http, path, t_ref) for _ in range(parallel)])
            s = summarize(f'{label}{b}', results, t_burst)
            summaries.append(s)
            for r in results:
                out_rows.append({'burst': s['burst'], **r})
            log(f"  burst {s['burst']}: ok {s['ok']}/{s['requests']} (first try {s['okFirstTry']}), "
                f"envs {s['environments']}, maxInFlight {s['maxInFlight']}, p99 {s['p99S']}s, {s['finalByStatus']}")
            await asyncio.sleep(gap_s)
        return summaries


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--profile', required=True)
    ap.add_argument('--region', default='ap-northeast-1')
    ap.add_argument('--code-dir', required=True, help='directory containing the bundled index.js')
    ap.add_argument('--modes', default='none,retry', help='comma-separated: none, retry')
    ap.add_argument('--trials', type=int, default=3, help='trials per mode (one new function each)')
    ap.add_argument('--bursts', type=int, default=8)
    ap.add_argument('--parallel', type=int, default=100)
    ap.add_argument('--sleep-ms', type=int, default=2000)
    ap.add_argument('--gap-s', type=float, default=3)
    ap.add_argument('--max-environments', type=int, default=3)
    ap.add_argument('--rate-limit', type=int, default=100)
    ap.add_argument('--max-attempts', type=int, default=6)
    ap.add_argument('--backoff-base-s', type=float, default=0.2)
    ap.add_argument('--backoff-cap-s', type=float, default=5)
    ap.add_argument('--idle-recheck-minutes', type=float, default=0,
                    help='after the bursts, stay idle this long and run 2 more bursts on the same function')
    ap.add_argument('--log-sweep-delay-s', type=int, default=180,
                    help='wait before the final log group sweep (deleted functions recreate them)')
    ap.add_argument('--out', default='results')
    args = ap.parse_args()

    session = boto3.Session(profile_name=args.profile)
    prefix = f'lwf-m-{uuid.uuid4().hex[:6]}'
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    scaffold = Scaffold(session, args.region, prefix, args.code_dir)
    run = {'startedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'args': vars(args), 'trials': []}
    rows = []
    try:
        scaffold.create()
        for mode in args.modes.split(','):
            for i in range(1, args.trials + 1):
                fn = TrialFunction(session, args.region, scaffold, f'{prefix}-{mode}-{i}',
                                   args.max_environments, args.rate_limit)
                try:
                    fn.create()
                    client = Client(session, args.region, fn.domain, mode == 'retry',
                                    args.max_attempts, args.backoff_base_s, args.backoff_cap_s)
                    t_ref = time.monotonic()
                    log(f'trial {mode}-{i}')
                    trial_rows = []
                    summaries = asyncio.run(run_bursts(client, '', args.bursts, args.parallel,
                                                       args.sleep_ms, args.gap_s, t_ref, trial_rows))
                    if args.idle_recheck_minutes:
                        log(f'  idle {args.idle_recheck_minutes} min (scale to zero)')
                        time.sleep(args.idle_recheck_minutes * 60)
                        summaries += asyncio.run(run_bursts(client, 'idle', 2, args.parallel,
                                                            args.sleep_ms, args.gap_s, t_ref, trial_rows))
                    for r in trial_rows:
                        rows.append({'mode': mode, 'trial': i, **r})
                    run['trials'].append({'mode': mode, 'trial': i, 'function': fn.name, 'bursts': summaries})
                finally:
                    fn.delete()
    finally:
        scaffold.delete()
        sweep_log_groups(session, args.region, prefix, args.log_sweep_delay_s)
        stamp = time.strftime('%Y%m%dT%H%M%S')
        (out / f'burst-summary-{stamp}.json').write_text(json.dumps(run, indent=2))
        with open(out / f'burst-requests-{stamp}.jsonl', 'w') as f:
            for r in rows:
                f.write(json.dumps(r) + '\n')
        log(f'wrote {out}/burst-*-{stamp}.*')


if __name__ == '__main__':
    sys.exit(main())
