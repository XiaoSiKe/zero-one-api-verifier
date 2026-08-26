"""Security boundaries for public relay submissions."""

from __future__ import annotations

import ipaddress

import httpx
import pytest

from web import jobs, probe, ratelimit, server, target_safety

PUBLIC_IP = ipaddress.ip_address("93.184.216.34")
PRIVATE_IP = ipaddress.ip_address("127.0.0.1")


@pytest.fixture(autouse=True)
def _clean_rate_state():
    ratelimit.reset()
    yield
    ratelimit.reset()


@pytest.mark.asyncio
async def test_public_https_target_is_accepted(monkeypatch):
    monkeypatch.delenv("VERIDROP_ALLOW_PRIVATE_TARGETS", raising=False)
    monkeypatch.setattr(target_safety, "_resolve_host", lambda host, port: {PUBLIC_IP})
    assert (
        await target_safety.validate_target_url("https://relay.example/v1/")
        == "https://relay.example/v1"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "http://relay.example/v1",
        "https://user:pass@relay.example/v1",
        "https://relay.example/v1?key=value",
        "https://relay.example/v1#fragment",
    ],
)
async def test_public_target_rejects_unsafe_url_shapes(monkeypatch, url):
    monkeypatch.delenv("VERIDROP_ALLOW_PRIVATE_TARGETS", raising=False)
    monkeypatch.setattr(target_safety, "_resolve_host", lambda host, port: {PUBLIC_IP})
    with pytest.raises(target_safety.UnsafeTargetError):
        await target_safety.validate_target_url(url)


@pytest.mark.asyncio
async def test_private_and_mixed_dns_answers_are_rejected(monkeypatch):
    monkeypatch.delenv("VERIDROP_ALLOW_PRIVATE_TARGETS", raising=False)
    monkeypatch.setattr(
        target_safety,
        "_resolve_host",
        lambda host, port: {PUBLIC_IP, PRIVATE_IP},
    )
    with pytest.raises(target_safety.UnsafeTargetError):
        await target_safety.validate_target_url("https://relay.example/v1")


@pytest.mark.asyncio
async def test_second_dns_check_blocks_public_to_private_rebinding(monkeypatch):
    monkeypatch.delenv("VERIDROP_ALLOW_PRIVATE_TARGETS", raising=False)
    answers = iter(({PUBLIC_IP}, {PRIVATE_IP}))
    monkeypatch.setattr(
        target_safety, "_resolve_host", lambda host, port: next(answers)
    )
    with pytest.raises(target_safety.UnsafeTargetError):
        await target_safety.validate_target_url("https://relay.example/v1")


@pytest.mark.asyncio
async def test_explicit_local_mode_allows_http_private_target(monkeypatch):
    monkeypatch.setenv("VERIDROP_ALLOW_PRIVATE_TARGETS", "1")
    monkeypatch.setattr(target_safety, "_resolve_host", lambda host, port: {PRIVATE_IP})
    assert (
        await target_safety.validate_target_url("http://127.0.0.1:9000/v1")
        == "http://127.0.0.1:9000/v1"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "host",
    ["127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1"],
)
async def test_loopback_metadata_and_mapped_ipv6_are_rejected(monkeypatch, host):
    monkeypatch.delenv("VERIDROP_ALLOW_PRIVATE_TARGETS", raising=False)
    monkeypatch.setattr(
        target_safety,
        "_resolve_host",
        lambda resolved_host, port: {ipaddress.ip_address(host)},
    )
    url_host = f"[{host}]" if ":" in host else host
    with pytest.raises(target_safety.UnsafeTargetError):
        await target_safety.validate_target_url(f"https://{url_host}/v1")


def test_recursive_redaction_removes_keys_from_nested_public_data():
    secret = "sk-super-secret-value"
    value = {
        "details": {
            "authorization": f"Bearer {secret}",
            "nested": [f"upstream echoed {secret}", {"api-key": secret}],
        },
        "safe": "keep me",
    }
    out = jobs.redact_sensitive(value, (secret,))
    assert secret not in repr(out)
    assert out["details"]["authorization"] == "[REDACTED]"
    assert out["details"]["nested"][1]["api-key"] == "[REDACTED]"
    assert out["safe"] == "keep me"


