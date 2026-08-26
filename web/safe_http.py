"""Pinned, bounded HTTP transport for untrusted relay targets.

The web service validates a hostname, then connects only to the validated IP
addresses.  The original hostname remains in the request origin, Host header,
TLS SNI, and certificate verification.  Responses are requested without
compression and capped before callers buffer JSON or SSE content.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterable

import httpcore
import httpx
from httpcore._backends.auto import AutoBackend

DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class UnsafeResponseError(httpx.TransportError):
    """Raised when an upstream response exceeds the safe buffering budget."""


class _PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Resolve one allowed hostname to a prevalidated, immutable IP set."""

    def __init__(
        self,
        hostname: str,
        addresses: Iterable[str],
        *,
        delegate: httpcore.AsyncNetworkBackend | None = None,
    ) -> None:
        self._hostname = hostname.rstrip(".").lower()
        self._addresses = tuple(dict.fromkeys(addresses))
        if not self._addresses:
            raise ValueError("at least one pinned address is required")
        self._delegate = delegate or AutoBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[tuple[int, int, int | bytes]] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        if host.rstrip(".").lower() != self._hostname:
            raise httpcore.ConnectError("redirect target is not allowlisted")

        last_error: Exception | None = None
        for address in self._addresses:
            try:
                return await self._delegate.connect_tcp(
                    address,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        raise httpcore.ConnectError("no pinned address was reachable")

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[tuple[int, int, int | bytes]] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("unix sockets are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self._delegate.sleep(seconds)


class _LimitedStream(httpx.AsyncByteStream):
    def __init__(self, stream: httpx.AsyncByteStream, limit: int) -> None:
        self._stream = stream
        self._limit = limit

    async def __aiter__(self) -> AsyncIterator[bytes]:
        seen = 0
        async for chunk in self._stream:
            seen += len(chunk)
            if seen > self._limit:
                await self._stream.aclose()
                raise UnsafeResponseError("upstream response exceeded size limit")
            yield chunk

    async def aclose(self) -> None:
        await self._stream.aclose()


class PinnedHTTPTransport(httpx.AsyncHTTPTransport):
    """HTTPX transport with DNS pinning, TLS hostname checks, and size limits."""

    def __init__(
        self,
        hostname: str,
        addresses: Iterable[str],
        *,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
    ) -> None:
        if max_response_bytes < 1:
            raise ValueError("max_response_bytes must be positive")
        super().__init__(trust_env=False, limits=httpx.Limits(max_connections=20))
        self._max_response_bytes = max_response_bytes
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpx.create_ssl_context(verify=True, trust_env=False),
            max_connections=20,
            max_keepalive_connections=10,
            keepalive_expiry=5.0,
            http1=True,
            http2=False,
            network_backend=_PinnedNetworkBackend(hostname, addresses),
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await super().handle_async_request(request)
        declared = response.headers.get("content-length")
        if declared:
            try:
                if int(declared) > self._max_response_bytes:
                    await response.aclose()
                    raise UnsafeResponseError("upstream response exceeded size limit")
            except ValueError:
                pass

        encoding = response.headers.get("content-encoding", "identity").strip().lower()
        if encoding not in {"", "identity"}:
            await response.aclose()
            raise UnsafeResponseError("compressed upstream responses are not accepted")

        response.stream = _LimitedStream(response.stream, self._max_response_bytes)
        return response
