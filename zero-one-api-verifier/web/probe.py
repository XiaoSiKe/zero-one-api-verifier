"""Pre-submission /v1/models probe.

Why this exists: a user can paste any base_url + api_key + model name into
the detection form. If the relay doesn't carry that model, the only signal
they get is a 30-second wait followed by a 0% red circle. By probing
GET <base_url>/models first we can tell them up front:

  - the key works (auth_ok)
  - the relay carries M total models, N of which fit the protocol they're on
  - if N == 0 but other protocols have matches, suggest a one-click handoff

The probe is best-effort: timeout fast, fall back gracefully if /models is
not implemented, and never block submission. The detector itself is the
source of truth for whether the relay actually works — the probe is just a
hint to spare users a frustrating round trip.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from typing import Any

import httpx

from relay_detector.protocols.resolve import protocol_from_model

PROTOCOLS = ("anthropic", "openai", "gemini")
PROBE_TIMEOUT_S = 4.0
CACHE_TTL_S = 300.0  # 5 min
MAX_RESPONSE_BYTES = 1_000_000


class ProbeResponseTooLarge(RuntimeError):
    """The model-list response exceeded the bounded probe budget."""


def _classify(model_id: str) -> str | None:
    """Map a model id to a protocol bucket, or None if unrecognised.

    Heuristic only — relays sometimes route the same alias to a different
    backend than the name suggests, which is exactly what we're trying to
    expose. We use it for "the form's protocol agrees with the model name",
    not for trust-level decisions.
    """
    protocol = protocol_from_model(model_id)
    return protocol.value if protocol else None


# (base_url, api_key_hash) -> (timestamp, response_dict)
_CACHE: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}


def _cache_key(base_url: str, api_key: str) -> tuple[str, str]:
    h = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]
    return (base_url.rstrip("/").lower(), h)


def _redact_cached(value: Any, api_key: str) -> Any:
    if isinstance(value, dict):
        return {key: _redact_cached(item, api_key) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_cached(item, api_key) for item in value]
    if isinstance(value, str) and api_key:
        return value.replace(api_key, "[REDACTED]")
    return value


def _store_cache(
    key: tuple[str, str],
    created: float,
    value: dict[str, Any],
    api_key: str,
) -> dict[str, Any]:
    safe = _redact_cached(value, api_key)
    _CACHE[key] = (created, safe)
    return safe


async def probe_relay(
    base_url: str,
    api_key: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Probe a relay's /models endpoint. Always returns a structured dict.

    Never raises — network and protocol errors are returned as ``ok=false``
    with a human-readable ``error`` field so the frontend can render them
    inline next to the api_key field.
    """
    key = _cache_key(base_url, api_key)
    now = time.monotonic()
    _prune_cache(now, reserve=key not in _CACHE)
    cached = _CACHE.get(key)
    if cached and now - cached[0] < CACHE_TTL_S:
        return cached[1]

    urls = _model_probe_urls(base_url)

    headers = {
        # Bearer is the OpenAI/Gemini-compat convention. Anthropic native
        # uses x-api-key, but most relays accept either; we send both to
        # maximize hit rate without leaking either to non-relay servers.
        "authorization": f"Bearer {api_key}",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "accept-encoding": "identity",
    }

    out: dict[str, Any]
    try:
        async with httpx.AsyncClient(
            timeout=PROBE_TIMEOUT_S,
            transport=transport,
            trust_env=transport is None,
        ) as client:
            resp, payload = await _get_models_with_fallback(client, urls, headers)
    except (httpx.TimeoutException, httpx.NetworkError) as e:
        out = _err(f"网络/超时: {type(e).__name__}", base_url, status=None)
        return _store_cache(key, now, out, api_key)
    except Exception as e:  # noqa: BLE001
        out = _err(f"请求失败: {type(e).__name__}: {e}", base_url, status=None)
        return _store_cache(key, now, out, api_key)

    status = resp.status_code

    if status == 404:
        # /models simply not implemented — common on private relays. Not an
        # auth problem; signal graceful degrade.
        out = {
            "ok": True,
            "auth_ok": True,
            "models_endpoint_supported": False,
            "raw_count": 0,
            "all_models": [],
            "by_protocol": {p: [] for p in PROTOCOLS},
            "best_by_protocol": {p: None for p in PROTOCOLS},
            "status": status,
            "error": None,
            "note": "该中转站不暴露 /v1/models,无法预先列模型",
        }
        return _store_cache(key, now, out, api_key)

    if status in (401, 403):
        out = _err(
            f"鉴权失败 (HTTP {status}): {_excerpt(resp.text)}",
            base_url,
            status=status,
            auth_ok=False,
        )
        return _store_cache(key, now, out, api_key)

    if status >= 400:
        out = _err(
            f"HTTP {status}: {_excerpt(resp.text)}",
            base_url,
            status=status,
        )
        return _store_cache(key, now, out, api_key)

    if payload is None:
        out = _err("响应不是有效 JSON", base_url, status=status)
        return _store_cache(key, now, out, api_key)

    ids = _extract_model_ids(payload)
    by_proto: dict[str, list[str]] = {p: [] for p in PROTOCOLS}
    for mid in ids:
        bucket = _classify(mid)
        if bucket is not None:
            by_proto[bucket].append(mid)

    best_by_proto: dict[str, str | None] = {
        p: _pick_best(p, by_proto[p]) for p in PROTOCOLS
    }

    # Sort each bucket so the protocol's preferred defaults float to the top
    # of the dropdown. Without this, sunyears returns alphabetical ordering
    # and gpt-3.5-turbo (deprecated) renders before gpt-4o-mini — exactly
    # the bait that produces 0% reports.
    for p in PROTOCOLS:
        by_proto[p] = _sort_by_preference(p, by_proto[p])

    out = {
        "ok": True,
        "auth_ok": True,
        "models_endpoint_supported": True,
        "raw_count": len(ids),
        "all_models": ids,
        "by_protocol": by_proto,
        # Per-protocol preferred default — used by the frontend to pre-fill
        # the model field after a cross-protocol handoff (so a /gemini → /openai
        # jump lands on gpt-4o-mini, not on whatever sorts first alphabetically).
        "best_by_protocol": best_by_proto,
        "status": status,
        "error": None,
        "note": None,
    }
    return _store_cache(key, now, out, api_key)


