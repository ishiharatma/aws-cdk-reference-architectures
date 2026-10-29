#!/usr/bin/env python3
"""
plot_bursts.py

Turns a burst_trials.py summary into the per-mode table (mean / min / max over trials)
and a chart: accepted requests per burst and requests in flight per environment, over
time since the Web Function was created.

Usage:
  python plot_bursts.py results/burst-summary-<stamp>.json --chart bursts.png
"""
import argparse
import json
from collections import defaultdict


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('summary')
    ap.add_argument('--chart')
    args = ap.parse_args()
    run = json.load(open(args.summary))

    by_mode = defaultdict(list)
    for t in run['trials']:
        by_mode[t['mode']].append(t['bursts'])

    print('| Mode | Burst | Start (s, mean) | OK / 100 (mean, min-max) | OK on 1st try (mean) | '
          'Attempts (mean) | In flight per env (max) | p99 of OK (s, mean) |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|')
    for mode, trials in by_mode.items():
        for i in range(len(trials[0])):
            rows = [t[i] for t in trials]
            mean = lambda k: sum(r[k] for r in rows) / len(rows)  # noqa: E731
            oks = [r['ok'] for r in rows]
            print(f"| {mode} | {rows[0]['burst']} | {mean('atS'):.1f} | {mean('ok'):.1f} ({min(oks)}-{max(oks)}) | "
                  f"{mean('okFirstTry'):.1f} | {mean('attemptsTotal'):.0f} | {max(r['maxInFlight'] for r in rows)} | "
                  f"{mean('p99S'):.2f} |")
        total_ok = [sum(b['ok'] for b in t) for t in trials]
        total_req = sum(b['requests'] for b in trials[0])
        total_att = [sum(b['attemptsTotal'] for b in t) for t in trials]
        print(f"| {mode} | total | | {sum(total_ok) / len(total_ok):.1f} / {total_req} "
              f"({min(total_ok)}-{max(total_ok)}) | | {sum(total_att) / len(total_att):.0f} | | |")

    if args.chart:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt

        colors = {'none': '#d62728', 'retry': '#1f77b4'}
        labels = {'none': 'no retry', 'retry': 'retry (full jitter, max 6 attempts)'}
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 4.8))
        for mode, trials in by_mode.items():
            for n, t in enumerate(trials):
                xs = [b['atS'] for b in t]
                kw = {'color': colors.get(mode), 'alpha': 0.8, 'marker': 'o', 'ms': 4,
                      'label': labels.get(mode, mode) if n == 0 else None}
                ax1.plot(xs, [b['ok'] for b in t], **kw)
                ax2.plot(xs, [b['maxInFlight'] for b in t], **kw)
        ax1.set_title('Accepted requests per burst of 100 (maxEnvironments 3)')
        ax1.set_ylabel('HTTP 200 out of 100')
        ax2.set_title('Max requests in flight per environment')
        ax2.set_ylabel('in flight')
        for ax in (ax1, ax2):
            ax.set_xlabel('Seconds since the new Web Function became active')
            ax.grid(True, alpha=0.3)
            ax.legend(loc='lower right', fontsize=8)
        ax1.set_ylim(0, 105)
        fig.tight_layout()
        fig.savefig(args.chart, dpi=130)
        print(f'\nchart: {args.chart}')


if __name__ == '__main__':
    main()
