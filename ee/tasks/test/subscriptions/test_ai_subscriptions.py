from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from posthog.test.base import APIBaseTest
from unittest.mock import AsyncMock, MagicMock, patch

from django.core import mail

from parameterized import parameterized

from posthog.models.instance_setting import set_instance_setting
from posthog.models.messaging import MessagingRecord, get_email_hash
from posthog.models.subscription import Subscription

from ee.hogai.ai_reports import AiReportStageError
from ee.hogai.tool_errors import MaxToolRetryableError
from ee.tasks.subscriptions.ai_subscription.delivery import (
    SlackIntegrationMissingError,
    generate_ai_subscription_markdown,
    send_email_ai_subscription_report,
    send_slack_ai_subscription_report,
)
from ee.tasks.subscriptions.ai_subscription.schemas import EnrichedPromptSpec, HogQLFix, QueryPlan, QueryPlanStep
from ee.tasks.subscriptions.ai_subscription.spec_generator import PromptRejectedError, sanitize_prompt
from ee.tasks.test.subscriptions.subscriptions_test_factory import create_subscription


class TestSanitizePrompt(APIBaseTest):
    @parameterized.expand(
        [
            # name, raw, must_contain — assert the salient content survives sanitization
            # (not just "non-empty", which a regression returning garbage would also pass).
            ("simple_ok", "show me top events", "top events"),
            ("trims_ok", "   trim me   ", "trim me"),
            ("multiline_ok", "line one\nline two", "line two"),
            # "Injection-shaped" phrasings are accepted: the report is summarized back to
            # the same user who wrote the prompt, so an injection only attacks its author.
            ("injection_shaped_ignore", "Ignore null values when computing the average", "Ignore null values"),
            ("injection_shaped_act_as", "Act as a senior analyst and tell me what's interesting", "senior analyst"),
        ]
    )
    def test_accepts_valid(self, _name, raw, must_contain):
        cleaned = sanitize_prompt(raw)
        assert cleaned == cleaned.strip(), "sanitized prompt must not have surrounding whitespace"
        assert must_contain in cleaned, "sanitization must preserve the prompt's salient content"

    @parameterized.expand(
        [
            ("empty", ""),
            ("only_whitespace", "   \n\t "),
            ("oversize", "x" * 4001),
        ]
    )
    def test_rejects(self, _name, raw):
        with pytest.raises(PromptRejectedError):
            sanitize_prompt(raw)


