# Deployment policy (Infrastructure team)

Production deployments are frozen every Friday after 15:00 JST and during the last business day of each month.

Every production release is a canary release: 10 percent of traffic for 30 minutes, then the full rollout.
If the error rate of the canary exceeds 1 percent, the release is rolled back automatically within 5 minutes.

Emergency fixes during a freeze need approval from the infrastructure manager and a second reviewer.
