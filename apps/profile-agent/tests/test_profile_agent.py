"""Profile Agent tests. Run through `npm run check:safe -- profile-agent` (needs the pinned
interpreter, wheels and model bundle under .runtime/profile-agent)."""
from __future__ import annotations

import copy
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

from qy_channel_profile.model_bundle import ModelBundle
from qy_channel_profile.processor import ChannelProfileProcessor

from profile_agent.adapter import InputError, Profiler, snapshot_value
from profile_agent.server import make_handler

HERE = Path(__file__).parent
INPUT = json.loads((HERE / "agent-input.json").read_text())
EXPECTED = HERE / "expected-profile.json"
PROFILER: Profiler | None = None


def profiler() -> Profiler:
    global PROFILER
    if PROFILER is None:
        PROFILER = Profiler(ChannelProfileProcessor(model_bundle=ModelBundle.load(os.environ["PROFILE_MODEL_MANIFEST"])))
        PROFILER.warm_up()
    return PROFILER


class AdapterTest(unittest.TestCase):
    def test_snapshot_flattens_metrics_and_uses_latest_observation(self) -> None:
        value = snapshot_value(INPUT)
        self.assertEqual(value["channel"]["subscriber_count"], 48200)
        self.assertEqual(value["contents"][0]["view_count"], 20000)
        self.assertEqual(value["contents"][0]["view_count_status"], "exact")
        self.assertEqual(value["contents"][2]["content_type"], "short")
        self.assertEqual(len(value["contents"][0]["comments_first_page"]["comments"]), 3)
        later = copy.deepcopy(INPUT)
        later["videos"][1]["comments_first_page"]["collected_at"] = "2026-09-21T00:00:00.5Z"
        self.assertEqual(snapshot_value(later)["as_of"], "2026-09-21T00:00:00.500000+00:00")

    def test_profile_is_deterministic_and_matches_golden(self) -> None:
        result = profiler().profile(INPUT)
        self.assertEqual(result, profiler().profile(copy.deepcopy(INPUT)))
        if os.environ.get("UPDATE_GOLDEN") == "1":
            EXPECTED.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        self.assertEqual(result, json.loads(EXPECTED.read_text()))

    def test_profile_without_videos_still_completes(self) -> None:
        result = profiler().profile({**INPUT, "videos": []})
        self.assertEqual(len(result["facts"]), 10)
        self.assertTrue(all(fact["value"] is not None for fact in result["facts"].values()))

    def test_newest_comment_fallback_profiles_without_changing_its_provenance(self) -> None:
        newest = copy.deepcopy(INPUT)
        newest["videos"][0]["comments_first_page"]["sort"] = "NEWEST_FIRST"
        snapshot = snapshot_value(newest)
        self.assertEqual(snapshot["contents"][0]["comments_first_page"]["sort"], "NEWEST_FIRST")
        self.assertEqual(snapshot["provenance"]["comment_page_source_status"], "mixed_first_page")
        result = profiler().profile(newest)
        self.assertEqual(len(result["facts"]), 10)
        self.assertIn("FIRST_PAGE_COMMENTS_SAMPLE_USED", result["diagnostics"])
        self.assertNotIn("TOP_COMMENTS_SAMPLE_USED", result["diagnostics"])
        self.assertEqual(result, profiler().profile(copy.deepcopy(newest)))

    def test_unknown_comment_sort_is_rejected(self) -> None:
        broken = copy.deepcopy(INPUT)
        broken["videos"][0]["comments_first_page"]["sort"] = "UNKNOWN"
        with self.assertRaises(InputError):
            profiler().profile(broken)

    def test_malformed_input_is_rejected(self) -> None:
        broken = copy.deepcopy(INPUT)
        del broken["about"]["channel_id"]
        with self.assertRaises(InputError):
            profiler().profile(broken)


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = HTTPServer(("127.0.0.1", 0), make_handler(profiler()))
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, body: bytes) -> tuple[int, dict]:
        request = urllib.request.Request(f"{self.base}/v1/profile", data=body, headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_health_and_profile(self) -> None:
        with urllib.request.urlopen(f"{self.base}/healthz", timeout=5) as response:
            self.assertEqual(json.loads(response.read())["model_version"], profiler().model_version)
        status, body = self.post(json.dumps(INPUT).encode())
        self.assertEqual(status, 200)
        self.assertEqual(body, json.loads(EXPECTED.read_text()))

    def test_invalid_input_is_422(self) -> None:
        self.assertEqual(self.post(b"[1]")[0], 422)
        self.assertEqual(self.post(b"{not json")[0], 422)
        self.assertEqual(self.post(json.dumps({"about": {}}).encode())[0], 422)


if __name__ == "__main__":
    unittest.main()
