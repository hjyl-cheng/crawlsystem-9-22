"""Maps the Store's Agent input snapshot onto the profile processor and back.

Input: `AgentInput` (packages/contracts) — this plan's channel facts and available
target videos. Output: the `AgentResult` fields other than channel_id/input_hash.
The mapping is a pure function of the input: the snapshot boundary (`as_of`) is the
latest observation inside it, never the wall clock, so a retried activity produces
the same payload and the same idempotent submission.
"""
from __future__ import annotations

from typing import Any

from qy_channel_profile.agent_contract import to_agent_payload
from qy_channel_profile.contracts import FACT_FIELDS, AnalysisPolicy, ChannelSnapshot, ProfileAnalysisRequest, parse_datetime
from qy_channel_profile.errors import ContractError, SnapshotError
from qy_channel_profile.processor import PROCESSOR_VERSION, ChannelProfileProcessor


class InputError(ValueError):
    """The input cannot be analysed; retrying the same input will not help."""


def _metric(value: Any) -> tuple[Any, str, str]:
    if not isinstance(value, dict):
        return None, "unresolved", ""
    return value.get("value"), str(value.get("status") or "unresolved"), str(value.get("source") or "")


def _observations(agent_input: dict[str, Any]) -> list[Any]:
    stamps = [agent_input["about"]["observed_at"]]
    for video in agent_input["videos"]:
        stamps.append(video["observed_at"])
        page = video.get("comments_first_page")
        if isinstance(page, dict) and page.get("collected_at"):
            stamps.append(page["collected_at"])
    return [parse_datetime(stamp, field_name="observed_at") for stamp in stamps]


def snapshot_value(agent_input: dict[str, Any]) -> dict[str, Any]:
    about = agent_input["about"]
    subscribers, _, _ = _metric(about.get("subscriber_count"))
    views, _, _ = _metric(about.get("total_view_count"))
    video_count, _, _ = _metric(about.get("total_video_count"))
    channel = {
        "channel_id": about["channel_id"],
        "channel_url": about["channel_url"],
        "handle": about.get("handle"),
        "title": about.get("title"),
        "country": about.get("country"),
        "country_source": about.get("country_source"),
        "country_code": about.get("country_code"),
        "country_canonical_name": None,
        "avatar_url": about.get("avatar_url"),
        "summary": about.get("summary"),
        "keywords": about.get("keywords") or [],
        "about_description": about.get("about_description"),
        "joined_at": about.get("joined_at"),
        "external_links": about.get("external_links") or [],
        "is_verified": about.get("is_verified"),
        "subscriber_count": subscribers,
        "total_view_count": views,
        "total_video_count": video_count,
        "channel_extractor": about.get("source"),
    }
    contents = []
    for video in agent_input["videos"]:
        views, views_status, views_source = _metric(video.get("view_count"))
        likes, likes_status, likes_source = _metric(video.get("like_count"))
        comments, comments_status, comments_source = _metric(video.get("comment_count"))
        duration, duration_status, duration_source = _metric(video.get("duration_seconds"))
        row = {
            "source_content_id": video["source_content_id"],
            "content_type": video["content_type"],
            "content_type_source": video.get("content_type_source"),
            "title": video.get("title"),
            "description": video.get("description"),
            "description_status": "exact" if video.get("description") else "empty",
            "description_source": video.get("published_at_source") or "",
            "thumbnail_url": video.get("thumbnail_url"),
            "keywords": video.get("keywords") or [],
            "hashtags": video.get("hashtags") or [],
            "published_at": video.get("published_at"),
            "published_at_status": video.get("published_at_status"),
            "published_at_source": video.get("published_at_source"),
            "published_at_precision": video.get("published_at_precision"),
            "first_seen_at": None,
            "view_count": views, "view_count_status": views_status, "view_count_source": views_source,
            "like_count": likes, "like_count_status": likes_status, "like_count_source": likes_source,
            "comment_count": comments, "comment_count_status": comments_status, "comment_count_source": comments_source,
            "comments_disabled": video.get("comments_disabled"),
            "duration_seconds": duration, "duration_status": duration_status, "duration_source": duration_source,
            "extractor_version": video.get("extractor_version"),
        }
        if isinstance(video.get("comments_first_page"), dict):
            row["comments_first_page"] = video["comments_first_page"]
        contents.append(row)
    return {
        "channel": channel,
        "contents": contents,
        "as_of": max(_observations(agent_input)).isoformat(),
        "replay_quality": "current_exact",
        "provenance": {"data_lineage_version": "crawlsystem-m2", "comment_page_source_status": "top_comments_first_page"},
    }


def _confidence(fact: Any) -> str:
    score = min(max(0.0, min(1.0, float(fact.model_confidence))), max(0.0, min(1.0, float(fact.evidence_confidence))))
    return "high" if score >= 0.8 else "medium" if score >= 0.55 else "low"


def _evidence(field: str, fact: Any) -> list[str]:
    refs = list(dict.fromkeys(str(ref).strip() for ref in fact.evidence_refs if str(ref).strip()))
    if not refs:
        refs = [f"Local {field} estimate; source_type={fact.source_type}; truth_status={fact.truth_status}; evidence_strength={fact.evidence_strength}"]
    return [ref[:1000] for ref in refs[:20]]


class Profiler:
    def __init__(self, processor: ChannelProfileProcessor) -> None:
        self.processor = processor
        bundle = processor.model_bundle
        self.field_status = dict(bundle.manifest.field_status)
        self.model_version = ":".join([
            "qy-channel-profile", PROCESSOR_VERSION, bundle.version, processor.prior_catalog.version,
        ])

    def warm_up(self) -> None:
        bundle = self.processor.model_bundle
        for descriptor in bundle.manifest.artifacts:
            if descriptor.status == "active":
                bundle._load(descriptor.artifact_id)  # noqa: SLF001 - the bundle loads lazily; load before serving

    def profile(self, agent_input: dict[str, Any]) -> dict[str, Any]:
        try:
            snapshot = ChannelSnapshot.from_mapping(snapshot_value(agent_input))
        except (KeyError, TypeError, ValueError, SnapshotError) as error:
            raise InputError(f"{type(error).__name__}: {error}") from error
        url = str(snapshot.channel["channel_url"])
        request = ProfileAnalysisRequest(channel_id=snapshot.channel_id, input_url=url, as_of=snapshot.as_of, policy=AnalysisPolicy.COMPLETE_ESTIMATE)
        result = self.processor.analyze(request, snapshot)
        try:
            # Fails when any field is abstained: an incomplete profile is never submitted.
            payload = to_agent_payload(result)
        except ContractError as error:
            raise InputError(str(error)) from error
        facts = {}
        for field in FACT_FIELDS:
            fact = result.facts[field]
            facts[field] = {
                "value": payload[field],
                "source": f"local_profile:{fact.source_type or 'estimate'}"[:120],
                "confidence": _confidence(fact),
                "evidence": _evidence(field, fact),
                "source_urls": [url],
                # Why an estimate is only an estimate (the bundle's field status); observed values need no reason.
                "reason": None if fact.source_type == "observed" else self.field_status.get(field),
            }
        return {
            "model_version": self.model_version,
            "taxonomy_version": result.processor["taxonomy_version"],
            "observed_at": snapshot.as_of.isoformat().replace("+00:00", "Z"),
            "facts": facts,
            "diagnostics": [d.get("code") for d in result.diagnostics if isinstance(d, dict)],
        }
