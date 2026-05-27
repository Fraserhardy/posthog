import pytest
from unittest.mock import MagicMock

from posthog.temporal.subscriptions.ai_subscription.delivery import (
    SLACK_MRKDWN_SECTION_LIMIT,
    _build_ai_slack_message,
    _split_text_into_chunks,
    render_ai_email_html,
)

_PARA = "a" * (SLACK_MRKDWN_SECTION_LIMIT - 100)


class TestSplitTextIntoChunks:
    @pytest.mark.parametrize(
        "name,text,expected",
        [
            ("short_text_single_chunk", "short report", ["short report"]),
            ("empty_text_no_chunks", "", []),
            ("breaks_on_paragraph_boundary", f"{_PARA}\n\n{_PARA}", [_PARA, _PARA]),
        ],
    )
    def test_exact_chunking(self, name: str, text: str, expected: list[str]) -> None:
        assert _split_text_into_chunks(text) == expected

    @pytest.mark.parametrize("prefix", ["\n\n", "\n", "  \n\n  "])
    def test_leading_blank_lines_do_not_emit_empty_chunk(self, prefix: str) -> None:
        # regression: a body starting on a paragraph boundary used to carve off an empty first chunk
        chunks = _split_text_into_chunks(prefix + ("a" * (SLACK_MRKDWN_SECTION_LIMIT + 100)))
        assert chunks
        assert all(chunk.strip() for chunk in chunks)

    def test_no_newlines_falls_back_to_hard_cut(self) -> None:
        text = "x" * (SLACK_MRKDWN_SECTION_LIMIT * 2 + 50)
        chunks = _split_text_into_chunks(text)
        assert len(chunks) >= 3
        assert all(len(c) <= SLACK_MRKDWN_SECTION_LIMIT for c in chunks)
        assert "".join(chunks) == text


class TestRenderAIEmailHtml:
    def test_neutralizes_raw_html_but_keeps_tables(self) -> None:
        html = render_ai_email_html("## Heading\n\n<script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |")
        # Raw HTML in the markdown source is escaped to inert text (html=False), never a live tag.
        assert "<script>" not in html
        assert "&lt;script&gt;" in html
        # Legitimate markdown structure (headings, tables) still renders.
        assert "<table>" in html
        assert "<h2>" in html

    def test_renders_basic_markdown(self) -> None:
        html = render_ai_email_html("**bold** and *italic*")
        assert "<strong>bold</strong>" in html
        assert "<em>italic</em>" in html


def _mock_subscription() -> MagicMock:
    sub = MagicMock()
    sub.target_value = "C123|#general"
    sub.title = "Weekly report"
    sub.url = "https://app.posthog.com/project/1/subscriptions/2"
    sub.team_id = 1
    sub.id = 2
    return sub


class TestBuildAISlackMessage:
    def test_single_section_report_has_no_thread_messages(self) -> None:
        message = _build_ai_slack_message(_mock_subscription(), "A short report.")
        assert message.channel == "C123"
        assert message.thread_messages == []
        section_texts = [b["text"]["text"] for b in message.blocks if b["type"] == "section"]
        assert all(text.strip() for text in section_texts), "no empty section text allowed"

    def test_long_report_overflows_into_thread(self) -> None:
        long_markdown = ("para\n\n" * 1).join("x" * (SLACK_MRKDWN_SECTION_LIMIT - 50) for _ in range(3))
        message = _build_ai_slack_message(_mock_subscription(), long_markdown)
        assert len(message.thread_messages) >= 1
        for thread_msg in message.thread_messages:
            for block in thread_msg["blocks"]:
                assert block["text"]["text"].strip(), "thread section text must be non-empty"
