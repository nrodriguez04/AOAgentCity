#!/usr/bin/env python
"""Local entry points (`crewai run`, `uv run run_crew inputs.json`).

On CrewAI AMP, Agent City starts the crew through the deployment's /kickoff
API with the real inputs. Locally, inputs come from a JSON file: the path given
on the command line, or inputs.example.json next to pyproject.toml.
"""

import json
import sys
import warnings
from pathlib import Path

from devlog_crew.crew import DevlogCrew

warnings.filterwarnings("ignore", category=SyntaxWarning, module="pysbd")

EXAMPLE_INPUTS = Path(__file__).resolve().parents[2] / "inputs.example.json"


def load_inputs(path: str | None = None) -> dict[str, str]:
    source = Path(path) if path else EXAMPLE_INPUTS
    return {key: str(value) for key, value in json.loads(source.read_text()).items()}


def run():
    """Run the crew once and print the JSON Agent City would receive."""
    output = DevlogCrew().crew().kickoff(inputs=load_inputs(sys.argv[1] if len(sys.argv) > 1 else None))
    print(output.raw)


def train():
    DevlogCrew().crew().train(n_iterations=int(sys.argv[1]), filename=sys.argv[2], inputs=load_inputs())


def replay():
    DevlogCrew().crew().replay(task_id=sys.argv[1])


def test():
    DevlogCrew().crew().test(n_iterations=int(sys.argv[1]), eval_llm=sys.argv[2], inputs=load_inputs())


def run_with_trigger():
    """CrewAI triggers are not used: Agent City schedules and starts this crew."""
    if len(sys.argv) < 2:
        raise SystemExit("usage: run_with_trigger '<json inputs>'")
    inputs = {key: str(value) for key, value in json.loads(sys.argv[1]).items()}
    return DevlogCrew().crew().kickoff(inputs=inputs)
