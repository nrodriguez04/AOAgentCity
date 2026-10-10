"""REVIEW CREW: ParlayLab's weekly business review.

Agent City (packages/agents/parlaylab/review-crew) gathers ParlayLab's metrics,
the week's agent activity and the open tasks, and starts this crew on CrewAI
AMP with them as inputs. The crew only writes text: Agent City saves the review
and the recommended tasks through its tool gateway.
"""

from crewai import Agent, Crew, Process, Task
from crewai.agents.agent_builder.base_agent import BaseAgent
from crewai.crews.crew_output import CrewOutput
from crewai.project import CrewBase, after_kickoff, agent, crew, task

from review_crew import result


@CrewBase
class ReviewCrew:
    """Analyst and strategist."""

    agents: list[BaseAgent]
    tasks: list[Task]

    agents_config = "config/agents.yaml"
    tasks_config = "config/tasks.yaml"

    @agent
    def analyst(self) -> Agent:
        return Agent(config=self.agents_config["analyst"], llm=result.build_llm(), allow_delegation=False)  # type: ignore[index]

    @agent
    def strategist(self) -> Agent:
        return Agent(config=self.agents_config["strategist"], llm=result.build_llm(), allow_delegation=False)  # type: ignore[index]

    @task
    def analyze_week(self) -> Task:
        return Task(config=self.tasks_config["analyze_week"])  # type: ignore[index]

    @task
    def write_review(self) -> Task:
        return Task(config=self.tasks_config["write_review"], output_pydantic=result.CrewResult)  # type: ignore[index]

    @after_kickoff
    def package_for_agent_city(self, output: CrewOutput) -> CrewOutput:
        return result.finalize(output)

    @crew
    def crew(self) -> Crew:
        # No memory or knowledge sources: the crew keeps no vector store, so CrewAI's
        # chromadb dependency never runs (its open advisories concern Chroma servers).
        return Crew(agents=self.agents, tasks=self.tasks, process=Process.sequential, memory=False, verbose=False)
