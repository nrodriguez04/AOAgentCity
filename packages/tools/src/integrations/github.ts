import { z } from "zod";
import { defineTool, ToolError, UNTRUSTED_NOTICE } from "../types";

// Read-only GitHub access. Each agent uses its own fine-grained token (spec
// §7.4), scoped to the repositories it may read with Contents: read-only, stored
// in Vault as agent:<agent_id>:github. The token is the real boundary: the tool
// accepts any repository name, GitHub refuses the ones the token cannot see.

interface GitHubCommit {
  sha: string;
  html_url: string;
  parents?: { sha: string }[];
  commit: {
    message: string;
    author?: { name?: string; date?: string } | null;
    committer?: { date?: string } | null;
  };
}

const PAGE_SIZE = 100;
const MAX_PAGES = 3;

export const githubListCommits = defineTool({
  name: "github.list_commits",
  tier: "read",
  integration: "github",
  description:
    "Commits on a GitHub repository branch in the last N days, newest first: short sha, date, author, message and link. Merge commits are marked.",
  schema: z.object({
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .describe("owner/name, e.g. nrodriguez04/AOWorld"),
    branch: z.string().min(1).max(100).optional().describe("Defaults to the repository's default branch"),
    days: z.number().int().min(1).max(31).optional().describe("Look-back window, default 7"),
    limit: z.number().int().min(1).max(300).optional().describe("Default 150"),
  }),
  describe: (a) => `List ${a.repo} commits (last ${a.days ?? 7} days)`,
  async execute(a, ctx) {
    if (!ctx.secret) {
      throw new ToolError("missing_credential", `No GitHub token for ${ctx.agent.id}. Store it in Vault as agent:${ctx.agent.id}:github.`);
    }
    const doFetch = ctx.services.fetch ?? fetch;
    const since = new Date(ctx.now().getTime() - (a.days ?? 7) * 86_400_000).toISOString();
    const limit = a.limit ?? 150;
    const commits: GitHubCommit[] = [];
    for (let page = 1; page <= MAX_PAGES && commits.length < limit; page++) {
      const url = new URL(`https://api.github.com/repos/${a.repo}/commits`);
      url.searchParams.set("since", since);
      url.searchParams.set("per_page", String(PAGE_SIZE));
      url.searchParams.set("page", String(page));
      if (a.branch) url.searchParams.set("sha", a.branch);
      const res = await doFetch(url, {
        headers: {
          Authorization: `Bearer ${ctx.secret}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "agent-city",
        },
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new ToolError(`github_${res.status}`, `GitHub returned ${res.status} for ${a.repo}: ${detail}`);
      }
      const batch = (await res.json()) as GitHubCommit[];
      commits.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return {
      repo: a.repo,
      since,
      notice: UNTRUSTED_NOTICE,
      truncated: commits.length > limit,
      commits: commits.slice(0, limit).map((c) => ({
        sha: c.sha.slice(0, 7),
        date: c.commit.author?.date ?? c.commit.committer?.date ?? null,
        author: c.commit.author?.name ?? null,
        merge: (c.parents?.length ?? 0) > 1,
        message: c.commit.message.slice(0, 2_000),
        url: c.html_url,
      })),
    };
  },
});

export const GITHUB_TOOLS = [githubListCommits];
