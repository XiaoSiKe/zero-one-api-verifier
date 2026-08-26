from __future__ import annotations

import asyncio

import httpcore
import httpx
import pytest

from web.safe_http import (
    PinnedHTTPTransport,
    UnsafeResponseError,
    _LimitedStream,
    _PinnedNetworkBackend,
)


class _ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


class _RecordingBackend:
    def __init__(self) -> None:
        self.hosts: list[str] = []

    async def connect_tcp(self, host, port, **kwargs):
        self.hosts.append(host)
        return object()

    async def sleep(self, seconds):
        return None


@pytest.mark.asyncio
async def test_pinned_backend_connects_to_validated_ip_not_dns_hostname():
    delegate = _RecordingBackend()
    backend = _PinnedNetworkBackend(
        "relay.example",
        ["93.184.216.34"],
        delegate=delegate,
    )
    await backend.connect_tcp("relay.example", 443)
    assert delegate.hosts == ["93.184.216.34"]


@pytest.mark.asyncio
async def test_pinned_backend_rejects_cross_origin_connect():
    backend = _PinnedNetworkBackend(
        "relay.example",
        ["93.184.216.34"],
        delegate=_RecordingBackend(),
    )
    with pytest.raises(httpcore.ConnectError):
        await backend.connect_tcp("metadata.google.internal", 443)


@pytest.mark.asyncio
async def test_limited_stream_rejects_chunked_body_over_budget():
    source = _ChunkStream([b"123", b"45"])
    stream = _LimitedStream(source, 4)
    with pytest.raises(UnsafeResponseError):
        _ = [chunk async for chunk in stream]
    assert source.closed is True


@pytest.mark.asyncio
async def test_transport_rejects_compressed_response_before_body_read(monkeypatch):
    source = _ChunkStream([b"compressed"])

    async def fake_base(self, request):
        return httpx.Response(
            200,
            headers={"content-encoding": "gzip"},
            stream=source,
            request=request,
        )

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", fake_base)
    transport = object.__new__(PinnedHTTPTransport)
    transport._max_response_bytes = 100
    with pytest.raises(UnsafeResponseError):
        await transport.handle_async_request(httpx.Request("GET", "https://relay.example"))
    assert source.closed is True


@pytest.mark.asyncio
async def test_full_httpx_transport_uses_pinned_ip_and_original_host_header():
    request_head: asyncio.Future[bytes] = asyncio.get_running_loop().create_future()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        request_head.set_result(await reader.readuntil(b"\r\n\r\n"))
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
            b"Content-Type: text/plain\r\nConnection: close\r\n\r\nok"
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        transport = PinnedHTTPTransport("relay.invalid", ["127.0.0.1"])
        async with httpx.AsyncClient(transport=transport) as client:
            response = await client.get(f"http://relay.invalid:{port}/probe")
        assert response.text == "ok"
        assert f"host: relay.invalid:{port}".encode() in (await request_head).lower()
    finally:
        server.close()
        await server.wait_closed()
