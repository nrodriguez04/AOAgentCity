# DEVLOG CREW: weekly OTHERLIFE devlog

A CrewAI crew (crews/devlog, deployed on CrewAI AMP) that turns a week of work on OTHERLIFE (codename AOWorld) into a devlog Nico can publish.

## Job
Every Friday afternoon, read the week's commits to nrodriguez04/AOWorld and produce:
- one devlog post (markdown, about 400-700 words) in Average Output's voice: honest, specific, no hype, no promised dates or features;
- two or three short social posts that point at the devlog;
- one task for Nico to review and publish.

## Members
1. **Analyst** sorts the commits into player-facing changes, world and content work, systems and foundations, and fixes, and says which changes a player could actually see.
2. **Writer** writes the devlog and the social posts from the analyst's notes only.
3. **Editor** checks every claim against the commit list, removes anything the commits do not show, and packages the result.

## Inputs (built by Agent City)
The week's non-merge commits (subject and a trimmed body), the AverageOutput context doc, and the titles of earlier devlogs so numbering and topics continue.

## Output
Drafts (`devlog` for the blog, `social_post` per channel) and a review task, saved through the gateway with this crew's grants. Nothing is published: publishing will be a separate, approval-gated action.

## Limits
Read-only GitHub token for AOWorld only. No tool with an external effect.
