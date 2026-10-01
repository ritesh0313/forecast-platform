# Delivery milestones

The scaffold supplies the implementation for each area below. Connecting it to the existing application and proving accuracy on the actual business series remains necessary because neither source repository nor historical dataset was supplied.

| Milestone | Acceptance criteria | Suggested effort at 10–15 hours/week |
| --- | --- | --- |
| 1. Data and business contract | Map timestamp/target/series ID; verify timezone, cadence, missing periods, units and history length; agree horizon, refresh cadence and business error target; run data inspection | Week 1, 10–12 hours |
| 2. Forecast benchmark | Reproduce chronological baseline and neural-network runs on real data; compare per-horizon MAE/RMSE/sMAPE/MASE; review interval coverage; keep locked final test period untouched during tuning | Week 2, 12–15 hours |
| 3. Existing-platform integration | Adapt JWT claims to identity provider; migrate tables; embed API routes and React components; verify tenant isolation, ingestion conflicts, durable jobs, retries and stored-run retrieval | Week 3, 10–15 hours |
| 4. Operational launch | Agree model promotion policy; load-test and size limits; add identity-provider sign-in, TLS, backups, retention, telemetry and alert thresholds; shadow live predictions against actuals | Week 4, 10–15 hours |
| 5. Ongoing iteration | Review drift and residuals; add only information available at forecast time; compare changes against locked baselines; introduce exogenous features, multiple series or sequence models if evidence supports them | Recurring weekly allocation |

Timing is a planning estimate, not evidence that business accuracy or production readiness has been established. Validation should guide model choice: a neural network is not presumed better than the baselines.