def test_rate_limiter_caps_one_off_client_buckets(monkeypatch):
    monkeypatch.setattr(ratelimit, "_MAX_BUCKETS", 3)
    for index in range(20):
        ratelimit.check_rate(f"detect:198.51.100.{index}", limit=1, window_s=60)
    assert len(ratelimit._HITS) <= 3


@pytest.mark.asyncio
async def test_probe_rejects_oversized_model_list(monkeypatch):
    real_init = httpx.AsyncClient.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                content=b"x" * (probe.MAX_RESPONSE_BYTES + 1),
            )
        )
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)
    probe.clear_cache()
    result = await probe.probe_relay("https://relay.example/v1", "sk-test-key")
    assert result["ok"] is False
    assert "过大" in result["error"]


async def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=server.app),
        base_url="http://testserver",
    )


@pytest.mark.asyncio
async def test_legacy_detect_keeps_deprecation_headers(monkeypatch):
    async def safe_target(url):
        return url

    async def preflight(*args, **kwargs):
        return None

    async def submit(*args, **kwargs):
        return "legacy01"

    monkeypatch.setattr(server, "validate_target_url", safe_target)
    monkeypatch.setattr(server, "_preflight_or_422", preflight)
    monkeypatch.setattr(server.jobs, "submit", submit)

    async with await _client() as client:
        response = await client.post(
            "/api/detect",
            data={
                "base_url": "https://relay.example/v1",
                "api_key": "sk-test-key",
                "model": "gpt-4o",
                "mode": "quick",
            },
        )
    assert response.status_code == 200
    assert response.headers["Deprecation"] == "true"
    assert response.headers["Link"] == '</api/detect/claude>; rel="successor-version"'


@pytest.mark.asyncio
async def test_detect_has_independent_rate_limit_and_retry_header(monkeypatch):
    async def safe_target(url):
        return url

    async def preflight(*args, **kwargs):
        return None

    async def submit(*args, **kwargs):
        return "rate01"

    monkeypatch.setattr(server, "_DETECT_RATE_LIMIT", 1)
    monkeypatch.setattr(server, "validate_target_url", safe_target)
    monkeypatch.setattr(server, "_preflight_or_422", preflight)
    monkeypatch.setattr(server.jobs, "submit", submit)
    data = {
        "base_url": "https://relay.example/v1",
        "api_key": "sk-test-key",
        "model": "gpt-4o",
        "mode": "quick",
    }
    async with await _client() as client:
        first = await client.post("/api/detect/openai", data=data)
        second = await client.post("/api/detect/openai", data=data)
    assert first.status_code == 200
    assert second.status_code == 429
    assert int(second.headers["Retry-After"]) >= 1


@pytest.mark.asyncio
async def test_full_queue_returns_503_with_retry_header(monkeypatch):
    async def safe_target(url):
        return url

    async def preflight(*args, **kwargs):
        return None

    async def full(*args, **kwargs):
        raise jobs.QueueFullError("检测队列已满,请稍后重试")

    monkeypatch.setattr(server, "validate_target_url", safe_target)
    monkeypatch.setattr(server, "_preflight_or_422", preflight)
    monkeypatch.setattr(server.jobs, "submit", full)
    async with await _client() as client:
        response = await client.post(
            "/api/detect/gemini",
            data={
                "base_url": "https://relay.example/v1",
                "api_key": "sk-test-key",
                "model": "gemini-2.5-flash",
                "mode": "quick",
            },
        )
    assert response.status_code == 503
    assert response.headers["Retry-After"] == str(server._QUEUE_RETRY_AFTER_S)


@pytest.mark.asyncio
async def test_preflight_error_does_not_echo_api_key(monkeypatch):
    secret = "sk-never-return-this"

    async def safe_target(url):
        return url

    async def dead(*args, **kwargs):
        return False, f"upstream body contained {secret} and Bearer {secret}"

    async def safe_transport(*args, **kwargs):
        return httpx.MockTransport(lambda request: httpx.Response(200, json={}))

    monkeypatch.setattr(server, "validate_target_url", safe_target)
    monkeypatch.setattr(server, "build_safe_transport", safe_transport)
    monkeypatch.setattr(server, "probe_model_alive", dead)
    async with await _client() as client:
        response = await client.post(
            "/api/detect/openai",
            data={
                "base_url": "https://relay.example/v1",
                "api_key": secret,
                "model": "gpt-4o",
                "mode": "quick",
            },
        )
    assert response.status_code == 422
    assert secret not in response.text
