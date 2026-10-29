#!/usr/bin/env python3
"""
cost_model.py

Monthly cost model: Lambda Web Functions vs. API Gateway / Function URL + Lambda Event
Functions for the same HTTP API, as a function of monthly requests and per-request
duration (time the function spends on a request, mostly I/O wait for a CRUD API).

Everything is an estimate (試算) built from list prices and a few measured inputs; the
measured inputs are marked below. Free tiers, data transfer (similar for every option)
and DynamoDB are excluded.

Usage:
  python cost_model.py                       # tables to stdout
  python cost_model.py --chart out.png       # also draw monthly cost vs requests
"""
import argparse
import math

# ---- List prices: ap-northeast-1, AWS Price List API, retrieved 2026-10-29 ---------------
PRICE = {
    'wf_request': 0.30e-6,           # APN1-Lambda-Web-Request-ARM
    'wf_vcpu_s': 0.0000322421,       # APN1-Lambda-Web-vCPU-Second-ARM
    'wf_mem_gb_s': 0.0000042688,     # APN1-Lambda-Web-Memory-GB-Second-ARM
    'ev_request': 0.20e-6,           # APN1-Request-ARM
    'ev_gb_s': 0.0000133334,         # APN1-Lambda-GB-Second-ARM (tier 1)
    'apigw_rest': 4.25e-6,           # APN1-ApiGatewayRequest (first 333M)
    'apigw_http': 1.29e-6,           # APN1-ApiGatewayHttpRequest (first 300M)
    'cf_https': 1.20e-6,             # JP-Requests-Tier2-HTTPS
    'waf_request': 0.60e-6,          # Global-RequestV2-Tier1
    'waf_web_acl': 5.0,              # Global-WebACLV2, per month
    'waf_rule': 1.0,                 # Rule, per month
}

# ---- Inputs measured in this repository (ap-northeast-1) -----------------------------------
# steady_load.py, 2026-10-29: /todos (DynamoDB scan of 20 items) through CloudFront at 2 and
# 20 req/s for 6 minutes each. CPU per request and idle CPU per environment-second are a fit
# of EnvironmentCPUTime to those two runs (two points: an estimate, not a benchmark).
MEASURED = {
    'wf_cpu_s_per_request': 0.0020,      # ~2.0 ms CPU per request
    'wf_idle_cpu_s_per_env_s': 0.0074,   # ~7.4 ms CPU per environment-second without requests
    'wf_mem_gb_per_env': 0.3,            # EnvironmentMaxMemoryUsage 183-206 MB at 2 req/s, 431 MB at 20 req/s
    'ev_duration_s': 0.0156,             # same route on Event Function (LWA), billed duration
    'ev_mem_gb': 0.25,                   # 256 MB arm64
    'waf_rules': 4,                      # rate limit, 2 managed rule groups, IP allow list
}

# Environments the endpoint keeps while traffic flows (EndpointActiveEnvironments):
# 2 req/s -> 1 environment, 20 req/s -> 2 environments (second one after ~4 minutes).
# Beyond 20 req/s the request-rate rule below is an extrapolation.
DEFAULT_MIN_ENVS = 1
DEFAULT_RPS_PER_ENV = 10
DEFAULT_CONC_PER_ENV = 30                # learned dynamic limit seen for I/O-bound requests (30-37)


def wf_environments(requests, duration_s, active_hours, min_envs, conc_per_env, rps_per_env=DEFAULT_RPS_PER_ENV):
    rate = requests / (active_hours * 3600)
    return max(min_envs, math.ceil(rate / rps_per_env), math.ceil(rate * duration_s / conc_per_env))


def costs(requests, duration_s, active_hours=730, min_envs=DEFAULT_MIN_ENVS, conc_per_env=DEFAULT_CONC_PER_ENV):
    """Monthly USD per option. `duration_s` is time spent per request inside the function."""
    r = requests
    envs = wf_environments(r, duration_s, active_hours, min_envs, conc_per_env) if r else 0
    wf = (r * PRICE['wf_request']
          + r * MEASURED['wf_cpu_s_per_request'] * PRICE['wf_vcpu_s']   # waiting is not billed as vCPU
          + envs * active_hours * 3600 * (MEASURED['wf_mem_gb_per_env'] * PRICE['wf_mem_gb_s']
                                          + MEASURED['wf_idle_cpu_s_per_env_s'] * PRICE['wf_vcpu_s']))
    ev = r * PRICE['ev_request'] + r * duration_s * MEASURED['ev_mem_gb'] * PRICE['ev_gb_s']
    cf = r * PRICE['cf_https']
    waf = r * PRICE['waf_request'] + PRICE['waf_web_acl'] + MEASURED['waf_rules'] * PRICE['waf_rule']
    return {
        'WF direct': wf,
        'WF + CloudFront': wf + cf,
        'WF + CloudFront + WAF': wf + cf + waf,
        'HTTP API + EF': r * PRICE['apigw_http'] + ev,
        'REST API + EF (LWA)': r * PRICE['apigw_rest'] + ev,
        'CloudFront + Function URL + EF': cf + ev,
        'CloudFront + Function URL + EF + WAF': cf + ev + waf,
    }


