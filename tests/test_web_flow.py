"""Tracer-bullet coverage for the HTTP job lifecycle."""

from __future__ import annotations

import asyncio
import stat
import time
from pathlib import Path

import httpx
import pytest

from relay_detector.core.models import DetectorResult, PerformanceMetrics
from relay_detector.core.runner import RunOutcome
from web import jobs, leaderboard, ratelimit, server


@pytest.mark.asyncio
async def test_submit_report_disk_recovery_and_leaderboard(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    job_dir = tmp_path / "jobs"
    job_dir.mkdir()
    monkeypatch.setattr(jobs, "JOBS_DIR", job_dir)
    monkeypatch.setattr(
        leaderboard,
        "REPORT_DIRS",
        [job_dir / "anthropic", job_dir / "openai", job_dir / "gemini", job_dir],
    )
    monkeypatch.setattr(server, "_SITEMAP_REPORT_DIRS", leaderboard.REPORT_DIRS)
    monkeypatch.setattr(jobs, "_JOBS", {})
    monkeypatch.setattr(jobs, "_TASKS", set())
    ratelimit.reset()

    async def safe_target(url):
        return url

    async def preflight(*args, **kwargs):
        return None

    async def safe_transport(*args, **kwargs):
        return httpx.MockTransport(lambda request: httpx.Response(200, json={}))

    async def fake_runner(base_url, api_key, model, cfg, **kwargs):
        return RunOutcome(
            results=[
                DetectorResult(
                    name="identity",
                    display_name="身份一致性",
                    status="pass",
                    score=100,
                    weight=1,
                    details={
                        "response_text": "Claude",
                        "debug": {"authorization": f"Bearer {api_key}"},
                    },
                )
            ],
            performance=PerformanceMetrics(total_latency_ms=12, request_count=1),
        )

    monkeypatch.setattr(server, "validate_target_url", safe_target)
    monkeypatch.setattr(server, "_preflight_or_422", preflight)
    monkeypatch.setattr(jobs, "validate_target_url", safe_target)
    monkeypatch.setattr(jobs, "build_safe_transport", safe_transport)
    monkeypatch.setattr(jobs, "_run_anthropic", fake_runner)

    secret = "sk-flow-secret-key"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=server.app),
        base_url="http://testserver",
    ) as client:
        submitted = await client.post(
            "/api/detect/claude",
            data={
                "base_url": "https://flow.example/v1",
                "api_key": secret,
                "model": "claude-haiku-4-5",
                "mode": "quick",
            },
        )
        assert submitted.status_code == 200
        job_id = submitted.json()["job_id"]

        status = None
        for _ in range(100):
            status = await client.get(f"/api/status/{job_id}")
            if status.json()["status"] in {"done", "error"}:
                break
            await asyncio.sleep(0.01)
        assert status is not None
        assert status.json()["status"] == "done"

        result_json = await client.get(f"/api/result/{job_id}.json")
        report_page = await client.get(f"/r/{job_id}")
        image = await client.get(f"/r/{job_id}.jpg")
        sitemap = await client.get("/sitemap.xml")

        assert result_json.status_code == 200
        assert report_page.status_code == 200
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/jpeg"
        assert job_id in sitemap.text
        assert secret not in result_json.text

        report_file = job_dir / "anthropic" / f"{job_id}.json"
        assert report_file.is_file()
        assert stat.S_IMODE(report_file.stat().st_mode) == 0o600
        assert not list(report_file.parent.glob(f".{report_file.name}.*.tmp"))
        assert secret not in report_file.read_text(encoding="utf-8")

        jobs._JOBS.clear()
        recovered = await client.get(f"/api/result/{job_id}.json")
        assert recovered.status_code == 200
        assert recovered.json()["target_model"] == "claude-haiku-4-5"

    relays, summary = leaderboard.aggregate()
    assert summary["total_reports"] == 1
    assert [relay.domain for relay in relays] == ["flow.example"]


@pytest.mark.asyncio
async def test_queue_capacity_task_reference_and_completed_eviction(monkeypatch):
    monkeypatch.setattr(jobs, "_JOBS", {})
    monkeypatch.setattr(jobs, "_TASKS", set())
    monkeypatch.setattr(jobs, "_MAX_PENDING", 1)
    monkeypatch.setattr(jobs, "_MAX_RETAINED_JOBS", 1)
    gate = asyncio.Event()

    async def blocked(*args, **kwargs):
        await gate.wait()

    monkeypatch.setattr(jobs, "_run", blocked)
    first = await jobs.submit(
        "https://relay.example", "sk-test-key", "gpt-4o", "quick", "openai"
    )
    assert first in jobs._JOBS
    assert len(jobs._TASKS) == 1
    with pytest.raises(jobs.QueueFullError):
        await jobs.submit(
            "https://relay.example", "sk-test-key", "gpt-4o", "quick", "openai"
        )

    gate.set()
    await asyncio.gather(*tuple(jobs._TASKS))
    await asyncio.sleep(0)

    now = time.time()
    jobs._JOBS = {
        "old": jobs.Job(id="old", status="error", finished_at=now - 2),
        "new": jobs.Job(id="new", status="done", finished_at=now - 1),
    }
    async with jobs._LOCK:
        jobs._evict_completed_locked()
    assert set(jobs._JOBS) == {"new"}
