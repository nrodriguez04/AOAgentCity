"""DEVLOG CREW: a weekly OTHERLIFE devlog from the AOWorld commits.

Agent City (packages/agents/averageoutput/devlog-crew) gathers the week's
commits and starts this crew on CrewAI AMP with them as inputs. The crew only
reads its inputs and writes text: Agent City saves the drafts and the review
task through its tool gateway.
"""

from crewai import Agent, Crew, Process, Task
from crewai.agents.agent_builder.base_agent import BaseAgent
from crewai.crews.crew_output import CrewOutput
from crewai.project import CrewBase, after_kickoff, agent, crew, task

from devlog_crew import result


@CrewBase
class DevlogCrew:
    """Analyst, writer and editor."""

    agents: list[BaseAgent]
    tasks: list[Task]

    agents_config = "config/agents.yaml"
    tasks_config = "config/tasks.yaml"

    @agent
    def analyst(self) -> Agent:
        return Agent(config=self.agents_config["analyst"], llm=result.build_llm(), allow_delegation=False)  # type: ignore[index]

    @agent
    def writer(self) -> Agent:
        return Agent(config=self.agents_config["writer"], llm=result.build_llm(), allow_delegation=False)  # type: ignore[index]

    @agent
    def editor(self) -> Agent:
        return Agent(config=self.agents_config["editor"], llm=result.build_llm(), allow_delegation=False)  # type: ignore[index]

    @task
    def analyze_changes(self) -> Task:
        return Task(config=self.tasks_config["analyze_changes"])  # type: ignore[index]

    @task
    def write_devlog(self) -> Task:
        return Task(config=self.tasks_config["write_devlog"])  # type: ignore[index]

    @task
    def edit_and_package(self) -> Task:
        return Task(config=self.tasks_config["edit_and_package"], output_pydantic=result.CrewResult)  # type: ignore[index]

    @after_kickoff
    def package_for_agent_city(self, output: CrewOutput) -> CrewOutput:
        return result.finalize(output)

    @crew
    def crew(self) -> Crew:
        return Crew(agents=self.agents, tasks=self.tasks, process=Process.sequential, verbose=False)
