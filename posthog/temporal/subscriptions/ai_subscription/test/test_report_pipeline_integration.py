from posthog.test.base import (
    ClickhouseTestMixin,
    NonAtomicBaseTest,
    _create_event,
    _create_person,
    flush_persons_and_events,
)
from unittest.mock import MagicMock, patch

from posthog.temporal.subscriptions.ai_subscription.report_pipeline import generate_ai_report
from posthog.temporal.subscriptions.ai_subscription.schemas import EnrichedPromptSpec, QueryPlan, QueryPlanStep

_RP = "posthog.temporal.subscriptions.ai_subscription.report_pipeline"


class TestAIReportPipelineIntegration(ClickhouseTestMixin, NonAtomicBaseTest):
    """Exercises the real plan -> execute -> synthesize wiring: only the two LLM boundaries (planner,
    synthesis) are mocked; the planned HogQL runs against the test ClickHouse for real."""

    CLASS_DATA_LEVEL_SETUP = False

    def setUp(self) -> None:
        super().setUp()
        _create_person(team=self.team, distinct_ids=["u1"])
        for _ in range(3):
            _create_event(team=self.team, event="$pageview", distinct_id="u1")
        _create_event(team=self.team, event="signed_up", distinct_id="u1")
        flush_persons_and_events()

    def _spec(self, hogql: str) -> EnrichedPromptSpec:
        return EnrichedPromptSpec(
            cleaned_prompt="how many events",
            context_blob="ctx",
            plan=QueryPlan(
                overall_intent="count events",
                steps=[QueryPlanStep(description="Event counts", hogql=hogql)],
            ),
        )

    def _capture_synthesis(self, mock_chat: MagicMock, report: str) -> dict[str, str]:
        captured: dict[str, str] = {}

        def _invoke(messages: list) -> MagicMock:
            captured["human"] = messages[1][1]
            return MagicMock(content=report)

        mock_chat.return_value.invoke.side_effect = _invoke
        return captured

    @patch(f"{_RP}._capture_report_quality")
    @patch(f"{_RP}.MaxChatOpenAI")
    @patch(f"{_RP}.build_enriched_prompt")
    async def test_real_hogql_results_flow_into_synthesis(
        self, mock_bep: MagicMock, mock_chat: MagicMock, mock_capture: MagicMock
    ) -> None:
        mock_bep.return_value = self._spec("SELECT event, count() AS c FROM events GROUP BY event ORDER BY c DESC")
        captured = self._capture_synthesis(mock_chat, "# Report")

        report = await generate_ai_report(team=self.team, user=self.user, prompt="how many events", window_days=7)

        assert report == "# Report"
        # the planned query actually executed against ClickHouse and its results reached synthesis
        assert "$pageview" in captured["human"]
        assert "signed_up" in captured["human"]

    @patch(f"{_RP}._capture_report_quality")
    @patch(f"{_RP}.MaxChatOpenAI")
    @patch(f"{_RP}.build_enriched_prompt")
    async def test_invalid_hogql_degrades_but_report_still_ships(
        self, mock_bep: MagicMock, mock_chat: MagicMock, mock_capture: MagicMock
    ) -> None:
        # the fix LLM (also MaxChatOpenAI) returns a non-HogQLFix, so the step can't recover and degrades
        mock_chat.return_value.with_structured_output.return_value.invoke.return_value = "not a fix"
        mock_bep.return_value = self._spec("SELECT count() FROM a_table_that_does_not_exist")
        captured = self._capture_synthesis(mock_chat, "# Degraded report")

        report = await generate_ai_report(team=self.team, user=self.user, prompt="x", window_days=7)

        assert report == "# Degraded report"
        assert "_Query failed" in captured["human"]
