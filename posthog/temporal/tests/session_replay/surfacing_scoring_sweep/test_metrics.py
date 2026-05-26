from unittest.mock import MagicMock, patch

from parameterized import parameterized

from posthog.temporal.session_replay.surfacing_scoring_sweep.constants import WORKFLOW_NAME
from posthog.temporal.session_replay.surfacing_scoring_sweep.metrics import (
    SURFACING_SCORING_ACTIVITY_TYPES,
    SURFACING_SCORING_WORKFLOW_TYPES,
    SurfacingScoringMetricsInterceptor,
    record_tick_summary,
)


class TestTypeSets:
    @parameterized.expand(
        [
            ("list_chunks_activity",),
            ("score_chunk_activity",),
        ]
    )
    def test_activity_types(self, activity_type: str) -> None:
        assert activity_type in SURFACING_SCORING_ACTIVITY_TYPES

    def test_workflow_types(self) -> None:
        assert WORKFLOW_NAME in SURFACING_SCORING_WORKFLOW_TYPES


class TestRecordTickSummary:
    @parameterized.expand(
        [
            ("scored", {"total_scored": 42, "chunks_failed": 0}, "surfacing_scoring_total_scored", 42),
            ("failed", {"total_scored": 0, "chunks_failed": 3}, "surfacing_scoring_chunks_failed", 3),
        ]
    )
    def test_emits_counters_in_temporal_context(
        self,
        _name: str,
        kwargs: dict[str, int],
        counter_name: str,
        count: int,
    ) -> None:
        mock_meter = MagicMock()
        mock_counter = MagicMock()
        mock_meter.create_counter.return_value = mock_counter

        with patch(
            "posthog.temporal.session_replay.surfacing_scoring_sweep.metrics.get_metric_meter",
            return_value=mock_meter,
        ):
            record_tick_summary(**kwargs)

        mock_meter.create_counter.assert_called_once_with(counter_name, mock_meter.create_counter.call_args[0][1])
        mock_counter.add.assert_called_once_with(count)

    @parameterized.expand(
        [
            ("both_zero", 0, 0),
            ("negative_scored", -1, 0),
            ("negative_failed", 0, -1),
        ]
    )
    def test_noops_for_non_positive_counts(self, _name: str, total_scored: int, chunks_failed: int) -> None:
        with patch(
            "posthog.temporal.session_replay.surfacing_scoring_sweep.metrics.get_metric_meter",
        ) as mock_get_meter:
            record_tick_summary(total_scored=total_scored, chunks_failed=chunks_failed)
            mock_get_meter.assert_not_called()


class TestInterceptorStructure:
    def test_creates_activity_interceptor(self) -> None:
        interceptor = SurfacingScoringMetricsInterceptor()
        result = interceptor.intercept_activity(MagicMock())
        assert result is not None