def _extract_model_ids(payload: Any) -> list[str]:
    """Pull model id strings from any of the common response shapes.

    OpenAI:    {"data": [{"id": "..."} ...], "object": "list"}
    Anthropic: {"data": [{"id": "...", "type": "model"} ...]}
    Gemini:    {"models": [{"name": "models/gemini-..."} ...]}
    Some relays just return a bare list.
    """
    items: list[Any] = []
    if isinstance(payload, dict):
        for key in ("data", "models"):
            v = payload.get(key)
            if isinstance(v, list):
                items = v
                break
    elif isinstance(payload, list):
        items = payload

    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        mid: str | None = None
        if isinstance(item, str):
            mid = item
        elif isinstance(item, dict):
            for k in ("id", "name", "model"):
                v = item.get(k)
                if isinstance(v, str) and v:
                    mid = v
                    break
        if mid and mid not in seen:
            seen.add(mid)
            out.append(mid)
    return out


def _model_probe_urls(base_url: str) -> list[str]:
    """Return candidate model-list URLs for OpenAI-compatible roots.

    Most relays ask users to paste a `/v1` API root, so `/models` is enough.
    Some providers, including B.AI, document the host root (`https://api.b.ai`)
    while exposing the OpenAI-compatible list at `/v1/models`.
    """
    base = base_url.rstrip("/")
    urls = [f"{base}/models"]
    if not base.endswith("/v1") and not base.endswith("/v1beta/openai"):
        urls.append(f"{base}/v1/models")
    return urls


async def _get_models_with_fallback(
    client: httpx.AsyncClient,
    urls: list[str],
    headers: dict[str, str],
) -> tuple[httpx.Response, Any | None]:
    """Try `/models`, then `/v1/models` for providers that require it."""
    first_auth_failure: httpx.Response | None = None
    last_resp: httpx.Response | None = None

    for i, url in enumerate(urls):
        resp = await _get_limited(client, url, headers)
        last_resp = resp
        if resp.status_code < 400:
            try:
                return resp, resp.json()
            except Exception:  # noqa: BLE001
                if i == len(urls) - 1:
                    return resp, None
                continue
        if resp.status_code in (401, 403) and first_auth_failure is None:
            first_auth_failure = resp
        if i == len(urls) - 1:
            break
        if resp.status_code not in (403, 404, 405):
            break

    if last_resp is not None and last_resp.status_code in (401, 403):
        return last_resp, None
    if first_auth_failure is not None:
        return first_auth_failure, None
    if last_resp is None:
        raise RuntimeError("no model probe urls configured")
    return last_resp, None