class TestGenerateAISubscriptionMarkdown(APIBaseTest):
    """`generate_ai_subscription_markdown` wraps the shared `generate_ai_report` primitive.
    These tests pin the pipeline behaviors (plan -> execute -> synthesize, query-fix
    retries, degraded delivery) through the wrapper, plus the subscription-specific
    no-creator guard."""

    def _make_ai_sub(self) -> Subscription:
        return create_subscription(
            team=self.team,
            created_by=self.user,
            content_type=Subscription.ContentType.AI_PROMPT,
            prompt="Top events last week",
            title="Test AI report",
        )

    def _spec(self, n_steps: int, hogql: str = "SELECT 1") -> EnrichedPromptSpec:
        return EnrichedPromptSpec(
            cleaned_prompt="prompt",
            context_blob="ctx",
            plan=QueryPlan(
                overall_intent="x",
                steps=[QueryPlanStep(description=f"step {i}", query_type="hogql", hogql=hogql) for i in range(n_steps)],
            ),
        )

    @parameterized.expand(
        [
            # name, executor_side_effect, synth_content, expected_substring, expected_awaits
            (
                "single_step_synthesizes",
                [("|event|count|\n|---|---|\n|$pageview|42|", False)],
                "We found 42 pageviews.",
                "42 pageviews",
                1,
            ),
            ("continues_past_failed_step", [("ok", False), Exception("syntax")], "final", "final", 2),
            # asyncio.TimeoutError is not retryable — different SQL won't help, so no retry.
            ("no_retry_on_non_hogql_error", [TimeoutError("clickhouse down")], "degraded", "degraded", 1),
        ]
    )
    @patch("ee.hogai.ai_reports.MaxChatOpenAI")
    @patch("ee.hogai.ai_reports.AssistantQueryExecutor")
    @patch("ee.hogai.ai_reports.build_enriched_prompt")
    def test_pipeline_returns_synthesized_markdown(
        self,
        _name,
        executor_side_effect,
        synth_content,
        expected_substring,
        expected_awaits,
        mock_build,
        mock_executor_cls,
        mock_llm_cls,
    ):
        sub = self._make_ai_sub()
        mock_build.return_value = self._spec(len(executor_side_effect))
        executor = MagicMock()
        executor.arun_and_format_query = AsyncMock(side_effect=executor_side_effect)
        mock_executor_cls.return_value = executor
        synth_llm = MagicMock()
        synth_llm.invoke.return_value = MagicMock(content=synth_content)
        mock_llm_cls.return_value = synth_llm

        out = generate_ai_subscription_markdown(sub)

        assert expected_substring in out
        assert executor.arun_and_format_query.await_count == expected_awaits

    @parameterized.expand(
        [
            # name, executor_side_effect, fix_results, synth_content, expected_out, expected_awaits
            (
                "retry_fixes_query_then_succeeds",
                [MaxToolRetryableError("no viable alternative"), ("|fixed|\n|---|\n|ok|", False)],
                [HogQLFix(fixed_hogql="SELECT 1")],
                "final report",
                "final report",
                2,
            ),
            (
                "retries_capped_at_two",
                MaxToolRetryableError("no viable alternative"),
                [HogQLFix(fixed_hogql="FIX_1"), HogQLFix(fixed_hogql="FIX_2")],
                "degraded report",
                "degraded report",
                3,
            ),
            (
                "stops_when_llm_echoes_same_query",
                MaxToolRetryableError("nope"),
                [HogQLFix(fixed_hogql="INITIAL")],
                "degraded",
                "degraded",
                1,
            ),
        ]
    )
    @patch("ee.hogai.ai_reports.MaxChatOpenAI")
    @patch("ee.hogai.ai_reports.AssistantQueryExecutor")
    @patch("ee.hogai.ai_reports.build_enriched_prompt")
    def test_query_fix_retry_loop(
        self,
        _name,
        executor_side_effect,
        fix_results,
        synth_content,
        expected_out,
        expected_awaits,
        mock_build,
        mock_executor_cls,
        mock_llm_cls,
    ):
        sub = self._make_ai_sub()
        mock_build.return_value = self._spec(1, hogql="INITIAL")
        executor = MagicMock()
        executor.arun_and_format_query = AsyncMock(side_effect=executor_side_effect)
        mock_executor_cls.return_value = executor

        fix_llm = MagicMock()
        fix_llm.with_structured_output.return_value = fix_llm
        fix_llm.invoke.side_effect = fix_results
        synth_llm = MagicMock()
        synth_llm.invoke.return_value = MagicMock(content=synth_content)
        # One MaxChatOpenAI is constructed per fix attempt, then one for synthesis.
        mock_llm_cls.side_effect = [fix_llm] * len(fix_results) + [synth_llm]

        out = generate_ai_subscription_markdown(sub)

        assert out == expected_out
        assert executor.arun_and_format_query.await_count == expected_awaits
        assert fix_llm.invoke.call_count == len(fix_results)

    @patch("ee.hogai.ai_reports.logger")
    @patch("ee.hogai.ai_reports.MaxChatOpenAI")
    @patch("ee.hogai.ai_reports.AssistantQueryExecutor")
    @patch("ee.hogai.ai_reports.build_enriched_prompt")
    def test_emits_delivered_degraded_signal_when_a_step_fails(
        self, mock_build, mock_executor_cls, mock_llm_cls, mock_logger
    ):
        sub = self._make_ai_sub()
        mock_build.return_value = self._spec(2)
        executor = MagicMock()
        executor.arun_and_format_query = AsyncMock(side_effect=[("ok", False), Exception("syntax")])
        mock_executor_cls.return_value = executor
        synth_llm = MagicMock()
        synth_llm.invoke.return_value = MagicMock(content="final")
        mock_llm_cls.return_value = synth_llm

        generate_ai_subscription_markdown(sub)

        degraded = [
            c for c in mock_logger.warning.call_args_list if c.args and c.args[0] == "ai_report.delivered_degraded"
        ]
        assert len(degraded) == 1
        assert degraded[0].kwargs["failed_steps"] == 1
        assert degraded[0].kwargs["total_steps"] == 2

    @patch("ee.hogai.ai_reports.MaxChatOpenAI")
    @patch("ee.hogai.ai_reports.AssistantQueryExecutor")
    @patch("ee.hogai.ai_reports.build_enriched_prompt")
    def test_synthesis_failure_is_tagged_with_stage(self, mock_build, mock_executor_cls, mock_llm_cls):
        sub = self._make_ai_sub()
        mock_build.return_value = self._spec(1)
        executor = MagicMock()
        executor.arun_and_format_query = AsyncMock(return_value=("ok", False))
        mock_executor_cls.return_value = executor
        synth_llm = MagicMock()
        synth_llm.invoke.side_effect = Exception("LLM unavailable")
        mock_llm_cls.return_value = synth_llm

        with pytest.raises(AiReportStageError) as exc_info:
            generate_ai_subscription_markdown(sub)
        assert exc_info.value.stage == "synthesis"

    @patch("ee.hogai.ai_reports.build_enriched_prompt")
    def test_prompt_rejected_is_not_wrapped_in_stage_error(self, mock_build):
        # PromptRejectedError must keep its own type so callers can auto-disable / 400.
        sub = self._make_ai_sub()
        mock_build.side_effect = PromptRejectedError("planner returned a malformed plan")

        with pytest.raises(PromptRejectedError):
            generate_ai_subscription_markdown(sub)

    def test_no_creator_is_rejected(self):
        sub = self._make_ai_sub()
        Subscription.objects.filter(pk=sub.id).update(created_by=None)
        sub.refresh_from_db()

        with pytest.raises(PromptRejectedError):
            generate_ai_subscription_markdown(sub)


