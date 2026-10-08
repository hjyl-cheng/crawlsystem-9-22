"""Golden vectors for the TypeScript port of the legacy feature-clock engine.

Drives the legacy Python engine (crawlSystem services/feature-engine at commit
e92d9227a5a3847430e5d062bea13227564ee419, policy v16-rule-7) through random channel
histories and records every feature state, channel clock and clock decision. The
orchestration below mirrors FeatureObservationApplier._apply_business_state,
_bootstrap_clocks, _update_clocks and _recalculate_first_cross_domain_clocks without a
database: the pure functions it calls are the legacy ones, unchanged.

Development only. Run with Python 3.12 + pydantic and the legacy engine on PYTHONPATH:
  PYTHONPATH=<site>:<oldsystem>/services/feature-engine/src python3.12 generate.py > ../test/parity-golden.json
"""
from __future__ import annotations

from dataclasses import fields, replace
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import random
import sys

from feature_engine.contracts import validate_active_policy_contract
from feature_engine.events import CrawlerObservationRecorded, EventValidationError, canonical_payload_hash
from feature_engine.applier import _pick_tier, _dispatch_slot
from feature_engine.clock_window import clock_due_at_for_day
from feature_engine.policy import (
    decide_about_due, decide_agent_due, decide_video_due, limit_about_slowdown, recent_publish_active, runtime_policy_configs,
)
from feature_engine.shared_features import (
    QUANTILE_PROBABILITIES, CollectionPrioritySignals, QuantileDistribution, ReferenceCatalog, SharedFeatureInputs,
    derive_recent_change_probability, derive_shared_features, subscriber_scale_cohort,
)
from feature_engine.state import ChannelFeatureState, apply_about_event, apply_about_stability_evidence, apply_agent_event, apply_video_event
from feature_engine.utc import as_utc, utc_day

POLICY_SOURCE = json.loads((Path(__file__).parent.parent / "src" / "clock_policy_v16_rule_7.json").read_text())
POLICY = validate_active_policy_contract(POLICY_SOURCE["policy"])
CONFIGS = runtime_policy_configs(POLICY)


def enrich(state: ChannelFeatureState, catalog: ReferenceCatalog, signals: CollectionPrioritySignals, observed_at: datetime) -> ChannelFeatureState:
    """FeatureObservationApplier._enrich_shared_state with the catalog and signals supplied."""
    shared = derive_shared_features(
        SharedFeatureInputs(
            subscriber_count=state.last_subscriber_count, subscriber_velocity_ewma=state.subscriber_velocity_ewma,
            view_velocity_ewma=state.view_velocity_ewma, recent30_video_count=state.recent30_video_count,
            last_publish_at=state.last_publish_at, about_identity_observed=state.last_about_observed_at is not None,
            about_observed=state.last_about_observed_at is not None, discovery_observed=state.last_discovery_observed_at is not None,
            recent_sampling_observed=state.last_recent_sampling_at is not None, agent_observed=state.last_agent_observed_at is not None,
        ),
        references=catalog, signals=signals, observed_at=observed_at,
    )
    reasons = list(state.fallback_reason_codes)
    if catalog.version is None:
        reasons.append("reference_distribution_unavailable")
    return replace(
        state,
        subscriber_size_percentile=shared.subscriber_size_percentile, subscriber_growth_percentile=shared.subscriber_growth_percentile,
        view_growth_percentile=shared.view_growth_percentile, growth_momentum=shared.growth_momentum,
        user_query_demand=shared.user_query_demand, data_incompleteness=shared.data_incompleteness, manual_priority=shared.manual_priority,
        collection_priority=shared.collection_priority, channel_activity=shared.channel_activity,
        recent_change_probability=derive_recent_change_probability(
            view_change=state.recent_view_change_ewma, engagement_change=state.recent_engagement_change_ewma,
            upload_change=state.recent_upload_change_ewma, channel_activity=shared.channel_activity,
        ),
        fallback_reason_codes=tuple(dict.fromkeys(reasons)), reference_distribution_version=shared.reference_distribution_version,
    )


