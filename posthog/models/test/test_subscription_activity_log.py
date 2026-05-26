from datetime import datetime
from zoneinfo import ZoneInfo

from freezegun import freeze_time
from posthog.test.base import BaseTest

from parameterized import parameterized

from posthog.models.activity_logging.activity_log import ActivityLog
from posthog.models.insight import Insight
from posthog.models.subscription import Subscription

from products.dashboards.backend.models.dashboard import Dashboard


@freeze_time("2022-01-01")
class TestSubscriptionActivityLog(BaseTest):
    def _create_subscription(self, **kwargs) -> Subscription:
        params: dict = {
            "team": self.team,
            "created_by": self.user,
            "resource_type": Subscription.ResourceType.AI_PROMPT,
            "title": "Weekly AI digest",
            "prompt": "Summarize last week's signups",
            "target_type": "email",
            "target_value": "test@posthog.com",
            "frequency": "weekly",
            "interval": 1,
            "start_date": datetime(2022, 1, 1, tzinfo=ZoneInfo("UTC")),
        }
        params.update(kwargs)
        return Subscription.objects.create(**params)

    def _subscription_logs(self):
        return ActivityLog.objects.filter(scope="Subscription").order_by("created_at")

    def test_creating_ai_subscription_logs_activity(self):
        subscription = self._create_subscription()

        logs = self._subscription_logs()
        assert logs.count() == 1
        assert logs[0].activity == "created"
        assert logs[0].item_id == str(subscription.id)
        assert logs[0].detail["name"] == "Weekly AI digest"

    @parameterized.expand(
        [
            (Subscription.ResourceType.INSIGHT,),
            (Subscription.ResourceType.DASHBOARD,),
        ]
    )
    def test_non_ai_subscription_does_not_log(self, resource_type: Subscription.ResourceType):
        relation = (
            {"insight": Insight.objects.create(team=self.team)}
            if resource_type == Subscription.ResourceType.INSIGHT
            else {"dashboard": Dashboard.objects.create(team=self.team)}
        )
        self._create_subscription(resource_type=resource_type, prompt=None, **relation)

        assert self._subscription_logs().count() == 0

    def test_subscription_without_created_by_does_not_log(self):
        self._create_subscription(created_by=None)

        assert self._subscription_logs().count() == 0

    def test_updating_ai_subscription_prompt_records_change(self):
        subscription = self._create_subscription()

        subscription.prompt = "Summarize last week's churn instead"
        subscription.save(update_fields=["prompt"])

        logs = self._subscription_logs()
        assert logs.count() == 2
        assert logs[1].activity == "updated"
        prompt_change = next(change for change in logs[1].detail["changes"] if change["field"] == "prompt")
        assert prompt_change["action"] == "changed"
        assert prompt_change["before"] == "Summarize last week's signups"
        assert prompt_change["after"] == "Summarize last week's churn instead"

    @parameterized.expand(
        [
            ("adding_a_prompt", None, "Now summarize signups", "created"),
            ("clearing_a_prompt", "Existing prompt", None, "deleted"),
        ]
    )
    def test_prompt_null_transitions_record_change(
        self, _name: str, before: str | None, after: str | None, expected_action: str
    ):
        subscription = self._create_subscription(prompt=before)

        subscription.prompt = after
        subscription.save(update_fields=["prompt"])

        prompt_change = next(
            change for change in self._subscription_logs()[1].detail["changes"] if change["field"] == "prompt"
        )
        assert prompt_change["action"] == expected_action
        assert prompt_change["before"] == before
        assert prompt_change["after"] == after

    @parameterized.expand(
        [
            ("title_wins", "My title", "the prompt", "My title"),
            ("prompt_snippet_when_no_title", None, "x" * 80, "x" * 60),
            ("whitespace_only_prompt_falls_back", None, "   ", "AI report"),
            ("empty_falls_back", None, None, "AI report"),
        ]
    )
    def test_ai_display_name(self, _name: str, title: str | None, prompt: str | None, expected: str):
        subscription = Subscription(
            resource_type=Subscription.ResourceType.AI_PROMPT,
            title=title,
            prompt=prompt,
            frequency="weekly",
            interval=1,
            start_date=datetime(2022, 1, 1, tzinfo=ZoneInfo("UTC")),
        )

        assert subscription.ai_display_name == expected

    def test_soft_deleting_ai_subscription_records_change(self):
        subscription = self._create_subscription()

        subscription.deleted = True
        subscription.save(update_fields=["deleted"])

        logs = self._subscription_logs()
        assert logs.count() == 2
        assert logs[1].activity == "updated"
        deleted_change = next(change for change in logs[1].detail["changes"] if change["field"] == "deleted")
        assert deleted_change["before"] is False
        assert deleted_change["after"] is True

    def test_mixed_save_excludes_next_delivery_date_from_diff(self):
        subscription = self._create_subscription()

        subscription.prompt = "Updated prompt"
        subscription.next_delivery_date = datetime(2022, 3, 1, tzinfo=ZoneInfo("UTC"))
        subscription.save(update_fields=["prompt", "next_delivery_date"])

        changed_fields = {change["field"] for change in self._subscription_logs()[1].detail["changes"]}
        assert "prompt" in changed_fields
        assert "next_delivery_date" not in changed_fields

    def test_scheduler_save_with_update_fields_does_not_log(self):
        subscription = self._create_subscription()

        subscription.next_delivery_date = datetime(2022, 2, 1, tzinfo=ZoneInfo("UTC"))
        subscription.save(update_fields=["next_delivery_date"])

        # Only the original "created" entry — the schedule bump is excluded via signal_exclusions.
        assert self._subscription_logs().count() == 1

    def test_scheduler_save_without_update_fields_does_not_log(self):
        subscription = self._create_subscription()

        subscription.refresh_from_db()
        subscription.next_delivery_date = datetime(2022, 2, 1, tzinfo=ZoneInfo("UTC"))
        subscription.save()

        # signal_exclusions also covers the no-update_fields path: the mixin's changed-fields check
        # honours the exclusion list, so a schedule-only change never emits the signal.
        assert self._subscription_logs().count() == 1