# Like-for-like pairs: same front door (or none) on both sides.
PAIRS = [
    ('WF direct', 'HTTP API + EF'),
    ('WF direct', 'REST API + EF (LWA)'),
    ('WF + CloudFront + WAF', 'REST API + EF (LWA)'),
    ('WF + CloudFront', 'CloudFront + Function URL + EF'),
]


def breakeven(a, b, duration_s, **kw):
    """Smallest monthly request count (1k..10B) from which `a` is cheaper than `b` (0 = already
    at 1k), else None. Web Functions has the higher fixed part and the lower or equal
    per-request part in these pairs, so the first crossing is the break-even."""
    grid = [10 ** (3 + i / 200) for i in range(0, 1401)]
    for i, r in enumerate(grid):
        c = costs(r, duration_s, **kw)
        if c[a] < c[b]:
            return 0 if i == 0 else r
    return None


def fmt_req(r):
    if r is None:
        return 'never (in 1k-10B)'
    if r == 0:
        return 'always'
    return f'{r / 1e6:,.1f}M' if r >= 1e6 else f'{r / 1e3:,.0f}k'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--chart', help='write a PNG chart to this path')
    ap.add_argument('--min-envs', type=int, default=DEFAULT_MIN_ENVS)
    ap.add_argument('--conc-per-env', type=int, default=DEFAULT_CONC_PER_ENV)
    args = ap.parse_args()
    kw = {'min_envs': args.min_envs, 'conc_per_env': args.conc_per_env}

    volumes = [1e5, 1e6, 5e6, 1e7, 5e7, 1e8]
    durations = [MEASURED['ev_duration_s'], 0.1, 0.5, 2.0]

    for d in durations:
        print(f'\n### Monthly cost (USD), duration {d * 1000:g} ms per request')
        names = list(costs(1, d, **kw))
        print('| Option | ' + ' | '.join(fmt_req(v) for v in volumes) + ' |')
        print('|---|' + '---:|' * len(volumes))
        for n in names:
            print(f'| {n} | ' + ' | '.join(f'{costs(v, d, **kw)[n]:,.2f}' for v in volumes) + ' |')

    print('\n### Break-even: monthly requests from which Web Functions is cheaper')
    print('| Pair | ' + ' | '.join(f'{d * 1000:g} ms' for d in durations) + ' |')
    print('|---|' + '---:|' * len(durations))
    for a, b in PAIRS:
        print(f'| {a} vs {b} | ' + ' | '.join(fmt_req(breakeven(a, b, d, **kw)) for d in durations) + ' |')

    if args.chart:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt

        xs = [10 ** (4 + i / 20) for i in range(0, 81)]
        panels = [MEASURED['ev_duration_s'], 0.5]
        fig, axes = plt.subplots(1, 2, figsize=(13, 5), sharey=True)
        styles = {
            'WF direct': ('#1f77b4', '-'), 'WF + CloudFront': ('#1f77b4', '--'),
            'WF + CloudFront + WAF': ('#1f77b4', ':'), 'HTTP API + EF': ('#d62728', '-'),
            'REST API + EF (LWA)': ('#d62728', '--'), 'CloudFront + Function URL + EF': ('#2ca02c', '--'),
            'CloudFront + Function URL + EF + WAF': ('#2ca02c', ':'),
        }
        for ax, d in zip(axes, panels):
            for name, (color, ls) in styles.items():
                ax.plot([x / 1e6 for x in xs], [costs(x, d, **kw)[name] for x in xs], color=color, ls=ls, label=name)
            ax.set_xscale('log')
            ax.set_yscale('log')
            ax.set_title(f'{d * 1000:g} ms per request (estimate, ap-northeast-1)')
            ax.set_xlabel('Requests per month (millions)')
            ax.grid(True, which='both', alpha=0.3)
        axes[0].set_ylabel('USD per month')
        axes[1].legend(fontsize=8, loc='upper left')
        fig.tight_layout()
        fig.savefig(args.chart, dpi=130)
        print(f'\nchart: {args.chart}')


if __name__ == '__main__':
    main()