class Channel:
    """One channel's feature state, clock row and per-kind checkpoints, applied like the legacy applier."""

    def __init__(self, channel_id: str, catalog: ReferenceCatalog, signals: CollectionPrioritySignals) -> None:
        self.channel_id, self.catalog, self.signals = channel_id, catalog, signals
        self.state = ChannelFeatureState()
        self.clock: dict | None = None
        self.sequence = {"about": 0, "video": 0, "agent": 0}

    def apply(self, event: CrawlerObservationRecorded) -> list[dict]:
        decisions: list[dict] = []
        if event.outcome != "failed":
            decisions = self._business(event)
        self.sequence[event.observation_kind] = event.kind_sequence
        return decisions

    def _business(self, event: CrawlerObservationRecorded) -> list[dict]:
        previous = self.state
        kind = event.observation_kind
        if kind == "about":
            transition = apply_about_event(previous, event, velocity_alpha=float(POLICY.about_config.velocity_ewma_alpha))
            if transition.business_state_changed:
                transition = replace(transition, state=enrich(transition.state, self.catalog, self.signals, event.observed_at))
                if CONFIGS.about.cadence_baseline_enabled:
                    transition = replace(transition, state=apply_about_stability_evidence(
                        previous, transition.state, observed_at=event.observed_at, outcome=event.outcome, baseline=transition.baseline))
            decision = decide_about_due(transition.state, observed_at=event.observed_at, outcome=event.outcome, baseline=transition.baseline, config=CONFIGS.about)
        elif kind == "video":
            transition = apply_video_event(previous, event, interval_alpha=float(POLICY.discovery_config.interval_ewma_alpha),
                                           change_alpha=float(POLICY.recent_sampling_config.change_ewma_alpha))
            if transition.business_state_changed:
                transition = replace(transition, state=enrich(transition.state, self.catalog, self.signals, event.observed_at))
            decision = decide_video_due(transition.state, observed_at=event.observed_at, discovery_outcome=transition.discovery_outcome,
                                        recent_sampling_outcome=transition.recent_sampling_outcome, discovery_baseline=transition.discovery_baseline,
                                        recent_sampling_baseline=transition.recent_sampling_baseline, discovery_config=CONFIGS.discovery,
                                        recent_sampling_config=CONFIGS.recent_sampling)
        else:
            transition = apply_agent_event(previous, event)
            if transition.business_state_changed:
                transition = replace(transition, state=enrich(transition.state, self.catalog, self.signals, event.observed_at))
            decision = decide_agent_due(transition.state, observed_at=event.observed_at, outcome=event.outcome, baseline=transition.baseline,
                                        output_changed=transition.output_changed, evidence_count=transition.evidence_count,
                                        channel_id=event.channel_id, config=CONFIGS.agent)
        self.state = transition.state
        if self.clock is None:
            return self._bootstrap(event, decision)
        if kind == "about" and not transition.baseline and CONFIGS.about.cadence_baseline_enabled:
            decision = limit_about_slowdown(decision, previous_tier_days=int(self.clock["about_tier"]))
        recalculations = self._recalculate(event)
        return self._update(event, decision, recalculations)

    def _bootstrap(self, event: CrawlerObservationRecorded, decision) -> list[dict]:
        base_at = as_utc(event.observed_at)
        agent_choices = tuple(t for t in POLICY.allowed_days if POLICY.agent_config.bootstrap_min_days <= t <= POLICY.agent_config.bootstrap_max_days)
        tiers = {
            "about": POLICY.about_config.baseline_interval_days if POLICY.about_config.dynamic_baseline_enabled else _pick_tier(event.channel_id, "about-bootstrap", (1, 3, 7)),
            "video": 7,
            "agent": POLICY.agent_config.baseline_interval_days if POLICY.agent_config.dynamic_baseline_enabled else _pick_tier(event.channel_id, "agent-bootstrap", agent_choices),
        }
        due_day = {k: base_at.date() + timedelta(days=t) for k, t in tiers.items()}
        tiers[event.observation_kind] = decision.tier_days
        due_day[event.observation_kind] = decision.due_day
        out = [decision_record(event.observation_kind, "bootstrap", decision.tier_days, decision.due_day, decision.reason_codes)]
        if event.observation_kind == "about" and (self.state.video_count_delta or 0) > 0 and recent_publish_active(self.state, event.observed_at):
            hint_days = int(POLICY.discovery_config.automatic_min_interval_days)
            hinted = base_at.date() + timedelta(days=hint_days)
            if hinted < due_day["video"]:
                due_day["video"], tiers["video"] = hinted, hint_days
                out.append(decision_record("video", "bootstrap", hint_days, hinted, ("about_video_count_hint", "recent_publish_active")))
        complete = lambda k: event.observed_at if event.observation_kind == k and event.outcome == "complete" else None
        self.clock = {
            "about_due_day": due_day["about"], "about_tier": tiers["about"], "about_last_complete_at": complete("about"),
            "video_due_day": due_day["video"], "video_tier": tiers["video"], "video_last_complete_at": complete("video"),
            "video_last_outcome": event.outcome if event.observation_kind == "video" else None,
            "agent_due_day": due_day["agent"], "agent_tier": tiers["agent"], "agent_last_complete_at": complete("agent"),
            "dispatch_slot": _dispatch_slot(event.channel_id),
        }
        return out

    def _recalculate(self, event: CrawlerObservationRecorded) -> dict:
        out = {}
        for kind, observed_at in (("about", self.state.last_about_observed_at), ("agent", self.state.last_agent_observed_at)):
            if kind == event.observation_kind or observed_at is None:
                continue
            if kind == "about" and not CONFIGS.about.dynamic_baseline_enabled and event.observation_kind != "video":
                continue
            if kind == "agent" and not CONFIGS.agent.dynamic_baseline_enabled:
                continue
            if self.sequence[kind] != 1:
                continue
            last_complete = self.clock[f"{kind}_last_complete_at"]
            outcome = "complete" if last_complete is not None and as_utc(last_complete) == as_utc(observed_at) else "partial"
            if kind == "about":
                recalculated = decide_about_due(self.state, observed_at=observed_at, outcome=outcome, baseline=True, config=CONFIGS.about)
            else:
                recalculated = decide_agent_due(self.state, observed_at=observed_at, outcome=outcome, baseline=True,
                                                output_changed=self.state.agent_output_changed, evidence_count=self.state.last_agent_evidence_count or 0,
                                                channel_id=event.channel_id, config=CONFIGS.agent)
            if recalculated.due_day >= self.clock[f"{kind}_due_day"]:
                continue
            specific = f"{kind}_cold_start_recalculation"
            if kind == "about" and event.observation_kind == "video":
                specific = "video_activity_recalculation"
            out[kind] = replace(recalculated, reason_codes=tuple(dict.fromkeys((*recalculated.reason_codes, specific, "cross_domain_cold_start_recalculation"))))
        return out

    def _update(self, event: CrawlerObservationRecorded, decision, recalculations: dict) -> list[dict]:
        c, kind = self.clock, event.observation_kind
        out = [decision_record(kind, "post_run", decision.tier_days, decision.due_day, decision.reason_codes)]
        if kind == "about":
            c["about_due_day"], c["about_tier"] = decision.due_day, decision.tier_days
            if (self.state.video_count_delta or 0) > 0 and recent_publish_active(self.state, event.observed_at):
                hint_days = CONFIGS.discovery.automatic_min_interval_days
                hinted = as_utc(event.observed_at).date() + timedelta(days=hint_days)
                if hinted < c["video_due_day"]:
                    c["video_due_day"], c["video_tier"] = hinted, hint_days
                    out.append(decision_record("video", "post_run", hint_days, hinted, ("about_video_count_hint", "recent_publish_active")))
        elif kind == "video":
            c["video_due_day"], c["video_tier"] = decision.due_day, decision.tier_days
        else:
            c["agent_due_day"], c["agent_tier"] = decision.due_day, decision.tier_days
        for k, r in recalculations.items():
            c[f"{k}_due_day"], c[f"{k}_tier"] = r.due_day, r.tier_days
            out.append(decision_record(k, "post_run", r.tier_days, r.due_day, r.reason_codes))
        if event.outcome == "complete":
            c[f"{kind}_last_complete_at"] = event.observed_at
        if kind == "video":
            c["video_last_outcome"] = event.outcome
        return out


