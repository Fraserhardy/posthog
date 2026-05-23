"""Dedupe metric UUIDs across an experiment's metrics / metrics_secondary / saved metrics.

Some experiments accumulated duplicate metric UUIDs (likely via MCP/LLM update
flows that copied a metric without regenerating its UUID). The service layer
now rewrites duplicates on every write, but pre-existing rows in the DB still
carry the corruption. This command performs a one-shot backfill that mirrors
what ``_assign_uuids_to_metrics`` does on the live path: the first occurrence
of a duplicated UUID keeps it (so any attached ``ExperimentMetricResult`` rows
or saved-metric links stay valid), and later occurrences get fresh UUIDs that
are appended to the corresponding ordering array.

Run with ``--dry-run`` first to confirm the affected count before writing.
"""

from copy import deepcopy
from uuid import uuid4

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

import structlog

from products.experiments.backend.models.experiment import Experiment, ExperimentToSavedMetric

logger = structlog.get_logger(__name__)


# Returns experiment ids that have at least one duplicated metric uuid across
# the union of inline `metrics`, inline `metrics_secondary`, and attached
# saved-metric query uuids.
_AFFECTED_IDS_SQL = """
WITH metrics_unnested AS (
    SELECT e.id AS experiment_id, elem->>'uuid' AS metric_uuid
    FROM posthog_experiment e
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.metrics, '[]'::jsonb)) AS elem
    WHERE e.deleted IS NOT TRUE AND elem->>'uuid' IS NOT NULL
        {team_filter}
        {experiment_filter}

    UNION ALL

    SELECT e.id, elem->>'uuid'
    FROM posthog_experiment e
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.metrics_secondary, '[]'::jsonb)) AS elem
    WHERE e.deleted IS NOT TRUE AND elem->>'uuid' IS NOT NULL
        {team_filter}
        {experiment_filter}

    UNION ALL

    SELECT e.id, sm.query->>'uuid'
    FROM posthog_experiment e
    JOIN posthog_experimenttosavedmetric link ON link.experiment_id = e.id
    JOIN posthog_experimentsavedmetric sm ON sm.id = link.saved_metric_id
    WHERE e.deleted IS NOT TRUE AND sm.query->>'uuid' IS NOT NULL
        {team_filter}
        {experiment_filter}
)
SELECT experiment_id
FROM metrics_unnested
GROUP BY experiment_id, metric_uuid
HAVING COUNT(*) > 1
"""


def _dedupe_metrics(metrics: list[dict] | None, seen: set[str]) -> tuple[list[dict], bool]:
    """Walk ``metrics`` in order. First occurrence of a uuid keeps it; later
    occurrences (and missing uuids) get fresh ones. Returns the prepared list
    plus a `changed` flag.
    """
    if not metrics:
        return metrics or [], False
    prepared = deepcopy(metrics)
    changed = False
    for metric in prepared:
        original = metric.get("uuid")
        if not original or original in seen:
            new_uuid = str(uuid4())
            metric["uuid"] = new_uuid
            seen.add(new_uuid)
            changed = True
        else:
            seen.add(original)
    return prepared, changed


def _append_new_uuids(ordering: list[str] | None, original_uuids: set[str], new_uuids: set[str]) -> list[str] | None:
    """Append regenerated uuids to ``ordering`` while keeping existing entries.

    The kept incumbent's uuid is in ``original_uuids`` and stays where it is.
    Anything in ``new_uuids - original_uuids`` is a freshly regenerated dup and
    is appended to the end if not already present.
    """
    if not new_uuids:
        return ordering
    current = list(ordering or [])
    for uuid in new_uuids:
        if uuid in original_uuids:
            continue
        if uuid not in current:
            current.append(uuid)
    return current