async def _get_limited(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
) -> httpx.Response:
    """Stream at most MAX_RESPONSE_BYTES instead of buffering unbounded JSON."""
    async with client.stream("GET", url, headers=headers, follow_redirects=False) as resp:
        declared = resp.headers.get("content-length")
        if declared:
            try:
                if int(declared) > MAX_RESPONSE_BYTES:
                    raise ProbeResponseTooLarge("模型列表响应过大")
            except ValueError:
                pass
        body = bytearray()
        async for chunk in resp.aiter_bytes():
            body.extend(chunk)
            if len(body) > MAX_RESPONSE_BYTES:
                raise ProbeResponseTooLarge("模型列表响应过大")
        return httpx.Response(
            resp.status_code,
            headers=resp.headers,
            content=bytes(body),
            request=resp.request,
        )


def _err(
    message: str,
    base_url: str,
    *,
    status: int | None,
    auth_ok: bool = True,
) -> dict[str, Any]:
    return {
        "ok": False,
        "auth_ok": auth_ok,
        "models_endpoint_supported": False,
        "raw_count": 0,
        "all_models": [],
        "by_protocol": {p: [] for p in PROTOCOLS},
        "best_by_protocol": {p: None for p in PROTOCOLS},
        "status": status,
        "error": message,
        "note": None,
    }


def _preference_list(proto: str) -> tuple[str, ...]:
    """Read each protocol's _PREFERRED_DEFAULTS tuple. Empty on errors."""
    try:
        if proto == "anthropic":
            from relay_detector.protocols.anthropic import _PREFERRED_DEFAULTS
        elif proto == "openai":
            from relay_detector.protocols.openai import _PREFERRED_DEFAULTS
        elif proto == "gemini":
            from relay_detector.protocols.gemini import _PREFERRED_DEFAULTS
        else:
            return ()
        return tuple(_PREFERRED_DEFAULTS)
    except Exception:  # noqa: BLE001
        return ()


def _sort_by_preference(proto: str, available: list[str]) -> list[str]:
    """Stable sort: items matching a preferred alias by index in that list,
    everything else after, original relative order preserved.

    Rationale: the dropdown should default-attract the user toward models
    we know are healthy. Deprecated entries (e.g. gpt-3.5-turbo) sink to
    the bottom; stable mainstays (gpt-4o-mini) rise to the top. Matching
    is prefix-tolerant so snapshots line up under their alias bucket.
    """
    prefs = _preference_list(proto)
    if not prefs:
        return list(available)

    def rank(model: str) -> tuple[int, int]:
        bare = model.removeprefix("models/")
        for i, pref in enumerate(prefs):
            if bare == pref or bare.startswith(pref + "-"):
                return (0, i)  # preferred bucket, ranked by preference index
        return (1, 0)  # everything else, kept in input order via stable sort

    return sorted(available, key=rank)


def _pick_best(proto: str, available: list[str]) -> str | None:
    """Delegate to the protocol package's pick_default_model.

    Lazy-imported per call to keep web/probe protocol-agnostic at module
    load time (and to dodge the protocol-isolation rule applied to the
    src/relay_detector/protocols tree). On any import / runtime error fall
    back to the first available model rather than crashing the probe.
    """
    if not available:
        return None
    try:
        if proto == "anthropic":
            from relay_detector.protocols.anthropic import pick_default_model
        elif proto == "openai":
            from relay_detector.protocols.openai import pick_default_model
        elif proto == "gemini":
            from relay_detector.protocols.gemini import pick_default_model
        else:
            return available[0]
        return pick_default_model(available)
    except Exception:  # noqa: BLE001
        return available[0]


def _excerpt(text: str, n: int = 160) -> str:
    s = (text or "").strip().replace("\n", " ")
    return s if len(s) <= n else s[:n] + "..."


# Synchronous wrapper for tests; never called from the async route.
def probe_relay_sync(base_url: str, api_key: str) -> dict[str, Any]:
    return asyncio.run(probe_relay(base_url, api_key))


