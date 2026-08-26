"""Validation for user-supplied relay targets.

The public service only sends credentials to public HTTPS origins. Local
development may explicitly opt into private/HTTP targets with
``VERIDROP_ALLOW_PRIVATE_TARGETS=1``.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

from .safe_http import DEFAULT_MAX_RESPONSE_BYTES, PinnedHTTPTransport


class UnsafeTargetError(ValueError):
    """Raised when a relay URL is unsafe for server-side requests."""


_DNS_TIMEOUT_S = 3.0
_DNS_SEMA = asyncio.Semaphore(32)


@dataclass(frozen=True)
class _TargetParts:
    value: str
    host_ascii: str
    port: int
    allow_private: bool


def private_targets_allowed() -> bool:
    return os.environ.get("VERIDROP_ALLOW_PRIVATE_TARGETS", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _resolve_host(
    host: str, port: int
) -> set[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnsafeTargetError("目标域名无法解析") from exc
    addresses: set[ipaddress.IPv4Address | ipaddress.IPv6Address] = set()
    for info in infos:
        raw = info[4][0].split("%", 1)[0]
        try:
            addresses.add(ipaddress.ip_address(raw))
        except ValueError as exc:
            raise UnsafeTargetError("目标域名返回了无效地址") from exc
    if not addresses:
        raise UnsafeTargetError("目标域名没有可用地址")
    return addresses


def _assert_addresses_safe(
    addresses: set[ipaddress.IPv4Address | ipaddress.IPv6Address],
    *,
    allow_private: bool,
) -> None:
    if allow_private:
        return
    if any(not address.is_global for address in addresses):
        raise UnsafeTargetError("目标地址不能是本机、内网、保留或链路本地地址")


async def validate_target_url(raw_url: str) -> str:
    """Validate and return a normalized relay base URL.

    DNS is checked twice at admission and any private answer is rejected.
    Web callers then use :func:`build_safe_transport`, which resolves one
    final safe address set and pins the actual TCP connection to it.
    """
    parts = _parse_target(raw_url)
    await _resolve_checked(parts)
    await _resolve_checked(parts)
    return parts.value


def _parse_target(raw_url: str) -> _TargetParts:
    value = (raw_url or "").strip()
    if not value or "\\" in value or any(ord(char) < 32 for char in value):
        raise UnsafeTargetError("base_url 无效")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise UnsafeTargetError("base_url 端口无效") from exc

    allow_private = private_targets_allowed()
    allowed_schemes = {"https"} | ({"http"} if allow_private else set())
    if parsed.scheme.lower() not in allowed_schemes:
        if allow_private:
            raise UnsafeTargetError("base_url 必须使用 http 或 https")
        raise UnsafeTargetError("base_url 必须使用公网 HTTPS")
    if not parsed.hostname:
        raise UnsafeTargetError("base_url 缺少域名")
    if parsed.username is not None or parsed.password is not None:
        raise UnsafeTargetError("base_url 不能包含用户名或密码")
    if parsed.query or parsed.fragment:
        raise UnsafeTargetError("base_url 不能包含查询参数或片段")

    host = parsed.hostname.rstrip(".")
    if not host:
        raise UnsafeTargetError("base_url 缺少域名")
    try:
        host_ascii = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise UnsafeTargetError("base_url 域名无效") from exc
    target_port = port or (443 if parsed.scheme.lower() == "https" else 80)
    if not 1 <= target_port <= 65535:
        raise UnsafeTargetError("base_url 端口无效")

    return _TargetParts(
        value=value.rstrip("/"),
        host_ascii=host_ascii,
        port=target_port,
        allow_private=allow_private,
    )


async def _resolve_checked(
    parts: _TargetParts,
) -> set[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        async with _DNS_SEMA:
            addresses = await asyncio.wait_for(
                asyncio.to_thread(_resolve_host, parts.host_ascii, parts.port),
                timeout=_DNS_TIMEOUT_S,
            )
    except asyncio.TimeoutError as exc:
        raise UnsafeTargetError("目标域名解析超时") from exc
    _assert_addresses_safe(addresses, allow_private=parts.allow_private)
    return addresses


async def build_safe_transport(
    raw_url: str,
    *,
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
) -> PinnedHTTPTransport:
    """Resolve once, validate every answer, then pin the actual TCP connect."""
    parts = _parse_target(raw_url)
    addresses = await _resolve_checked(parts)
    return PinnedHTTPTransport(
        parts.host_ascii,
        sorted(str(address) for address in addresses),
        max_response_bytes=max_response_bytes,
    )
