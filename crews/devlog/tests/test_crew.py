"""Runs the whole crew with a scripted model in place of Claude (no API key, no network)."""

import json
import re
from pathlib import Path
from typing import Any

import pytest
import yaml
from crewai.llms.base_llm import BaseLLM

from devlog_crew import crew as crew_module
from devlog_crew import result
from devlog_crew.crew import DevlogCrew
from devlog_crew.main import EXAMPLE_INPUTS, load_inputs

PACKAGE = Path(crew_module.__file__).parent
# Agent City follows these task ids for progress (packages/agents/averageoutput/devlog-crew/spec.ts).
TASK_IDS = ["analyze_changes", "write_devlog", "edit_and_package"]

FINAL = {
    "summary": "Devlog 1 drafted: residents can be hired, Aurora geography, undersea canon",
    "drafts": [
        {"kind": "devlog", "channel": "blog", "title": "OTHERLIFE devlog 1: a city that hires its residents", "body_md": "# Devlog 1\n\nThis week..."},
        {"kind": "social_post", "channel": "x", "title": "X post", "body_md": "Devlog 1 is up: residents can now be hired."},
        {"kind": "social_post", "channel": "bluesky", "title": "Bluesky post", "body_md": "Devlog 1: hiring and Aurora's geography."},
        {"kind": "social_post", "channel": "reddit", "title": "Community post", "body_md": "This week in OTHERLIFE..."},
    ],
    "tasks": [{"title": "Review and publish devlog 1", "notes": "Check the hiring claim.", "priority": 2, "due_in_days": 2}],
}


class ScriptedLLM(BaseLLM):
    """Stands in for Claude: answers each task from a script and reports token usage like the real provider."""

    replies: dict[str, Any]
    calls: list[str] = []

    def call(self, messages, tools=None, callbacks=None, available_functions=None, from_task=None, from_agent=None, response_model=None):
        name = getattr(from_task, "name", None) or ""
        self.calls.append(name)
        self._track_token_usage_internal({"input_tokens": 1_000, "output_tokens": 200, "cache_read_input_tokens": 100})
        reply = self.replies[name]
        if response_model is not None:
            return response_model.model_validate(reply)
        text = reply if isinstance(reply, str) else json.dumps(reply)
        return f"Thought: I now know the final answer\nFinal Answer: {text}"

    def supports_function_calling(self) -> bool:
        return False


@pytest.fixture
def scripted(monkeypatch):
    llms: list[ScriptedLLM] = []

    def build_llm():
        llm = ScriptedLLM(
            model="claude-sonnet-5-5",
            replies={"analyze_changes": "## Player-facing\n- Hiring (eabdbda)", "write_devlog": "# Devlog 1\n...", "edit_and_package": FINAL},
            calls=[],
        )
        llms.append(llm)
        return llm

    monkeypatch.setattr(result, "build_llm", build_llm)
    return llms


def placeholders(path: Path) -> set[str]:
    return set(re.findall(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", path.read_text()))


def test_tasks_match_what_agent_city_follows(scripted):
    built = DevlogCrew().crew()
    assert [t.name for t in built.tasks] == TASK_IDS
    assert len(built.agents) == 3
    # Each agent has its own model, so CrewAI does not count one model's usage several times.
    assert len({id(a.llm) for a in built.agents}) == 3


def test_every_placeholder_has_an_input():
    inputs = json.loads(EXAMPLE_INPUTS.read_text())
    used = placeholders(PACKAGE / "config" / "tasks.yaml") | placeholders(PACKAGE / "config" / "agents.yaml")
    assert used == set(inputs), "inputs.example.json and the YAML placeholders must match Agent City's inputs"
    yaml.safe_load((PACKAGE / "config" / "tasks.yaml").read_text())


def test_runs_end_to_end_and_returns_agent_city_json(scripted):
    output = DevlogCrew().crew().kickoff(inputs=load_inputs())
    payload = json.loads(output.raw)
    assert str(output) == output.raw

    assert payload["summary"] == FINAL["summary"]
    assert [d["channel"] for d in payload["drafts"]] == ["blog", "x", "bluesky", "reddit"]
    assert payload["tasks"] == [{"title": "Review and publish devlog 1", "notes": "Check the hiring claim.", "priority": 2, "due_in_days": 2}]
    # Three tasks, one model call each, all reported back for Agent City's budget.
    assert payload["usage"]["models"] == ["claude-sonnet-5-5"]
    assert payload["usage"]["successful_requests"] >= 3
    assert payload["usage"]["prompt_tokens"] >= 3_000
    assert payload["usage"]["completion_tokens"] >= 600
    assert [call for llm in scripted for call in llm.calls][:3] == TASK_IDS


def test_clamps_results_to_agent_citys_limits():
    clamped = result.clamp(
        result.CrewResult(
            summary="x" * 500,
            drafts=[result.Draft(kind="report", channel="  ", title="t" * 300, body_md="body")] * 15,
            tasks=[result.TaskProposal(title="Do it", priority=9, due_in_days=400), result.TaskProposal(title="no")],
        )
    )
    assert len(clamped["summary"]) == 300
    assert len(clamped["drafts"]) == 12
    assert clamped["drafts"][0]["channel"] is None
    assert len(clamped["drafts"][0]["title"]) == 200
    assert clamped["tasks"] == [{"title": "Do it", "notes": None, "priority": 5, "due_in_days": 60}]