def clear_cache() -> None:
    """Test helper."""
    _CACHE.clear()


def _prune_cache(now: float, *, reserve: int = 0) -> None:
    """Drop expired probe entries and cap one-off key memory usage."""
    expired = [key for key, (created, _) in _CACHE.items() if now - created >= CACHE_TTL_S]
    for key in expired:
        _CACHE.pop(key, None)
    overflow = len(_CACHE) + reserve - 512
    if overflow > 0:
        oldest = sorted(_CACHE, key=lambda key: _CACHE[key][0])[:overflow]
        for key in oldest:
            _CACHE.pop(key, None)


# ---------------------------------------------------------------------------
# Model-level preflight — does the relay actually answer for this model?
# ---------------------------------------------------------------------------
#
# /v1/models lists every model the relay has ever advertised. Many of those
# (e.g. gpt-3.5-turbo on a 2026-era multi-protocol relay) have been
# deprecated upstream and 4xx out the moment you try to use them. Without
# this preflight the user picks one of those zombies, runs a 30-second
# detection, sees a 0% report, and assumes the tool is broken.
#
# We send ONE minimal request — 4 output tokens, single-message — through
# the protocol's real client class. Cost is ~$0.0001 and ~500ms; in return
# the user gets a clear "model is dead, try X" message before the job
# queue even sees the submission.

PREFLIGHT_TIMEOUT_S = 8.0


async def probe_model_alive(
    base_url: str,
    api_key: str,
    model: str,
    protocol: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[bool, str | None]:
    """Return ``(alive, error_text_or_None)``.

    ``alive=False`` means the upstream rejected the call — error_text holds
    the upstream message (truncated). ``alive=True`` means a 2xx with at
    least a recognisable response envelope. The caller decides whether to
    block submission or just warn.

    Lazy-import the protocol client to keep web/probe protocol-agnostic at
    module load time and to avoid pulling Anthropic deps into Gemini-only
    deployments.
    """
    try:
        if protocol == "openai":
            from relay_detector.protocols.openai import make_client
            async with make_client(
                base_url, api_key, timeout=PREFLIGHT_TIMEOUT_S, transport=transport
            ) as c:
                _req, _resp, _h, _lat = await c.chat_completions_create(
                    model=model,
                    max_completion_tokens=4,
                    messages=[{"role": "user", "content": "ok"}],
                )
        elif protocol == "gemini":
            from relay_detector.protocols.gemini import make_client
            async with make_client(
                base_url, api_key, timeout=PREFLIGHT_TIMEOUT_S, transport=transport
            ) as c:
                _req, _resp, _h, _lat = await c.chat_completions_create(
                    model=model,
                    max_completion_tokens=4,
                    messages=[{"role": "user", "content": "ok"}],
                )
        elif protocol == "anthropic":
            from relay_detector.protocols.anthropic import make_client
            async with make_client(
                base_url, api_key, timeout=PREFLIGHT_TIMEOUT_S, transport=transport
            ) as c:
                _req, _resp, _h, _lat = await c.messages_create(
                    model=model,
                    max_tokens=4,
                    messages=[{"role": "user", "content": "ok"}],
                )
        else:
            return False, f"未知协议: {protocol}"
        if protocol in {"openai", "gemini"}:
            choices = _resp.get("choices") if isinstance(_resp, dict) else None
            if not (
                isinstance(choices, list)
                and choices
                and isinstance(choices[0], dict)
                and isinstance(choices[0].get("message"), dict)
            ):
                return False, "探活响应缺少 Chat Completions 消息"
        elif not (
            isinstance(_resp, dict)
            and _resp.get("type") == "message"
            and isinstance(_resp.get("content"), list)
        ):
            return False, "探活响应缺少 Anthropic Messages 内容"
        return True, None
    except Exception as e:  # noqa: BLE001
        # The protocol clients raise their own *APIError types with a `body`
        # attribute holding the upstream error. Surface it verbatim so the
        # frontend can show "HTTP 404: model_not_found ..." instead of just
        # "Internal error".
        body = getattr(e, "body", None)
        if isinstance(body, str) and body:
            return False, _excerpt(body, 280)
        return False, f"{type(e).__name__}: {_excerpt(str(e), 280)}"
