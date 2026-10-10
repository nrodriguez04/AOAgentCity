"""The result every Agent City crew hands back.

This file is identical in every crew under crews/ (a test checks that), and
mirrors CrewResult in packages/core/src/crews.ts. The crew's last task fills
in CrewResult; `finalize` then clamps it to the contract's limits and adds the
crew's token usage, because CrewAI AMP's status API does not report usage.
Agent City validates the JSON again before saving anything.
"""

from __future__ import annotations

import json
import os
import re
from typing import Literal

from crewai import LLM
from crewai.crews.crew_output import CrewOutput
from pydantic import BaseModel, Field

DEFAULT_MODEL = "anthropic/claude-sonnet-5-5"

DraftKind = Literal["devlog", "social_post", "article", "newsletter", "report", "plan", "other"]


class Draft(BaseModel):
    """A document for Nico to review. Saving it never publishes anything."""

    kind: DraftKind = Field(description="devlog, social_post, article, newsletter, report, plan or other")
    channel: str | None = Field(
        default=None,
        description="Where it would be published: blog, x, bluesky, linkedin, reddit, discord or newsletter. Null for plans and reports.",
    )
    title: str = Field(description="Short title, under 200 characters")
    body_md: str = Field(description="The complete text, in markdown")


class TaskProposal(BaseModel):
    """A task for Nico."""

    title: str = Field(description="Specific and imperative, under 140 characters")
    notes: str | None = Field(default=None, description="Why it matters and how to do it, under 4000 characters")
    priority: int = Field(default=3, description="1 (highest) to 5")
    due_in_days: int | None = Field(default=None, description="Days from today (0 to 60), or null")


class CrewResult(BaseModel):
    """What the crew produced this run."""

    summary: str = Field(description="One line for Agent City's activity feed, under 200 characters")
    drafts: list[Draft] = Field(default_factory=list, description="At most 12")
    tasks: list[TaskProposal] = Field(default_factory=list, description="At most 5")


def model_id() -> str:
    """The model every agent in this crew uses (override with CREW_MODEL)."""
    return os.environ.get("CREW_MODEL", DEFAULT_MODEL)


def build_llm() -> LLM:
    """A fresh model per agent: CrewAI totals usage per agent, so a shared one would be counted several times."""
    return LLM(model=model_id(), max_tokens=16_000)


def _clip(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def clamp(result: CrewResult) -> dict:
    """Fit the result to the limits Agent City enforces, so one long title cannot sink a run."""
    drafts = [
        {
            "kind": d.kind,
            "channel": _clip(d.channel, 40) if d.channel and d.channel.strip() else None,
            "title": _clip(d.title, 200) or "Untitled",
            "body_md": _clip(d.body_md, 40_000),
        }
        for d in result.drafts
        if d.body_md.strip()
    ][:12]
    tasks = [
        {
            "title": _clip(t.title, 140),
            "notes": _clip(t.notes, 4_000) if t.notes else None,
            "priority": min(5, max(1, t.priority)),
            "due_in_days": None if t.due_in_days is None else min(60, max(0, t.due_in_days)),
        }
        for t in result.tasks
        if len(t.title.strip()) >= 3
    ][:5]
    return {"summary": _clip(result.summary, 300) or "Crew run complete", "drafts": drafts, "tasks": tasks}


def _parse(output: CrewOutput) -> CrewResult:
    if isinstance(output.pydantic, CrewResult):
        return output.pydantic
    raw = output.raw or ""
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        raise ValueError("The crew's last task did not return a JSON result")
    return CrewResult.model_validate_json(match.group(0))


def finalize(output: CrewOutput) -> CrewOutput:
    """Make the crew's final output the JSON Agent City expects, with token usage."""
    payload = clamp(_parse(output))
    usage = output.token_usage
    payload["usage"] = {
        "prompt_tokens": usage.prompt_tokens if usage else 0,
        "completion_tokens": usage.completion_tokens if usage else 0,
        "cached_prompt_tokens": usage.cached_prompt_tokens if usage else 0,
        "cache_creation_tokens": getattr(usage, "cache_creation_tokens", 0) if usage else 0,
        "successful_requests": usage.successful_requests if usage else 0,
        "models": [model_id().removeprefix("anthropic/")],
    }
    output.raw = json.dumps(payload, ensure_ascii=False)
    # str(output) is what AMP returns: make it the JSON, not a Python repr.
    output.pydantic = None
    output.json_dict = None
    return output
