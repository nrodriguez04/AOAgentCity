# REVIEW CREW: weekly ParlayLab business review

A CrewAI crew (crews/review, deployed on CrewAI AMP) that writes ParlayLab's weekly business review from what BILLING-01, SUPPORT-01 and GROWTH-01 recorded.

## Job
Every Monday morning, after HQ-01's brief, read ParlayLab's current metrics, the last 7 days of agent activity (metrics, runs, approvals, failures) and the open tasks, then produce:
- a weekly review (markdown): headline numbers and how they moved, what happened in billing and support, what went wrong, and data gaps;
- up to three recommendations, each with the expected effect, the effort, and the metric that will show whether it worked;
- one task per recommendation for Nico, skipping anything already in the open tasks.

## Members
1. **Analyst** measures the week strictly from the data: changes, anomalies, failures, and which numbers are missing or stale.
2. **Strategist** writes the review and the recommendations from the analyst's findings and packages the result.

## Output
A `report` draft and up to three tasks, saved through the gateway with this crew's grants. The run is skipped when ParlayLab has no data yet.

## Limits
Read-only access to Agent City data. No tool with an external effect, and no customer contact.
