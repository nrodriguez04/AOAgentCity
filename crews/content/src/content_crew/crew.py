"""CONTENT CREW: the week's CreatorOS content plan and posts.

Agent City (packages/agents/creatoros/content-crew) gathers the strategy doc,
the week's highlights across the divisions and recent drafts, and starts this
crew on CrewAI AMP with them as inputs. The crew only writes text: Agent City
saves the plan, the posts and the review tasks through its tool gateway.
Nothing is posted without Nico.
"""

from crewai import Agent, Crew, Process, Task
from crewai.agents.agent_builder.base_agent import BaseAgent
from crewai.crews.crew_output import CrewOutput
from crewai.project import CrewBase, after_kickoff, agent, crew, task

from content_crew import result


@CrewBase
class ContentCrew:
    """Strategist, writer and editor."""

    agents: list[BaseAgent]
    tasks: list[Task]

    agents_config = "config/agents.yaml"
    tasks_config = "config/tasks.yaml"

    @agent
    def strategist(self) -> Agent:
        return Agent(config=self.agents_config["strategist"], llm=result.build_llm(), allow_delegation=False)  # type: ignore[index]

    @agent
    def writer(self) -> Agent:
        return Agent(config=self.agents_config["writer"], llm=result.build_llm(), allow_delegation=False)  # type: ignore[index]

    @agent
    def editor(self) -> Agent:
        return Agent(config=self.agents_config["editor"], llm=result.build_llm(), allow_delegation=False)  # type: ignore[index]

    @task
    def plan_week(self) -> Task:
        return Task(config=self.tasks_config["plan_week"])  # type: ignore[index]

    @task
    def write_posts(self) -> Task:
        return Task(config=self.tasks_config["write_posts"])  # type: ignore[index]

    @task
    def edit_and_package(self) -> Task:
        return Task(config=self.tasks_config["edit_and_package"], output_pydantic=result.CrewResult)  # type: ignore[index]

    @after_kickoff
    def package_for_agent_city(self, output: CrewOutput) -> CrewOutput:
        return result.finalize(output)

    @crew
    def crew(self) -> Crew:
        return Crew(agents=self.agents, tasks=self.tasks, process=Process.sequential, verbose=False)
