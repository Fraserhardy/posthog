# Generated manually

from django.db import migrations, models


def backfill_resource_type(apps, schema_editor):
    # Existing subscriptions always have exactly one of insight/dashboard set (enforced by the API),
    # so the "insight" column default already covers insight rows. Mark dashboard-only rows; the
    # `insight_id__isnull=True` filter mirrors `resource_info`'s runtime precedence (insight wins)
    # in the unexpected event a row has both set.
    Subscription = apps.get_model("posthog", "Subscription")
    Subscription.objects.filter(insight_id__isnull=True, dashboard_id__isnull=False).update(resource_type="dashboard")


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("posthog", "1176_migrate_web_analytics_models"),
    ]

    operations = [
        migrations.AddField(
            model_name="subscription",
            name="resource_type",
            field=models.CharField(
                choices=[
                    ("insight", "Insight"),
                    ("dashboard", "Dashboard"),
                    ("ai_prompt", "AI prompt"),
                ],
                default="insight",
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name="subscription",
            name="prompt",
            field=models.TextField(blank=True, null=True),
        ),
        migrations.RunPython(backfill_resource_type, reverse_code=noop_reverse),
    ]
