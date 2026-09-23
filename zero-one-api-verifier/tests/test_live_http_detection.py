"""Exercise public detection routes against a real, controlled HTTP relay.

The relay is a local TCP server with known answers. No detector, runner, HTTP
transport, or report writer is replaced, and no third-party API is contacted.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest

from web import jobs, leaderboard, probe, ratelimit, server


class Relay:
    def __init__(self, scenario: str = "healthy") -> None:
        self.scenario = scenario
        self.requests: list[tuple[str, dict, dict[str, str]]] = []

    async def handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            lines = head.decode("ascii").split("\r\n")
            method, path, _ = lines[0].split(" ", 2)
            headers = dict(line.split(": ", 1) for line in lines[1:] if ": " in line)
            headers = {key.lower(): value for key, value in headers.items()}
            length = int(headers.get("content-length", "0"))
            body = json.loads(await reader.readexactly(length)) if length else {}
            self.requests.append((path, body, headers))

            if self.scenario == "timeout" and method == "POST":
                await asyncio.sleep(0.2)
            status, content_type, payload = self.response(path, body)
            writer.write(
                f"HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\n"
                f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode()
                + payload
            )
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    def response(self, path: str, body: dict) -> tuple[str, str, bytes]:
        if path == "/v1/models":
            return self._json(
                "200 OK",
                {
                    "data": [
                        {"id": "gpt-4o-mini"},
                        {"id": "gemini-2.5-flash"},
                        {"id": "claude-haiku-4-5"},
                    ]
                },
            )
        if self.scenario == "auth":
            return self._json("401 Unauthorized", {"error": "invalid api key"})
        if self.scenario == "malformed":
            return "200 OK", "application/json", b"{invalid-json"
        if self.scenario == "empty":
            return self._json("200 OK", {})

        model = body.get("model", "gpt-4o-mini")
        if path == "/v1/messages":
            content = [{"type": "text", "text": "I am Claude, made by Anthropic."}]
            if body.get("thinking"):
                content.insert(
                    0,
                    {
                        "type": "thinking",
                        "thinking": "A controlled fixture response.",
                        "signature": "f" * 64,
                    },
                )
            return self._json(
                "200 OK",
                {
                    "id": "msg_fixture123",
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": content,
                    "stop_reason": "end_turn",
                    "stop_sequence": None,
                    "usage": {"input_tokens": 15, "output_tokens": 12},
                },
            )
        if path == "/v1/chat/completions":
            if body.get("stream"):
                event = {
                    "id": "chatcmpl-fixture",
                    "object": "chat.completion.chunk",
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": "pong"},
                            "finish_reason": None,
                        }
                    ],
                }
                payload = f"data: {json.dumps(event)}\n\ndata: [DONE]\n\n".encode()
                return "200 OK", "text/event-stream", payload
            is_preflight = body.get("max_completion_tokens") == 4
            degraded = self.scenario == "degraded" and not is_preflight
            return self._json(
                "200 OK",
                {
                    "id": "chatcmpl-fixture",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "other-model" if degraded else model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "unrelated" if degraded else "pong",
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 2,
                        "total_tokens": 12,
                    },
                },
            )
        return self._json("404 Not Found", {"error": "unsupported route"})

    @staticmethod
    def _json(status: str, data: dict) -> tuple[str, str, bytes]:
        return status, "application/json", json.dumps(data).encode()


@asynccontextmanager
async def local_relay(scenario: str):
    relay = Relay(scenario)
    listener = await asyncio.start_server(relay.handle, "127.0.0.1", 0)
    try:
        yield relay, f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}/v1"
    finally:
        listener.close()
        await listener.wait_closed()


@pytest.fixture(autouse=True)
def isolated_web_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    report_dir = tmp_path / "jobs"
    report_dir.mkdir()
    monkeypatch.setenv("VERIDROP_ALLOW_PRIVATE_TARGETS", "1")
    monkeypatch.setattr(jobs, "JOBS_DIR", report_dir)
    monkeypatch.setattr(jobs, "_JOBS", {})
    monkeypatch.setattr(jobs, "_TASKS", set())
    monkeypatch.setattr(
        leaderboard,
        "REPORT_DIRS",
        [
            report_dir / p
            for p in (
                "anthropic",
                "openai",
                "gemini",
            )
        ]
        + [report_dir],
    )
    probe.clear_cache()
    ratelimit.reset()
    yield
    probe.clear_cache()
    ratelimit.reset()


async def submit_and_wait(
    client: httpx.AsyncClient,
    route: str,
    base_url: str,
    model: str,
    *,
    force: bool = False,
):
    submitted = await client.post(
        route,
        data={
            "base_url": base_url,
            "api_key": "sk-controlled-fixture",
            "model": model,
            "mode": "quick",
            "force": "true" if force else "false",
        },
    )
    assert submitted.status_code == 200, submitted.text
    job_id = submitted.json()["job_id"]
    for _ in range(200):
        status = (await client.get(f"/api/status/{job_id}")).json()
        if status["status"] in {"done", "error"}:
            break
        await asyncio.sleep(0.01)
    assert status["status"] == "done", status
    result = await client.get(f"/api/result/{job_id}.json")
    assert result.status_code == 200
    return job_id, result.json()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "route,model",
    [
        ("/api/detect/openai", "gpt-4o-mini"),
        ("/api/detect/gemini", "gemini-2.5-flash"),
        ("/api/detect/claude", "claude-haiku-4-5"),
    ],
)
async def test_real_http_probe_detection_and_persisted_report(
    route, model, tmp_path, monkeypatch
):
    async with (
        local_relay("healthy") as (relay, base_url),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app),
            base_url="http://testserver",
        ) as client,
    ):
        found = await client.post(
            "/api/probe",
            data={
                "base_url": base_url,
                "api_key": "sk-controlled-fixture",
            },
        )
        assert found.status_code == 200
        assert model in found.json()["all_models"]
        job_id, report = await submit_and_wait(client, route, base_url, model)
        share = await client.get(f"/r/{job_id}")
        assert share.status_code == 200
        assert "sk-controlled-fixture" not in share.text

    assert report["target_model"] == model
    assert report["verdict"] == "passed"
    assert report["performance"]["request_count"] >= 1
    assert any(item["status"] != "skip" for item in report["results"])
    assert "sk-controlled-fixture" not in json.dumps(report)
    assert any(path == "/v1/models" for path, _, _ in relay.requests)
    expected_path = (
        "/v1/messages" if route.endswith("claude") else "/v1/chat/completions"
    )
    assert any(path == expected_path for path, _, _ in relay.requests)
    report_path = jobs.report_path(job_id, report["protocol"])
    assert report_path.is_file()
    restored_dir = tmp_path / "restored-jobs"
    shutil.copytree(jobs.JOBS_DIR, restored_dir)
    monkeypatch.setattr(jobs, "JOBS_DIR", restored_dir)
    jobs._JOBS.clear()
    assert (await jobs.get(job_id)).report == report


@pytest.mark.asyncio
async def test_real_http_capability_loss_is_not_reported_as_passed():
    async with (
        local_relay("degraded") as (relay, base_url),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app),
            base_url="http://testserver",
        ) as client,
    ):
        _, report = await submit_and_wait(
            client,
            "/api/detect/openai",
            base_url,
            "gpt-4o-mini",
        )
    assert report["verdict"] != "passed"
    assert any(item["status"] == "fail" for item in report["results"])
    assert sum(path == "/v1/chat/completions" for path, _, _ in relay.requests) >= 3


@pytest.mark.asyncio
@pytest.mark.parametrize("scenario", ["auth", "malformed", "empty", "timeout"])
async def test_real_http_preflight_failure_is_not_accepted(scenario, monkeypatch):
    if scenario == "timeout":
        monkeypatch.setattr(probe, "PREFLIGHT_TIMEOUT_S", 0.05)
    async with (
        local_relay(scenario) as (_, base_url),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app),
            base_url="http://testserver",
        ) as client,
    ):
        response = await client.post(
            "/api/detect/openai",
            data={
                "base_url": base_url,
                "api_key": "sk-controlled-fixture",
                "model": "gpt-4o-mini",
                "mode": "quick",
            },
        )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "model_not_alive"
    assert jobs._JOBS == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("scenario", ["auth", "malformed", "empty"])
async def test_forced_real_http_failure_still_produces_failed_report(scenario):
    async with (
        local_relay(scenario) as (_, base_url),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app),
            base_url="http://testserver",
        ) as client,
    ):
        _, report = await submit_and_wait(
            client,
            "/api/detect/openai",
            base_url,
            "gpt-4o-mini",
            force=True,
        )
    assert report["verdict"] == "failed"
    assert report["total_score"] < 50
    assert "sk-controlled-fixture" not in json.dumps(report)
