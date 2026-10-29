# Measurement scripts

Scripts behind the throttling, retry, streaming and cost numbers of this pattern.
Results of the 2026-10-29 run are in [`results/2026-10-29/`](results/2026-10-29/).

| Script | What it measures | AWS resources it creates |
|---|---|---|
| [`burst_trials.py`](burst_trials.py) | Repeated bursts against a **new** Web Function (cold dynamic limit), with and without client retry (exponential backoff + full jitter) | Per run: a versioned S3 bucket and an execution role; per trial: one Web Function. All deleted at the end, including log groups recreated after deletion |
| [`plot_bursts.py`](plot_bursts.py) | Table (mean / min-max over trials) and chart from a `burst_trials.py` summary | — |
| [`steady_load.py`](steady_load.py) | Open-loop constant rate, then `EndpointActiveEnvironments`, memory and CPU metrics | — (uses the deployed stack) |
| [`cost_model.py`](cost_model.py) | Monthly cost estimate and break-even vs API Gateway / Function URL + Event Functions | — |
| [`sse-check.mjs`](sse-check.mjs) | Whether an SSE stream completed (`event: done`) or was cut by `timeoutSeconds` | — |

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install boto3 aiohttp matplotlib   # boto3 >= 1.43 for lambda-web
```

`burst_trials.py` needs the bundled `index.js`: run `npm run synth` (or deploy) once and pass the
`cdk.out/asset.<hash>` directory that contains it.

## Reproduce

```bash
# V1/V2: 100 parallel 2-second I/O waits, 8 bursts, maxEnvironments 3, rateLimit 100, 3 trials per mode
.venv/bin/python scripts/measure/burst_trials.py --profile ${PROJECT}-${ENV} \
  --code-dir cdk.out/asset.<hash> --modes none,retry --trials 3 --bursts 8 --out results/
.venv/bin/python scripts/measure/plot_bursts.py results/burst-summary-<stamp>.json --chart bursts.png

# Is the learned limit kept after scale to zero?
.venv/bin/python scripts/measure/burst_trials.py --profile ${PROJECT}-${ENV} \
  --code-dir cdk.out/asset.<hash> --modes none --trials 1 --bursts 6 --idle-recheck-minutes 10

# Environments kept under steady traffic (needs the stack deployed and some items in the table)
.venv/bin/python scripts/measure/steady_load.py --profile ${PROJECT}-${ENV} \
  --url https://<DistributionUrl>/todos --function <WebFunctionName> --endpoint dev --rps 2 --minutes 6

# SSE: completes (exit 0) vs truncated by the 30 s timeout (exit 2)
node scripts/measure/sse-check.mjs https://<DistributionUrl> 10 500
node scripts/measure/sse-check.mjs https://<DistributionUrl> 40 1000

.venv/bin/python scripts/measure/cost_model.py --chart cost.png
```

## Conditions of the 2026-10-29 run

- ap-northeast-1, `nodejs24.x` arm64, `maxConcurrencyPerEnvironment` 64, `timeoutSeconds` 30
- Client: one devcontainer (WSL2) in Japan, over the internet. Durations use a monotonic clock —
  the wall clock of this machine jumped by tens of seconds during the run
- `burst_trials.py` signs requests with SigV4 and calls the `IamAuth` endpoint directly (no
  CloudFront / WAF in the path); `steady_load.py` and `sse-check.mjs` go through CloudFront
- Retry policy: retry 429 (any type) and 503 without `lambda-web-error-type`; full jitter
  `uniform(0, min(5 s, 0.2 s × 2^attempt))`; at most 6 attempts. Only idempotent `GET`s are retried
- Cost: list prices from the AWS Price List API on 2026-10-29; free tiers, data transfer and
  DynamoDB excluded. Environment count beyond 20 req/s is extrapolated
