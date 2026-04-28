"""Lives outside posthog.auth to avoid a circular import when imported by posthog.hogql."""

from typing import Optional


class SyntheticUser:
    """Tagged base class for non-real principals authenticated via service tokens."""

    email: Optional[str] = None

    def __init__(self, team, distinct_id: str):
        self.team = team
        self.current_team_id = team.id
        self.is_authenticated = True
        self.pk = -1
        self.id: Optional[int] = None
        self.distinct_id = distinct_id

    def has_perm(self, perm, obj=None):
        return False

    def has_module_perms(self, app_label):
        return False
