# Generated manually

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("posthog", "1176_migrate_web_analytics_models"),
    ]

    operations = [
        migrations.AddField(
            model_name="subscription",
            name="prompt",
            field=models.TextField(blank=True, null=True),
        ),
    ]
