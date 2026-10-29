#!/usr/bin/env python3
"""
steady_load.py

Sends a constant request rate (open loop) to a URL for a fixed time, then reads how many
execution environments the endpoint kept and how much memory they consumed. These two
numbers drive the memory part of the Web Functions bill (consumed memory x environment
lifetime), which cost_model.py needs as an input.

Usage:
  python steady_load.py --profile drillexercises-dev --url https://dxxxx.cloudfront.net/todos \
      --function drillexercises-dev-lwf-todos --endpoint dev --rps 5 --minutes 6
"""
import argparse
import asyncio
import datetime as dt
import json
import time

import aiohttp
import boto3


async def drive(url, rps, seconds):
    stats = {'sent': 0, 'byStatus': {}, 'latencies': []}

    async def one(http):
        t0 = time.monotonic()
        try:
            async with http.get(url) as r:
                await r.read()
                status = r.status
        except Exception as e:
            status = type(e).__name__
        stats['byStatus'][str(status)] = stats['byStatus'].get(str(status), 0) + 1
        stats['latencies'].append(time.monotonic() - t0)

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as http:
        tasks = []
        start = time.monotonic()
        # Open loop: schedule on a fixed clock regardless of response time.
        while (elapsed := time.monotonic() - start) < seconds:
            tasks.append(asyncio.create_task(one(http)))
            stats['sent'] += 1
            await asyncio.sleep(max(0, stats['sent'] / rps - (time.monotonic() - start)))
        await asyncio.gather(*tasks)
    lat = sorted(stats.pop('latencies'))
    stats['p50S'] = round(lat[len(lat) // 2], 3)
    stats['p99S'] = round(lat[int(len(lat) * 0.99)], 3)
    return stats


def metrics(session, region, function, endpoint, start, end):
    cw = session.client('cloudwatch', region_name=region)
    queries = [
        ('envs', 'AWS/Lambda/Web/Usage', 'EndpointActiveEnvironments', 'Maximum',
         [{'Name': 'FunctionName', 'Value': function}, {'Name': 'EndpointName', 'Value': endpoint}]),
        ('memMax', 'AWS/Lambda/Web', 'EnvironmentMaxMemoryUsage', 'Maximum',
         [{'Name': 'FunctionName', 'Value': function}]),
        ('cpuS', 'AWS/Lambda/Web', 'EnvironmentCPUTime', 'Sum', [{'Name': 'FunctionName', 'Value': function}]),
        ('activeS', 'AWS/Lambda/Web', 'EnvironmentActiveTime', 'Sum', [{'Name': 'FunctionName', 'Value': function}]),
        ('requests', 'AWS/Lambda/Web', 'ExecutedRequests', 'Sum', [{'Name': 'FunctionName', 'Value': function}]),
    ]
    out = {}
    for key, ns, name, stat, dims in queries:
        # Dimension sets differ per metric; match any metric with this name whose dims include ours.
        listed = cw.list_metrics(Namespace=ns, MetricName=name, RecentlyActive='PT3H')['Metrics']
        series = []
        for m in listed:
            names = {d['Name']: d['Value'] for d in m['Dimensions']}
            if all(names.get(d['Name']) == d['Value'] for d in dims):
                pts = cw.get_metric_statistics(Namespace=ns, MetricName=name, Dimensions=m['Dimensions'],
                                               StartTime=start, EndTime=end, Period=60, Statistics=[stat])
                series.append({'dimensions': m['Dimensions'],
                               'points': sorted(((p['Timestamp'].strftime('%H:%M'), p[stat]) for p in pts['Datapoints']))})
        out[key] = series
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--profile', required=True)
    ap.add_argument('--region', default='ap-northeast-1')
    ap.add_argument('--url', required=True)
    ap.add_argument('--function', required=True)
    ap.add_argument('--endpoint', required=True)
    ap.add_argument('--rps', type=float, default=5)
    ap.add_argument('--minutes', type=float, default=6)
    ap.add_argument('--metrics-delay-s', type=int, default=180, help='wait for CloudWatch before reading metrics')
    args = ap.parse_args()

    session = boto3.Session(profile_name=args.profile)
    start = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)
    load = asyncio.run(drive(args.url, args.rps, args.minutes * 60))
    end = dt.datetime.now(dt.timezone.utc)
    time.sleep(args.metrics_delay_s)
    print(json.dumps({'args': vars(args), 'start': start.isoformat(), 'end': end.isoformat(), 'load': load,
                      'metrics': metrics(session, args.region, args.function, args.endpoint,
                                         start, end + dt.timedelta(minutes=2))}, indent=1, default=str))


if __name__ == '__main__':
    main()