def decision_record(kind: str, mode: str, tier: int, due_day: date, reasons) -> dict:
    return {"kind": kind, "mode": mode, "tier": tier, "due_day": due_day.isoformat(), "reason_codes": list(reasons)}


def jsonable(value):
    if isinstance(value, datetime):
        return as_utc(value).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, tuple):
        return [jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    return value


def state_json(state: ChannelFeatureState) -> dict:
    return {f.name: jsonable(getattr(state, f.name)) for f in fields(state)}


# ---- random inputs -------------------------------------------------------------------
def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def metric(rng: random.Random, previous: int | None) -> tuple[int | None, str]:
    status = rng.choices(["exact", "estimated", "unavailable", "unresolved"], [70, 20, 6, 4])[0]
    if status not in ("exact", "estimated"):
        return None, status
    base = previous if previous is not None else int(10 ** rng.uniform(1, 8))
    change = rng.choice([0, 0, 1, -1]) * int(base * rng.choice([0.0, 0.001, 0.01, 0.05, 0.3]))
    return max(0, base + change), status


def about_payload(rng: random.Random, last: dict) -> dict:
    payload = {}
    for name in ("subscriber_count", "total_view_count", "total_video_count"):
        value, status = metric(rng, last.get(name))
        if value is not None:
            last[name] = value
        payload[name], payload[f"{name}_status"] = value, status
    return payload


def discovery_payload(rng: random.Random, observed: datetime, outcome: str, counter: list[int]) -> dict:
    count = 0 if outcome == "partial" else rng.choices([0, 1, 2, 3, 5, 8], [25, 25, 20, 15, 10, 5])[0]
    first_seen, moment = [], observed - timedelta(hours=rng.uniform(1, 72))
    for position in range(1, count + 1):
        counter[0] += 1
        unknown = rng.random() < 0.08
        first_seen.append({"video_id": f"v{counter[0]:06d}", "position": position, "content_type": rng.choice(["video", "short", "video"]),
                           "published_at": None if unknown else iso(moment), "published_at_precision": "unknown" if unknown else rng.choice(["second", "second", "date_only"])})
        moment -= timedelta(days=rng.choice([0.2, 0.5, 1, 1, 2, 3, 7, 7, 14, 30]) * rng.uniform(0.7, 1.3))
    failures = rng.randint(0, count) if count and rng.random() < 0.15 else 0
    complete = outcome == "complete"
    return {"pages": rng.randint(1, 3), "items": count + rng.randint(0, 3), "anchor_matched": complete, "stop_reason": "anchor_matched" if complete else "max_pages",
            "parse_gap_count": 0, "first_seen": first_seen, "first_seen_count": count, "detail_success_count": count - failures, "detail_failure_count": failures}


def recent_payload(rng: random.Random) -> tuple[str, dict]:
    if rng.random() < 0.25:
        return "skipped", {"skipped_reason": "discovery_incomplete"}
    recent = rng.choices([0, 1, 3, 6, 12, 25, 40], [10, 10, 15, 20, 20, 15, 10])[0]
    selected = rng.randint(0, recent)
    failure = rng.choice([0, 0, 0, rng.randint(0, selected)])
    success = selected - failure
    comparable = rng.randint(0, success)
    view_changed = rng.randint(0, comparable)
    outcome = "complete" if failure == 0 else "partial" if success > 0 else "failed"
    return outcome, {"recent_count": recent, "stale_ratio": round(rng.random(), 3), "selected_count": selected, "success_count": success, "failure_count": failure,
                     "next_count": rng.randint(0, selected), "comparable_view_count": comparable, "view_changed_count": view_changed,
                     "view_delta_total": view_changed * rng.randint(0, 5000), "engagement_changed_count": rng.randint(0, success)}


TOPICS = ["AI", "Software", "Gaming", "Music", "Cooking", "Travel", "Finance", "Sports", "Education", "Comedy"]


def agent_payload(rng: random.Random, versioned: bool = False) -> dict:
    output = rng.choice("abc")
    topics = rng.sample(TOPICS, rng.randint(1, 3))
    payload = {"output_hash": f"sha256:{output * 64}", "category_level_1": rng.choice(["Technology", "Entertainment", "Lifestyle"]),
               "category_level_2": topics, "tag_count": rng.randint(0, 12), "evidence_count": rng.randint(0, 30),
               "active_subscriber_ratio": rng.choice([None, rng.randint(1, 80)]), "fulfilled_plan_count": 1}
    if versioned or rng.random() < 0.6:
        evidence = rng.sample("abcdef0123", rng.randint(1, 5))
        payload.update({"topic_tokens": topics, "evidence_fingerprints": [f"sha256:{e * 64}" for e in evidence],
                        "agent_version_hash": f"sha256:{rng.choice('89') * 64}", "evidence_count": len(evidence)})
    return payload


def build_event(rng: random.Random, channel: str, kind: str, sequence: int, observed: datetime, last: dict, counter: list[int], mode: str = "normal") -> dict:
    outcome = rng.choices(["complete", "partial", "failed"], [80, 10, 10])[0]
    if kind == "about":
        if outcome == "failed":
            payload = {"failure_kind": "transient", "attempt_count": 3}
        else:
            # The outcome follows the facts: all three metrics resolved is complete, otherwise partial.
            payload = about_payload(rng, last)
            resolved = sum(payload[f"{n}_status"] in ("exact", "estimated") for n in ("subscriber_count", "total_view_count", "total_video_count"))
            outcome = "complete" if resolved == 3 else "partial"
    elif kind == "video":
        if outcome == "failed":
            payload = {"failure_kind": "transient", "attempt_count": 3}
        else:
            # The Video outcome is complete only when both phases are; skipping Sampling needs partial Discovery.
            discovery_outcome = outcome
            sampling_outcome, sampling = recent_payload(rng)
            while sampling_outcome == "skipped" and discovery_outcome == "complete":
                sampling_outcome, sampling = recent_payload(rng)
            if mode == "new" and discovery_outcome == "partial":
                sampling_outcome, sampling = "skipped", {"skipped_reason": "discovery_incomplete"}
            outcome = "complete" if discovery_outcome == "complete" and sampling_outcome == "complete" else "partial"
            payload = {"discovery": {"outcome": discovery_outcome, "payload": discovery_payload(rng, observed, discovery_outcome, counter)},
                       "recent_sampling": {"outcome": sampling_outcome, "payload": sampling}}
    else:
        outcome = "failed" if outcome == "failed" else "complete"
        payload = agent_payload(rng, versioned=mode == "agent") if outcome != "failed" else {"failure_kind": "transient", "attempt_count": 3}
    return {"event_id": f"00000000-0000-4000-8000-{sequence:012d}", "event_type": "crawler.observation.recorded", "event_version": 1,
            "observation_id": f"00000000-0000-4000-9000-{sequence:012d}", "channel_id": channel, "observation_kind": kind, "kind_sequence": sequence,
            "observed_at": iso(observed), "outcome": outcome, "crawler_version": "parity", "payload_hash": payload_hash(kind, outcome, payload), "payload": payload}


def payload_hash(kind: str, outcome: str, payload: dict) -> str:
    # About facts are hashed as serialised in field order (AboutPayload.facts_hash); everything else canonically.
    if kind == "about" and outcome != "failed":
        return "sha256:" + hashlib.sha256(json.dumps(payload, separators=(",", ":")).encode()).hexdigest()
    return canonical_payload_hash(payload)


def new_system_video(mapping: dict, event: CrawlerObservationRecorded) -> tuple[dict, CrawlerObservationRecorded]:
    """Recent Sampling skipped after a complete Discovery. The legacy contract only skips after a partial
    one, so the validated event is patched; the engine functions themselves accept the combination."""
    if event.payload.recent_sampling_outcome == "skipped":
        return mapping, event
    skipped = {"outcome": "skipped", "payload": {"skipped_reason": "not_collected"}}
    mapping = {**mapping, "outcome": "partial", "payload": {**mapping["payload"], "recent_sampling": skipped}}
    payload = replace(event.payload, recent_sampling_outcome="skipped", recent_sampling=None)
    return mapping, replace(event, outcome="partial", payload=payload)


def random_catalog(rng: random.Random, as_of: date) -> tuple[ReferenceCatalog, list[dict]]:
    if rng.random() < 0.2:
        return ReferenceCatalog(()), []
    items = []
    def dist(feature: str, cohort: str, scale: float, signed: bool):
        # Six significant digits keep the fixture small; rounding is monotonic, so the values stay sorted.
        values = sorted(float(f"{(rng.gauss(0, scale) if signed else abs(rng.gauss(0, scale))):.6g}") for _ in QUANTILE_PROBABILITIES)
        if rng.random() < 0.2:  # ties exercise the equal-value branch
            values = sorted(round(v / scale, 1) * scale for v in values)
        return {"as_of_day": as_of.isoformat(), "cohort_key": cohort, "feature_name": feature, "sample_count": rng.choice([5, 19, 20, 50, 400]),
                "probabilities": list(QUANTILE_PROBABILITIES), "values": values}
    items.append(dist("subscriber_count", "all", 1e6, False))
    for feature, scale in (("subscriber_velocity_ewma", 500.0), ("view_velocity_ewma", 50000.0)):
        items.append(dist(feature, "all", scale, True))
        for cohort in ("subs:0-1k", "subs:1k-10k", "subs:10k-100k", "subs:100k-1m", "subs:1m-10m"):
            if rng.random() < 0.6:
                items.append(dist(feature, cohort, scale, True))
    catalog = ReferenceCatalog(tuple(QuantileDistribution(as_of_day=date.fromisoformat(i["as_of_day"]), cohort_key=i["cohort_key"], feature_name=i["feature_name"],
                                                          sample_count=i["sample_count"], probabilities=tuple(i["probabilities"]), values=tuple(i["values"])) for i in items))
    return catalog, items


def scenario(rng: random.Random, index: int) -> dict:
    channel = f"UCparity{index:04d}" + "x" * 10
    # Targeted modes cover branches random histories rarely reach: Agent version changes and high collection priority.
    # "new" is the new system before Recent Sampling exists: every Video run skips it (see new_system_video).
    mode = "agent" if index % 10 in (0, 1) else "priority" if index % 10 == 2 else "new" if index % 10 in (3, 4) else "normal"
    start = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(days=rng.randint(0, 200), seconds=rng.randint(0, 86399))
    catalog, catalog_json = random_catalog(rng, start.date())
    last: dict = {}
    signals = CollectionPrioritySignals(user_query_demand=1.0, manual_priority=1.0) if mode == "priority" else \
        CollectionPrioritySignals(user_query_demand=rng.choice([0.0, 0.0, 0.3, 1.0]), manual_priority=rng.choice([0.0, 0.0, 0.5, 1.0]))
    if mode == "priority":
        last["subscriber_count"] = int(10 ** rng.uniform(6.5, 8))
    sim = Channel(channel, catalog, signals)
    sequences, counter, moment, steps = {"about": 0, "video": 0, "agent": 0}, [0], start, []
    previous, missing = state_json(ChannelFeatureState()), object()
    for _ in range(rng.randint(2, 14)):
        kind = rng.choices(["about", "video", "agent"], [15, 15, 70] if mode == "agent" else [40, 40, 20])[0]
        for attempt in range(20):
            sequences[kind] += 1
            mapping = build_event(rng, channel, kind, sequences[kind], moment, last, counter, mode)
            try:
                event = CrawlerObservationRecorded.from_mapping(mapping)
                if mode == "new" and kind == "video" and event.outcome != "failed":
                    mapping, event = new_system_video(mapping, event)
                break
            except EventValidationError as error:
                sequences[kind] -= 1
                if attempt == 19:
                    raise SystemExit(f"cannot build a valid {kind} event: {error}")
        decisions = sim.apply(event)
        state = state_json(sim.state)
        # Only the fields this step changed; the first step is relative to a new ChannelFeatureState().
        steps.append({"event": mapping, "decisions": decisions, "state_changes": {k: v for k, v in state.items() if previous.get(k, missing) != v},
                      "clock": jsonable(sim.clock) if sim.clock is not None else None})
        previous = state
        moment += timedelta(hours=(rng.choice([1, 6, 12, 24]) if mode == "priority" else rng.choice([1, 6, 24, 24, 72, 168, 336, 720])) * rng.uniform(0.5, 1.5))
    return {"channel_id": channel, "catalog": catalog_json, "signals": {"user_query_demand": signals.user_query_demand, "manual_priority": signals.manual_priority}, "steps": steps}


if __name__ == "__main__":
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 400
    rng = random.Random(20261008)
    print(json.dumps({"source": {"repository": "crawlSystem", "commit": "e92d9227a5a3847430e5d062bea13227564ee419", "policy_version": POLICY.policy_version},
                      "initial_state": state_json(ChannelFeatureState()), "scenarios": [scenario(rng, i) for i in range(count)]}, separators=(",", ":")))
