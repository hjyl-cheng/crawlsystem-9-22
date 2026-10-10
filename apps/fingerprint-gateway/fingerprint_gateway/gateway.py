"""Browser-fingerprint transport for YouTube collection (plan R2), ported from the legacy gateway.

Runs next to the execution worker (same Pod, loopback only). YouTube.js sends every request here;
the gateway repeats it with curl_cffi impersonating a desktop browser's TLS / HTTP2 fingerprint,
through the proxy named on the request, with the cookies of the browser profile bound to that proxy.

Differences from the legacy gateway (services/qybullmq/scripts/fingerprint_gateway.py):
- the proxy comes with each request (a worker uses several proxies at once); one profile's cookies
  are shared across its requests, as the legacy Rota slot kept its identity across route changes;
- profiles are upserted / removed one at a time instead of replacing the whole set;
- requests without a proxy are refused unless FINGERPRINT_ALLOW_DIRECT=1 (tests only);
- /v1/stats reports request and failure counts for the console.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import http.cookiejar
import json
import os
import signal
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Any

from aiohttp import web
from curl_cffi import CurlOpt
from curl_cffi.requests import AsyncSession
from curl_cffi.requests.exceptions import ProxyError, RequestException, SSLError

HOP_BY_HOP = {
    "connection", "content-encoding", "content-length", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade",
}
ALLOWED_TARGETS = ("https://", "http://")
# Only for credential-free HTTPS proxies whose own certificate the operator opted not to verify:
# the hop to the proxy is unverified, TLS to YouTube inside the tunnel still is.
INSECURE_PROXY_TLS = {CurlOpt.PROXY_SSL_VERIFYPEER: 0, CurlOpt.PROXY_SSL_VERIFYHOST: 0}


def decode_metadata(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    padding = "=" * (-len(value) % 4)
    return json.loads(base64.urlsafe_b64decode(value + padding).decode("utf-8"))


def encode_metadata(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def serialize_cookies(session: AsyncSession) -> dict[str, Any]:
    jar = getattr(session.cookies, "jar", session.cookies)
    return {"cookies": [{"name": c.name, "value": c.value, "domain": c.domain, "path": c.path,
                         "secure": bool(c.secure), "expires": c.expires} for c in jar]}


def restore_cookies(session: AsyncSession, state: dict[str, Any] | None) -> None:
    for cookie in (state or {}).get("cookies") or []:
        domain = str(cookie.get("domain") or "")
        session.cookies.jar.set_cookie(http.cookiejar.Cookie(
            version=0, name=str(cookie.get("name") or ""), value=str(cookie.get("value") or ""),
            port=None, port_specified=False, domain=domain, domain_specified=bool(domain),
            domain_initial_dot=domain.startswith("."), path=str(cookie.get("path") or "/"), path_specified=True,
            secure=bool(cookie.get("secure")), expires=cookie.get("expires"), discard=cookie.get("expires") is None,
            comment=None, comment_url=None, rest={}, rfc2109=False))


@dataclass
class ProfileSession:
    profile_id: str
    engine: str
    impersonate_target: str
    user_agent: str
    session: AsyncSession
    semaphore: asyncio.Semaphore
    max_clients: int
    insecure: AsyncSession | None = None
    reset_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def for_proxy(self, insecure_tls: bool) -> AsyncSession:
        """curl options are per session: unverified proxy hops get their own session over the same cookie jar."""
        if not insecure_tls:
            return self.session
        if self.insecure is None:
            self.insecure = AsyncSession(max_clients=self.max_clients, cookies=self.session.cookies.jar, curl_options=INSECURE_PROXY_TLS)
        return self.insecure

    async def close(self) -> None:
        await self.session.close()
        if self.insecure is not None:
            await self.insecure.close()

    async def reset_after_failure(self, failed: AsyncSession) -> bool:
        """A broken connection pool is replaced; the cookie jar (the identity) carries over."""
        async with self.reset_lock:
            if failed is self.session:
                self.session = AsyncSession(max_clients=self.max_clients, cookies=failed.cookies.jar)
            elif failed is self.insecure:
                self.insecure = None
            else:
                return False
            await failed.close()
            return True


def transport_failure_kind(error: RequestException) -> str:
    return "proxy_transport" if isinstance(error, (ProxyError, SSLError)) else "upstream_transient"


def curl_error_code(error: RequestException) -> int | None:
    try:
        return int(getattr(error, "code", None))
    except (TypeError, ValueError):
        return None


def response_headers(response: Any) -> dict[str, str]:
    return {str(k): str(v) for k, v in response.headers.items() if str(k).lower() not in HOP_BY_HOP}


class Gateway:
    def __init__(self, allow_direct: bool = False) -> None:
        self.profiles: dict[str, ProfileSession] = {}
        self.allow_direct = allow_direct
        self.started_at = time.time()
        self.counts: Counter[str] = Counter()
        self.recent: deque[tuple[float, bool]] = deque()

    async def upsert_profile(self, request: web.Request) -> web.Response:
        profile_id = request.match_info["profile_id"]
        payload = await request.json()
        max_clients = max(1, min(int(payload.get("max_connections") or 2), 4))
        session = AsyncSession(max_clients=max_clients)
        restore_cookies(session, payload.get("cookie_state"))
        current = self.profiles.pop(profile_id, None)
        if current:
            await current.close()
        self.profiles[profile_id] = ProfileSession(
            profile_id=profile_id, engine=str(payload.get("engine") or "youtubejs_chrome"),
            impersonate_target=str(payload.get("impersonate_target") or "chrome136"),
            user_agent=str(payload.get("user_agent") or ""), session=session,
            semaphore=asyncio.Semaphore(max_clients), max_clients=max_clients)
        return web.json_response({"ok": True, "profiles": len(self.profiles)})

    async def remove_profile(self, request: web.Request) -> web.Response:
        current = self.profiles.pop(request.match_info["profile_id"], None)
        if current:
            await current.close()
        return web.json_response({"ok": True, "profiles": len(self.profiles)})

    async def snapshot(self, request: web.Request) -> web.Response:
        profile = self.profiles.get(request.match_info["profile_id"])
        if not profile:
            raise web.HTTPNotFound(text="profile not configured")
        return web.json_response(serialize_cookies(profile.session))

    async def stats(self, _request: web.Request) -> web.Response:
        cutoff = time.time() - 3600
        while self.recent and self.recent[0][0] < cutoff:
            self.recent.popleft()
        return web.json_response({"profiles": len(self.profiles), "since": int(self.started_at), "counts": dict(self.counts),
                                  "requests_last_hour": len(self.recent), "blocked_last_hour": sum(blocked for _, blocked in self.recent)})

    async def fetch(self, request: web.Request) -> web.Response:
        profile = self.profiles.get(request.match_info["profile_id"])
        if not profile:
            raise web.HTTPNotFound(text="profile not configured")
        url = str(decode_metadata(request.headers.get("x-fingerprint-url"), ""))
        if not url.startswith(ALLOWED_TARGETS):
            raise web.HTTPBadRequest(text="only HTTP(S) fingerprint requests are allowed")
        proxy = decode_metadata(request.headers.get("x-fingerprint-proxy"), None) or {}
        proxy_url = str(proxy.get("url") or "")
        if not proxy_url and not self.allow_direct:
            raise web.HTTPBadRequest(text="a proxy is required")
        insecure_tls = bool(proxy.get("insecure_tls")) and "@" not in proxy_url
        method = str(request.headers.get("x-fingerprint-method") or "GET").upper()
        headers = decode_metadata(request.headers.get("x-fingerprint-headers"), {})
        headers = {k: v for k, v in headers.items() if k.lower() != "user-agent"}
        headers["User-Agent"] = profile.user_agent
        timeout = max(1.0, int(request.headers.get("x-fingerprint-timeout-ms") or "30000") / 1000)
        allow_redirects = request.headers.get("x-fingerprint-redirect", "follow") != "manual"
        body = await request.read()
        self.counts["requests"] += 1
        started = time.time()
        async with profile.semaphore:
            active = profile.for_proxy(insecure_tls)
            try:
                response = await active.request(
                    method, url, headers=headers, data=body if body else None, proxy=proxy_url or None,
                    impersonate=profile.impersonate_target, timeout=timeout, allow_redirects=allow_redirects)
            except RequestException as error:
                self.recent.append((started, False))
                kind = transport_failure_kind(error)
                self.counts[f"failure:{kind}"] += 1
                reset = await profile.reset_after_failure(active)
                return web.json_response({"error": "fingerprint transport request failed", "error_type": type(error).__name__,
                                          "curl_code": curl_error_code(error), "failure_kind": kind, "session_reset": reset}, status=502)
        status = response.status_code
        try:
            reason = str(json.loads(response.content).get("playabilityStatus", {}).get("reason", "")).lower()
            challenge = any(marker in reason for marker in ("not a bot", "unusual traffic", "captcha", "não é um robô"))
        except (ValueError, AttributeError):
            challenge = any(marker in response.content.lower() for marker in (b'id="captcha-form', b"our systems have detected unusual traffic"))
        blocked = status == 429 or challenge
        self.recent.append((started, blocked))
        # Also prune on traffic: the rolling window remains bounded between heartbeats.
        while self.recent and self.recent[0][0] < time.time() - 3600:
            self.recent.popleft()
        if not isinstance(status, int) or isinstance(status, bool) or not 200 <= status <= 599:
            kind = "proxy_transport" if status == 0 else "invalid_target_status"
            self.counts[f"failure:{kind}"] += 1
            return web.json_response({"error": "fingerprint target returned an invalid HTTP status", "error_type": "InvalidTargetHttpStatus",
                                      "failure_kind": kind, "target_status_raw": status if isinstance(status, (int, str)) else repr(status)}, status=502)
        self.counts[f"status:{status // 100}xx"] += 1
        target_headers = response_headers(response)
        return web.Response(status=200, body=response.content, headers={
            "content-type": target_headers.get("content-type", "application/octet-stream"),
            "x-fingerprint-response-status": str(status),
            "x-fingerprint-response-headers": encode_metadata(target_headers)})

    async def close(self) -> None:
        profiles = list(self.profiles.values())
        self.profiles.clear()
        await asyncio.gather(*(p.close() for p in profiles), return_exceptions=True)


def application(gateway: Gateway) -> web.Application:
    app = web.Application(client_max_size=16 * 1024 * 1024)
    async def health(_request: web.Request) -> web.Response:
        return web.json_response({"ok": True})
    app.router.add_get("/health", health)
    app.router.add_get("/v1/stats", gateway.stats)
    app.router.add_put("/v1/profiles/{profile_id}", gateway.upsert_profile)
    app.router.add_delete("/v1/profiles/{profile_id}", gateway.remove_profile)
    app.router.add_get("/v1/profiles/{profile_id}/snapshot", gateway.snapshot)
    app.router.add_post("/v1/fetch/{profile_id}", gateway.fetch)
    return app


async def run(host: str, port: int) -> None:
    gateway = Gateway(allow_direct=os.environ.get("FINGERPRINT_ALLOW_DIRECT") == "1")
    runner = web.AppRunner(application(gateway), access_log=None, handler_cancellation=True)
    await runner.setup()
    await web.TCPSite(runner, host, port).start()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    await gateway.close()
    await runner.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3099)
    args = parser.parse_args()
    asyncio.run(run(args.host, args.port))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
