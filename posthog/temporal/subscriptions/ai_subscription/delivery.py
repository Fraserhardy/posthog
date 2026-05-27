import nh3
import structlog
from markdown_it import MarkdownIt
from markdown_to_mrkdwn import SlackMarkdownConverter

from posthog.email import EmailMessage
from posthog.models.integration import Integration
from posthog.models.subscription import Subscription, get_unsubscribe_token
from posthog.sync import database_sync_to_async
from posthog.temporal.subscriptions.ai_subscription.report_pipeline import generate_ai_report
from posthog.temporal.subscriptions.ai_subscription.spec_generator import PromptRejectedError
from posthog.utils import absolute_uri

from ee.tasks.subscriptions.slack_subscriptions import (
    UTM_TAGS_BASE,
    SlackDeliveryResult,
    SlackMessageData,
    deliver_slack_message_data,
    get_slack_integration_for_team,
)

logger = structlog.get_logger(__name__)


_MARKDOWN_RENDERER = MarkdownIt("commonmark", {"breaks": True, "html": False}).enable("table")
_SLACK_CONVERTER = SlackMarkdownConverter()

# defense-in-depth on top of html=False: allow only the tags commonmark emits
_ALLOWED_EMAIL_TAGS = {
    "a",
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "b",
    "i",
    "code",
    "pre",
    "blockquote",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
}
_ALLOWED_EMAIL_ATTRS = {"a": {"href", "title"}}

# Slack's hard limit is 3000 chars per section block; keep margin for safety.
SLACK_MRKDWN_SECTION_LIMIT = 2900


def _split_text_into_chunks(text: str, limit: int = SLACK_MRKDWN_SECTION_LIMIT) -> list[str]:
    if len(text) <= limit:
        return [text] if text else []

    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        # prefer a paragraph break, then any newline, else a hard cut; cut <= 0 guards against
        # carving an empty leading chunk and never progressing
        cut = remaining.rfind("\n\n", 0, limit)
        if cut <= 0:
            cut = remaining.rfind("\n", 0, limit)
        if cut <= 0:
            cut = limit
        chunk = remaining[:cut].rstrip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[cut:].lstrip()
    if remaining:
        chunks.append(remaining)
    return chunks


async def generate_ai_subscription_markdown(subscription: Subscription) -> str:
    # created_by is FK SET_NULL; the pipeline requires a non-None user
    if subscription.created_by is None:
        raise PromptRejectedError("AI subscription has no creator (created_by deleted); cannot deliver.")

    return await generate_ai_report(
        team=subscription.team,
        user=subscription.created_by,
        prompt=subscription.prompt,
        window_days=subscription.ai_report_window_days,
        trace_correlation_id=subscription.id,
    )


def render_ai_email_html(markdown: str) -> str:
    rendered = _MARKDOWN_RENDERER.render(markdown)
    return nh3.clean(rendered, tags=_ALLOWED_EMAIL_TAGS, attributes=_ALLOWED_EMAIL_ATTRS)


def send_email_ai_subscription_report(
    *,
    email: str,
    subscription: Subscription,
    markdown: str,
    delivery_run_id: str,
    rendered_html: str | None = None,
) -> None:
    utm_tags = f"{UTM_TAGS_BASE}&utm_medium=email"
    html = rendered_html if rendered_html is not None else render_ai_email_html(markdown)
    title = subscription.title or "Your PostHog AI report"
    subscription_url = subscription.url or absolute_uri(
        f"/project/{subscription.team_id}/subscriptions/{subscription.id}"
    )
    unsubscribe_url = absolute_uri(f"/unsubscribe?token={get_unsubscribe_token(subscription, email)}&{utm_tags}")

    campaign_key = f"ai_subscription_report_{subscription.id}_{delivery_run_id}"

    message = EmailMessage(
        campaign_key=campaign_key,
        subject=f"PostHog AI report - {title}",
        template_name="ai_subscription_report",
        template_context={
            "title": title,
            "rendered_html": html,
            "subscription_url": f"{subscription_url}?{utm_tags}",
            "unsubscribe_url": unsubscribe_url,
        },
    )
    message.add_recipient(email=email)
    message.send(send_async=False)


class SlackIntegrationMissingError(RuntimeError):
    pass


def _resolve_slack_integration(subscription: Subscription) -> Integration:
    # prefer the explicitly attached integration, else the team-wide first match; raise on missing
    integration = subscription.integration
    if integration is not None and integration.kind != "slack":
        logger.warning(
            "ai_subscription.slack_invalid_integration_kind",
            subscription_id=subscription.id,
            integration_id=integration.id,
            kind=integration.kind,
        )
        integration = None
    if integration is None:
        integration = get_slack_integration_for_team(subscription.team_id)
    if not integration:
        raise SlackIntegrationMissingError(
            f"No Slack integration available for subscription {subscription.id} (team {subscription.team_id})"
        )
    return integration


def _build_ai_slack_message(subscription: Subscription, markdown: str) -> SlackMessageData:
    utm_tags = f"{UTM_TAGS_BASE}&utm_medium=slack"
    channel = subscription.target_value.split("|")[0]
    sections = _split_text_into_chunks(_SLACK_CONVERTER.convert(markdown))
    title = subscription.title or "Your PostHog AI report"
    first_section = sections[0] if sections else "_No report content was generated._"

    blocks: list[dict] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*{title}*"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": first_section}},
    ]
    if len(sections) > 1:
        blocks.append(
            {"type": "section", "text": {"type": "mrkdwn", "text": "_See thread for the rest of the report._"}}
        )

    subscription_url = subscription.url or absolute_uri(
        f"/project/{subscription.team_id}/subscriptions/{subscription.id}"
    )
    blocks.extend(
        [
            {"type": "divider"},
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "Manage subscription"},
                        "url": f"{subscription_url}?{utm_tags}",
                    }
                ],
            },
        ]
    )

    thread_messages = [
        {"blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": section}}]} for section in sections[1:]
    ]
    return SlackMessageData(channel=channel, blocks=blocks, title=title, thread_messages=thread_messages)


async def send_slack_ai_subscription_report(
    *,
    subscription: Subscription,
    markdown: str,
) -> SlackDeliveryResult:
    # resolving the integration touches the ORM, so it must run off the event loop
    integration = await database_sync_to_async(_resolve_slack_integration, thread_sensitive=False)(subscription)
    message_data = _build_ai_slack_message(subscription, markdown)
    return await deliver_slack_message_data(integration, subscription, message_data)


__all__ = [
    "generate_ai_subscription_markdown",
    "render_ai_email_html",
    "send_email_ai_subscription_report",
    "send_slack_ai_subscription_report",
]
