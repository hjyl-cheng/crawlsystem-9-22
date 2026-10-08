"""Boundary probes for the TypeScript port of the legacy clock decisions.

Random channel histories (generate.py) seldom land exactly on a threshold, so this drives the
legacy decision functions directly with feature states concentrated around every boundary they
test: publish ages near 7 and 30 days, cadences near the About tiers, priorities near each cut,
stability near each gate, regularity near 0.65, empty runs, semantic change near the curve's
rounding points. Same legacy commit and policy as generate.py.

  PYTHONPATH=<site>:<oldsystem>/services/feature-engine/src python3.12 probes.py | gzip -9 > ../test/fixtures/decision-probes.json.gz
"""
from __future__ import annotations

from dataclasses import fields
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import random
import sys

from feature_engine.contracts import validate_active_policy_contract
from feature_engine.policy import (
    agent_forward_spread_max_days, decide_about_due, decide_agent_due, decide_video_due, limit_about_slowdown,
    recent_publish_active, runtime_policy_configs, stable_agent_forward_offset,
)
from feature_engine.state import ChannelFeatureState

POLICY = validate_active_policy_contract(json.loads((Path(__file__).parent.parent / "src" / "clock_policy_v16_rule_7.json").read_text())["policy"])
CONFIGS = runtime_policy_configs(POLICY)
DAY = 86400.0


def iso(value):
    return None if value is None else value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def state_json(state: ChannelFeatureState) -> dict:
    """Only the fields that differ from a new ChannelFeatureState()."""
    out, default = {}, ChannelFeatureState()
    for f in fields(state):
        value = getattr(state, f.name)
        if value != getattr(default, f.name):
            out[f.name] = iso(value) if isinstance(value, datetime) else list(value) if isinstance(value, tuple) else value
    return out


def near(rng: random.Random, points: list[float], spread: float) -> float:
    """A value at, just around, or well away from one of `points` (to 1e-9, keeping the fixture small)."""
    point = rng.choice(points)
    return round(rng.choice([point, point + rng.uniform(-spread, spread), point + rng.choice([-1, 1]) * spread * 1e-6, point * rng.uniform(0.3, 3)]), 9)


def unit(rng: random.Random, points: list[float]) -> float:
    return min(1.0, max(0.0, near(rng, points, 0.02))) if rng.random() < 0.8 else round(rng.random(), 9)


def probe_state(rng: random.Random, observed: datetime) -> ChannelFeatureState:
    maybe = lambda value, p=0.85: value if rng.random() < p else None
    ages = [0.5, 1, 3, 7, 14, 30]
    last_publish = observed - timedelta(seconds=max(0.0, near(rng, ages, 0.05)) * DAY) if rng.random() < 0.85 else None
    cadence = max(0.05, near(rng, [1.0, 1.5, 2.5, 3.5, 5.5, 7, 14, 30], 0.05))
    ewma = maybe(cadence * rng.choice([1.0, 1.0, rng.uniform(0.5, 1.5)]))
    median = maybe(cadence * rng.choice([1.0, 1.0, rng.uniform(0.5, 1.5)]))
    history = tuple(round(rng.uniform(0.2, 20), 9) for _ in range(rng.choice([0, 1, 2, 3, 3, 5, 12])))
    stable_age = near(rng, [21, 60, 120, 180, 365], 0.01)
    return ChannelFeatureState(
        subscriber_growth_percentile=maybe(unit(rng, [0.9, 0.5, 0.35])),
        view_growth_percentile=maybe(unit(rng, [0.9, 0.5, 0.35])),
        video_count_delta=maybe(rng.choice([-1, 0, 0, 1, 2, 3, 5])),
        collection_priority=unit(rng, [0.85, 0.35]),
        channel_activity=maybe(unit(rng, [0.40])),
        publish_interval_ewma=ewma,
        publish_interval_median=median,
        recent_publish_interval_days=history,
        publish_regularity=maybe(unit(rng, [0.65])),
        last_publish_at=last_publish,
        recent30_video_count=maybe(rng.choice([0, 0, 1, 2, 4, 5, 9, 10, 15, 19, 20, 30])),
        new_video_empty_runs=rng.choice([0, 0, 1, 2, 3, 4, 8, 9, 12]),
        recent_change_probability=maybe(round(rng.random(), 9)),
        recent_stale_ratio=maybe(round(rng.random(), 9)),
        about_metric_confidence=maybe(unit(rng, [0.75])),
        feature_confidence=unit(rng, [0.75]),
        about_stable_since=maybe(observed - timedelta(seconds=max(0.0, stable_age) * DAY)),
        about_stable_runs=rng.choice([0, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 20]),
        topic_drift=maybe(unit(rng, [0.0, 0.1, 0.5, 1.0])),
        evidence_replacement=maybe(unit(rng, [0.0, 0.25, 1.0])),
        recent_content_shift=maybe(unit(rng, [0.0, 0.5])),
        agent_version_changed=rng.random() < 0.1,
    )


def record(decision) -> dict:
    return {"tier": decision.tier_days, "due_day": decision.due_day.isoformat(), "reason_codes": list(decision.reason_codes)}


def probe(rng: random.Random, index: int) -> dict:
    observed = datetime(2026, 5, 1, tzinfo=timezone.utc) + timedelta(seconds=round(rng.uniform(0, 30 * DAY), 3))
    state = probe_state(rng, observed)
    channel = f"UCprobe{index:06d}" + "y" * 11
    about_outcome, about_baseline = rng.choice(["complete", "complete", "partial"]), rng.random() < 0.2
    about = decide_about_due(state, observed_at=observed, outcome=about_outcome, baseline=about_baseline, config=CONFIGS.about)
    previous_tier = rng.choice([1, 2, 3, 5, 7, 14, 30, 60, 90, 180, 4])
    video_args = {
        "discovery_outcome": rng.choice(["complete", "complete", "partial"]),
        "recent_sampling_outcome": rng.choice(["complete", "complete", "partial", "failed", "skipped"]),
        "discovery_baseline": rng.random() < 0.15,
        "recent_sampling_baseline": rng.random() < 0.15,
    }
    video = decide_video_due(state, observed_at=observed, **video_args, discovery_config=CONFIGS.discovery, recent_sampling_config=CONFIGS.recent_sampling)
    agent_baseline = rng.random() < 0.15
    agent = decide_agent_due(state, observed_at=observed, outcome="complete", baseline=agent_baseline, output_changed=False,
                             evidence_count=0, channel_id=channel, config=CONFIGS.agent)
    return {
        "channel_id": channel, "observed_at": iso(observed), "state": state_json(state),
        "about": {"outcome": about_outcome, "baseline": about_baseline, "decision": record(about),
                  "previous_tier": previous_tier, "limited": record(limit_about_slowdown(about, previous_tier_days=previous_tier))},
        "video": {**video_args, "decision": record(video)},
        "agent": {"baseline": agent_baseline, "decision": record(agent)},
        "recent_publish_active": recent_publish_active(state, observed),
    }


if __name__ == "__main__":
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
    rng = random.Random(20261009)
    spread = [{"interval": days, "max": agent_forward_spread_max_days(days),
               "offset": stable_agent_forward_offset("UCspread", policy_version=POLICY.policy_version, tier_days=days)} for days in range(1, 400)]
    print(json.dumps({"source": {"commit": "e92d9227a5a3847430e5d062bea13227564ee419", "policy_version": POLICY.policy_version},
                      "spread": spread, "probes": [probe(rng, i) for i in range(count)]}, separators=(",", ":")))