class TestEmailDelivery(APIBaseTest):
    """End-to-end email rendering goes through `send_email_ai_subscription_report`. We assert
    only the subscription-specific behaviors: an HTML alternative is attached and the
    MessagingRecord dedup key is keyed on the workflow run."""

    def setUp(self) -> None:
        super().setUp()
        set_instance_setting("EMAIL_HOST", "fake_host")
        set_instance_setting("EMAIL_ENABLED", True)

    def _ai_sub(self) -> Subscription:
        sub = create_subscription(
            team=self.team,
            created_by=self.user,
            content_type=Subscription.ContentType.AI_PROMPT,
            prompt="Top events",
            title="My AI report",
            target_value="user@posthog.com",
        )
        sub.next_delivery_date = datetime(2025, 1, 1, 9, 0, tzinfo=ZoneInfo("UTC"))
        sub.save(update_fields=["next_delivery_date"])
        return sub

    def test_attaches_html_alternative(self):
        sub = self._ai_sub()
        send_email_ai_subscription_report(
            email="user@posthog.com", subscription=sub, markdown="# Hello\n\n- one\n- two"
        )
        assert len(mail.outbox) == 1
        html_alternatives = [content for content, mimetype in mail.outbox[0].alternatives if mimetype == "text/html"]
        assert html_alternatives, "expected an HTML alternative attached to the email"
        # The markdown must actually render to HTML (catches an empty/garbled render).
        # `inline_css` rewrites bare tags into `<h1 style="...">`, so anchor on the prefix.
        html = html_alternatives[0]
        assert "<h1" in html and "<li" in html

    def test_campaign_key_dedups_within_run_and_resets_across_runs(self):
        sub = self._ai_sub()
        # Two sends in the same workflow run must dedup to a single MessagingRecord.
        for _ in range(2):
            send_email_ai_subscription_report(
                email="user@posthog.com", subscription=sub, markdown="# hi", delivery_run_id="RUN_A"
            )
        assert (
            MessagingRecord.objects.filter(
                email_hash=get_email_hash("user@posthog.com"), campaign_key=f"ai_subscription_report_{sub.id}_RUN_A"
            ).count()
            == 1
        )
        # A fresh run (e.g. a new "Test delivery" click) gets a fresh key and sends again.
        send_email_ai_subscription_report(
            email="user@posthog.com", subscription=sub, markdown="# hi", delivery_run_id="RUN_B"
        )
        assert MessagingRecord.objects.filter(
            email_hash=get_email_hash("user@posthog.com"), campaign_key=f"ai_subscription_report_{sub.id}_RUN_B"
        ).exists()