class Command(BaseCommand):
    help = "Dedupe experiment metric UUIDs across metrics / metrics_secondary / saved metrics."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            default=False,
            help="Report what would change without writing.",
        )
        parser.add_argument(
            "--team-id",
            type=int,
            default=None,
            help="Restrict the backfill to a single team.",
        )
        parser.add_argument(
            "--experiment-id",
            type=int,
            default=None,
            help="Restrict the backfill to a single experiment.",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=500,
            help="Number of experiments per chunk (default: 500).",
        )

    def handle(self, *args, **options):
        dry_run: bool = options["dry_run"]
        team_id: int | None = options["team_id"]
        experiment_id: int | None = options["experiment_id"]
        batch_size: int = options["batch_size"]

        if batch_size < 1:
            raise CommandError("--batch-size must be a positive integer")

        # Build the SQL filters and the parameterized values.
        team_filter = "AND e.team_id = %s" if team_id is not None else ""
        experiment_filter = "AND e.id = %s" if experiment_id is not None else ""
        sql = _AFFECTED_IDS_SQL.format(team_filter=team_filter, experiment_filter=experiment_filter)

        # Each filter appears three times in the CTE (one per UNION branch), so
        # the params must repeat to match.
        params: list[int] = []
        for _ in range(3):
            if team_id is not None:
                params.append(team_id)
            if experiment_id is not None:
                params.append(experiment_id)

        with connection.cursor() as cursor:
            cursor.execute(sql, params)
            affected_ids = sorted({row[0] for row in cursor.fetchall()})

        if not affected_ids:
            self.stdout.write("No experiments to dedupe.")
            return

        self.stdout.write(f"{'[DRY RUN] ' if dry_run else ''}Found {len(affected_ids)} experiments needing dedup.")

        updated = 0
        failed = 0

        for start in range(0, len(affected_ids), batch_size):
            chunk_ids = affected_ids[start : start + batch_size]

            saved_uuids_by_experiment: dict[int, set[str]] = {}
            for link in (
                ExperimentToSavedMetric.objects.filter(experiment_id__in=chunk_ids)
                .select_related("saved_metric")
                .only("experiment_id", "saved_metric__query")
            ):
                sm = link.saved_metric
                if sm and sm.query:
                    uuid = sm.query.get("uuid")
                    if uuid:
                        saved_uuids_by_experiment.setdefault(link.experiment_id, set()).add(uuid)

            qs = Experiment.objects.filter(id__in=chunk_ids).only(
                "id",
                "metrics",
                "metrics_secondary",
                "primary_metrics_ordered_uuids",
                "secondary_metrics_ordered_uuids",
            )
            for experiment in qs.iterator():
                try:
                    seen: set[str] = set(saved_uuids_by_experiment.get(experiment.id, set()))

                    original_primary_uuids: set[str] = {
                        uuid for m in (experiment.metrics or []) if (uuid := m.get("uuid"))
                    }
                    original_secondary_uuids: set[str] = {
                        uuid for m in (experiment.metrics_secondary or []) if (uuid := m.get("uuid"))
                    }

                    new_primary, primary_changed = _dedupe_metrics(experiment.metrics or [], seen)
                    new_secondary, secondary_changed = _dedupe_metrics(experiment.metrics_secondary or [], seen)

                    if not (primary_changed or secondary_changed):
                        # Possible if rows changed between the SELECT and now.
                        continue

                    new_primary_uuids: set[str] = {uuid for m in new_primary if (uuid := m.get("uuid"))}
                    new_secondary_uuids: set[str] = {uuid for m in new_secondary if (uuid := m.get("uuid"))}

                    new_primary_ordering = _append_new_uuids(
                        experiment.primary_metrics_ordered_uuids,
                        original_primary_uuids,
                        new_primary_uuids,
                    )
                    new_secondary_ordering = _append_new_uuids(
                        experiment.secondary_metrics_ordered_uuids,
                        original_secondary_uuids,
                        new_secondary_uuids,
                    )

                    logger.info(
                        "experiment_metric_uuid_dedupe_planned",
                        experiment_id=experiment.id,
                        primary_changed=primary_changed,
                        secondary_changed=secondary_changed,
                        dry_run=dry_run,
                    )

                    if dry_run:
                        updated += 1
                        continue

                    experiment.metrics = new_primary
                    experiment.metrics_secondary = new_secondary
                    experiment.primary_metrics_ordered_uuids = new_primary_ordering
                    experiment.secondary_metrics_ordered_uuids = new_secondary_ordering
                    with transaction.atomic():
                        experiment.save(
                            update_fields=[
                                "metrics",
                                "metrics_secondary",
                                "primary_metrics_ordered_uuids",
                                "secondary_metrics_ordered_uuids",
                            ]
                        )
                    updated += 1
                except Exception as e:
                    failed += 1
                    logger.error(
                        "experiment_metric_uuid_dedupe_failed",
                        experiment_id=experiment.id,
                        error=str(e),
                        exc_info=True,
                    )

        verb = "Would update" if dry_run else "Updated"
        self.stdout.write(f"{verb} {updated} experiments. {failed} failed.")
