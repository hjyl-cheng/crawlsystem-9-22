"""Fingerprint gateway: profiles, request passthrough, cookies and failure classification."""
import json
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from fingerprint_gateway.gateway import Gateway, application, decode_metadata, encode_metadata

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"


async def target_app() -> web.Application:
    async def echo(request: web.Request) -> web.Response:
        body = await request.read()
        response = web.json_response({"method": request.method, "ua": request.headers.get("User-Agent"), "x": request.headers.get("X-Test"),
                                      "cookie": request.headers.get("Cookie"), "body": body.decode()}, status=201, headers={"X-Target": "yes"})
        response.set_cookie("VISITOR", "v1", path="/")
        return response
    app = web.Application()
    app.router.add_route("*", "/echo", echo)
    return app


class GatewayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.target = TestServer(await target_app()); await self.target.start_server()
        self.gateway = Gateway(allow_direct=True)
        self.client = TestClient(TestServer(application(self.gateway))); await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close(); await self.target.close(); await self.gateway.close()

    async def profile(self, cookie_state=None) -> None:
        response = await self.client.put("/v1/profiles/p1", json={"engine": "youtubejs_chrome", "impersonate_target": "chrome136", "user_agent": UA, "cookie_state": cookie_state})
        self.assertEqual(response.status, 200)

    def fetch(self, url: str, *, method="POST", headers=None, body=b"", proxy=None, profile="p1"):
        meta = {"x-fingerprint-url": encode_metadata(url), "x-fingerprint-method": method,
                "x-fingerprint-headers": encode_metadata(headers or {}), "x-fingerprint-timeout-ms": "5000"}
        if proxy is not None:
            meta["x-fingerprint-proxy"] = encode_metadata(proxy)
        return self.client.post(f"/v1/fetch/{profile}", headers=meta, data=body)

    async def test_requests_pass_through_with_the_profile_user_agent_and_keep_cookies(self) -> None:
        await self.profile()
        url = str(self.target.make_url("/echo"))
        response = await self.fetch(url, headers={"X-Test": "1", "User-Agent": "node"}, body=b'{"a":1}')
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["x-fingerprint-response-status"], "201")
        target_headers = {k.lower(): v for k, v in decode_metadata(response.headers["x-fingerprint-response-headers"], {}).items()}
        self.assertEqual(target_headers["x-target"], "yes")
        self.assertNotIn("set-cookie", target_headers, "cookies stay in the profile, never in the response")
        echoed = json.loads(await response.read())
        self.assertEqual([echoed["method"], echoed["ua"], echoed["x"], echoed["body"]], ["POST", UA, "1", '{"a":1}'])
        second = json.loads(await (await self.fetch(url, method="GET")).read())
        self.assertIn("VISITOR=v1", second["cookie"] or "", "the profile keeps the cookie the target set")
        snapshot = await (await self.client.get("/v1/profiles/p1/snapshot")).json()
        self.assertEqual([c["name"] for c in snapshot["cookies"]], ["VISITOR"])
        stats = await (await self.client.get("/v1/stats")).json()
        self.assertEqual([stats["profiles"], stats["counts"]["requests"], stats["counts"]["status:2xx"]], [1, 2, 2])

    async def test_saved_cookies_are_restored_and_a_profile_can_be_removed(self) -> None:
        await self.profile({"cookies": [{"name": "SAVED", "value": "s", "domain": "127.0.0.1", "path": "/", "secure": False, "expires": None}]})
        echoed = json.loads(await (await self.fetch(str(self.target.make_url("/echo")), method="GET")).read())
        self.assertIn("SAVED=s", echoed["cookie"] or "")
        self.assertEqual((await self.client.delete("/v1/profiles/p1")).status, 200)
        self.assertEqual((await self.fetch(str(self.target.make_url("/echo")))).status, 404)

    async def test_refusals_and_failure_classification(self) -> None:
        await self.profile()
        self.assertEqual((await self.fetch("ftp://example.com/")).status, 400)
        self.assertEqual((await self.fetch(str(self.target.make_url("/echo")), profile="nope")).status, 404)
        self.gateway.allow_direct = False
        self.assertEqual((await self.fetch(str(self.target.make_url("/echo")))).status, 400, "no proxy, no request")
        self.gateway.allow_direct = True
        failed = await self.fetch("http://127.0.0.1:9/unreachable", method="GET")
        self.assertEqual(failed.status, 502)
        payload = await failed.json()
        self.assertEqual(payload["failure_kind"], "upstream_transient")
        self.assertNotIn("127.0.0.1:9", json.dumps(payload), "no target URL in the error")
        # As in the legacy gateway, an unreachable proxy is a transient upstream failure carrying curl code 7;
        # the worker tells the proxy manager about it from the code (the proxy's health), not from the kind.
        broken_proxy = await (await self.fetch(str(self.target.make_url("/echo")), method="GET", proxy={"url": "http://127.0.0.1:9"})).json()
        self.assertEqual([broken_proxy["failure_kind"], broken_proxy["curl_code"]], ["upstream_transient", 7])


if __name__ == "__main__":
    unittest.main()