class TestSlackDelivery(APIBaseTest):
    """`send_slack_ai_subscription_report` posts to the resolved channel, threads overflow
    sections, and raises on a missing integration so the activity can auto-disable."""

    def _ai_sub(self, target_value="C123|#channel"):
        return create_subscription(
            team=self.team,
            created_by=self.user,
            content_type=Subscription.ContentType.AI_PROMPT,
            prompt="Top events",
            title="My AI report",
            target_type="slack",
            target_value=target_value,
        )

    @patch("ee.tasks.subscriptions.ai_subscription.delivery.SlackIntegration")
    @patch("ee.tasks.subscriptions.ai_subscription.delivery.get_slack_integration_for_team")
    def test_posts_to_channel(self, mock_get_integration, mock_slack_integration_cls):
        sub = self._ai_sub()
        mock_get_integration.return_value = MagicMock()
        slack_client = MagicMock()
        slack_client.chat_postMessage.return_value = {"ts": "123"}
        mock_slack_integration_cls.return_value = MagicMock(client=slack_client)

        send_slack_ai_subscription_report(subscription=sub, markdown="# Hi\n\nbody")

        assert slack_client.chat_postMessage.call_args_list[0].kwargs["channel"] == "C123"

    @patch("ee.tasks.subscriptions.ai_subscription.delivery.SlackIntegration")
    @patch("ee.tasks.subscriptions.ai_subscription.delivery.get_slack_integration_for_team")
    def test_threads_overflow_for_long_markdown(self, mock_get_integration, mock_slack_integration_cls):
        sub = self._ai_sub()
        mock_get_integration.return_value = MagicMock()
        slack_client = MagicMock()
        slack_client.chat_postMessage.return_value = {"ts": "abc"}
        mock_slack_integration_cls.return_value = MagicMock(client=slack_client)

        long_body = ("paragraph text " * 200 + "\n\n") * 3
        send_slack_ai_subscription_report(subscription=sub, markdown=long_body)

        calls = slack_client.chat_postMessage.call_args_list
        assert len(calls) >= 2
        assert calls[1].kwargs.get("thread_ts") == "abc"

    @patch("ee.tasks.subscriptions.ai_subscription.delivery.SlackIntegration")
    @patch("ee.tasks.subscriptions.ai_subscription.delivery.get_slack_integration_for_team", return_value=None)
    def test_missing_integration_raises(self, _mock_team_lookup, mock_slack_integration_cls):
        # The activity catches this and auto-disables; a silent return would record a
        # phantom "success" with no message sent.
        sub = self._ai_sub()
        with pytest.raises(SlackIntegrationMissingError):
            send_slack_ai_subscription_report(subscription=sub, markdown="# Hi")
        mock_slack_integration_cls.assert_not_called()
