"""Exercise a fresh local Compose stack through its public HTTP origin.

This creates a test operator and visit in the selected stack. It refuses
non-loopback targets so it cannot be used against production by accident.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import urllib.error
import urllib.parse
import urllib.request
import uuid


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:5175")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        parser.error("smoke test requires a local HTTP origin")

    cookies = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

    def request(path: str, data: dict[str, str] | None = None):
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        req = urllib.request.Request(
            base + path,
            data=body,
            headers={"User-Agent": "Mozilla/5.0 (stack-smoke)", "Origin": base},
        )
        with client.open(req, timeout=15) as response:
            return response.status, response.read().decode("utf-8")

    status, health = request("/healthz")
    assert status == 200 and json.loads(health)["ok"] is True
    for path in (
        "/",
        "/app",
        "/claude",
        "/openai",
        "/gemini",
        "/leaderboard",
        "/faq",
        "/partner/register",
    ):
        status, _ = request(path)
        assert status == 200, f"{path}: HTTP {status}"
    status, slots = request("/api/ad-slots")
    assert status == 200 and isinstance(json.loads(slots), dict)
    assert json.loads(request("/partner/session")[1])["authenticated"] is False

    marker = uuid.uuid4().hex[:12]
    site = f"audit-{marker}.example"
    status, page = request(
        "/partner/register",
        {
            "name": f"audit-{marker}",
            "password": "stack-smoke-password-123",
            "site_name": "验收中转站",
            "domain": site,
            "description": "隔离环境中的验收申请",
            "contact_method": "qq",
            "contact_handle": "12345678",
        },
    )
    assert status == 200 and site in page
    assert json.loads(request("/partner/session")[1])["authenticated"] is True
    assert request("/api/visit", {})[0] == 204
    try:
        request("/api/probe", {
            "base_url": "http://127.0.0.1:9/v1",
            "api_key": "sk-should-not-be-sent",
        })
    except urllib.error.HTTPError as error:
        assert error.code == 400
    else:
        raise AssertionError("public verifier accepted a private HTTP target")
    print(f"stack smoke passed: routes, session, site submission, visit ({site})")


if __name__ == "__main__":
    main()
