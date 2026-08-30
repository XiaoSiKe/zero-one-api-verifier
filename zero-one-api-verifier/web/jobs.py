"""Job queue for HTTP-driven detections.

Wraps the same Runner the CLI uses. Single uvicorn worker, in-process state
guarded by an asyncio lock. Done jobs are persisted to disk so a server
restart keeps the shareable result URLs alive. API keys are NEVER persisted —
the masked form goes to disk; the raw key lives only in the running task
closure and is released when the run finishes.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx

from relay_detector.models import (
    DetectionReport,
    DetectionTier,
    ExecutionConfig,
    Mode,
    Protocol,
    mask_api_key,
)
from relay_detector.scorer import (
    compute_total,
    effective_verdict,
    fatal_run_error,
    summary_text,
)

from .paths import JOBS_DIR as DEFAULT_JOBS_DIR
from .target_safety import build_safe_transport, validate_target_url

JobStatus = Literal["queued", "running", "done", "error"]

# Repository-local by default; production can set VERIDROP_WEB_DATA_DIR or
# the legacy VERIDROP_JOBS_DIR override.
JOBS_DIR = DEFAULT_JOBS_DIR
JOBS_DIR.mkdir(parents=True, exist_ok=True)

# Cap concurrent detections so a flood of submissions doesn't exhaust file
# descriptors or get the upstream Anthropic API rate-limited. Each detection
# already runs ~13 outbound requests in parallel, so 6 inflight = ~78 sockets.
_MAX_INFLIGHT = 6
_SEMA = asyncio.Semaphore(_MAX_INFLIGHT)
_MAX_PENDING = int(os.environ.get("VERIDROP_MAX_PENDING_JOBS", "24"))
_MAX_RETAINED_JOBS = int(os.environ.get("VERIDROP_MAX_RETAINED_JOBS", "500"))


class QueueFullError(RuntimeError):
    """Raised when accepting another detection would exceed queue capacity."""


@dataclass
class Job:
    id: str
    protocol: str = "anthropic"
    status: JobStatus = "queued"
    base_url: str = ""
    target_model: str = ""
    mode: str = "full"
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    report: dict[str, Any] | None = None
    error: str | None = None


_JOBS: dict[str, Job] = {}
_LOCK = asyncio.Lock()
_TASKS: set[asyncio.Task[None]] = set()

_SENSITIVE_FIELDS = {
    "api_key", "authorization", "x_api_key", "access_token", "refresh_token",
    "client_secret", "secret", "token",
}
_SECRET_PATTERNS = (
    re.compile(r"\b(?:sk|key)-[A-Za-z0-9._-]{6,}\b"),
    re.compile(r"\bBearer\s+[^\s\"']{8,}", re.IGNORECASE),
)


def redact_sensitive(value: Any, secrets_to_remove: tuple[str, ...] = ()) -> Any:
    """Recursively remove credentials from public errors and reports."""
    if isinstance(value, dict):
        out: dict[Any, Any] = {}
        for key, item in value.items():
            normalized = str(key).strip().lower().replace("-", "_")
            out[key] = (
                "[REDACTED]"
                if normalized in _SENSITIVE_FIELDS
                else redact_sensitive(item, secrets_to_remove)
            )
        return out
    if isinstance(value, list):
        return [redact_sensitive(item, secrets_to_remove) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_sensitive(item, secrets_to_remove) for item in value)
    if isinstance(value, str):
        redacted = value
        for secret in secrets_to_remove:
            if secret:
                redacted = redacted.replace(secret, "[REDACTED]")
        for pattern in _SECRET_PATTERNS:
            redacted = pattern.sub("[REDACTED]", redacted)
        return redacted
    return value


def _evict_completed_locked() -> None:
    terminal = sorted(
        (job for job in _JOBS.values() if job.status in {"done", "error"}),
        key=lambda job: job.finished_at or job.created_at,
    )
    keep = max(_MAX_RETAINED_JOBS, 0)
    stale = terminal if keep == 0 else terminal[:-keep]
    for job in stale:
        _JOBS.pop(job.id, None)


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Durably replace a report without exposing a partial JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary_path.unlink(missing_ok=True)


def _new_job_id() -> str:
    # 8-char URL-safe id; secrets gives ~48 bits of entropy, fine for an
    # unguessable shareable link without auth.
    return secrets.token_urlsafe(6)


async def submit(
    base_url: str,
    api_key: str,
    model: str,
    mode: str,
    protocol: str = "anthropic",
    include_long_context: bool = False,
    include_long_context_extreme: bool = False,
    revalidate_target: bool = False,
) -> str:
    """Queue a detection job and return the job id immediately.

    Long-context probe is opt-in. Two tiers:
      - ``include_long_context`` (standard): 32k/100k/200k probes,
        $0.05–$0.50 upstream cost, 30–90s extra wall time.
      - ``include_long_context_extreme`` (adaptive): probes proportionally
        up to the model's advertised limit (e.g. 32k→500k→950k for 1M
        models). $0.05–$8 cost, 30s–5min wall time. Catches "advertised X
        but capped at Y<X" fraud that the standard tier misses on big
        models. Implies standard (it's a superset).
    """
    async with _LOCK:
        _evict_completed_locked()
        pending = sum(
            job.status in {"queued", "running"} for job in _JOBS.values()
        )
        if pending >= _MAX_PENDING:
            raise QueueFullError("检测队列已满,请稍后重试")
        job_id = _new_job_id()
        job = Job(
            id=job_id,
            protocol=protocol,
            base_url=redact_sensitive(base_url, (api_key,)),
            target_model=redact_sensitive(model, (api_key,)),
            mode=mode,
        )
        _JOBS[job_id] = job
    task = asyncio.create_task(
        _run(
            job_id, base_url, api_key, model, mode, protocol,
            include_long_context, include_long_context_extreme,
            revalidate_target,
        )
    )
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return job_id


async def get(job_id: str) -> Job | None:
    """Look up a job by id. Falls back to disk for jobs that survived a restart."""
    async with _LOCK:
        j = _JOBS.get(job_id)
    if j is not None:
        return j
    report = None
    for path in _report_candidates(job_id):
        if not path.exists():
            continue
        try:
            report = redact_sensitive(json.loads(path.read_text(encoding="utf-8")))
            break
        except (json.JSONDecodeError, OSError):
            continue
    if report is None:
        return None
    return Job(
        id=job_id,
        status="done",
        protocol=report.get("protocol", "anthropic"),
        base_url=report.get("base_url", ""),
        target_model=report.get("target_model", ""),
        mode=report.get("mode", "full"),
        created_at=time.time(),
        finished_at=time.time(),
        report=report,
    )


def report_path(job_id: str, protocol: str) -> Path:
    protocol_dir = JOBS_DIR / protocol
    protocol_dir.mkdir(parents=True, exist_ok=True)
    return protocol_dir / f"{job_id}.json"


def image_path(job_id: str, protocol: str) -> Path:
    protocol_dir = JOBS_DIR / protocol
    protocol_dir.mkdir(parents=True, exist_ok=True)
    return protocol_dir / f"{job_id}.jpg"


def _report_candidates(job_id: str) -> list[Path]:
    return [
        JOBS_DIR / f"{job_id}.json",
        JOBS_DIR / "anthropic" / f"{job_id}.json",
        JOBS_DIR / "openai" / f"{job_id}.json",
        JOBS_DIR / "gemini" / f"{job_id}.json",
    ]


async def _run(
    job_id: str,
    base_url: str,
    api_key: str,
    model: str,
    mode: str,
    protocol: str,
    include_long_context: bool = False,
    include_long_context_extreme: bool = False,
    revalidate_target: bool = False,
) -> None:
    async with _SEMA:
        async with _LOCK:
            j = _JOBS.get(job_id)
            if j is None:
                return
            j.status = "running"
            j.started_at = time.time()

        try:
            transport: httpx.AsyncBaseTransport | None = None
            if revalidate_target:
                base_url = await validate_target_url(base_url)
                transport = await build_safe_transport(base_url)
            cfg = ExecutionConfig.for_mode(Mode(mode), max_concurrent=3)
            cfg.include_long_context = include_long_context
            cfg.include_long_context_extreme = include_long_context_extreme
            # Long-context probes blow past the regular per-mode wall-clock
            # budget (60–180s). 1M-token requests alone take 2–4 minutes
            # upstream; the extreme path may also sleep 75s per tier waiting
            # for an OpenAI/Anthropic TPM window to reset before retrying
            # rate-limited probes (see _probe_tier_with_tpm_retry).
            # Without this bump asyncio.wait_for kills the runner
            # mid-detector and the user gets a misleading "fail" instead.
            if include_long_context_extreme:
                cfg.overall_timeout_s = max(cfg.overall_timeout_s, 900.0)
            elif include_long_context:
                cfg.overall_timeout_s = max(cfg.overall_timeout_s, 300.0)
            transport_kwargs = {"transport": transport} if transport is not None else {}
            if protocol == "openai":
                outcome = await _run_openai(
                    base_url, api_key, model, cfg, **transport_kwargs
                )
                report_protocol = Protocol.OPENAI
                report_tier = DetectionTier.BEHAVIORAL
                tier_title = "行为/协议级验证"
                tier_message = (
                    "本检测无法可靠区分高配模型真品与低配模型伪装。"
                    "我们检测的是中转站接口是否符合 OpenAI Chat Completions 协议规范、"
                    "能力是否完整、usage 字段是否符合官方响应形状。"
                )
            elif protocol == "gemini":
                outcome = await _run_gemini(
                    base_url, api_key, model, cfg, **transport_kwargs
                )
                report_protocol = Protocol.GEMINI
                report_tier = DetectionTier.PROTOCOL
                tier_title = "协议级验证"
                tier_message = (
                    "本检测通过 OpenAI 兼容协议 (POST /chat/completions) 探测 Gemini 中转站,"
                    "验证响应字段、tool 调用、结构化输出、流式一致性和 usage 字段是否符合 OpenAI 规范。"
                    "它不提供模型来源的官方身份认证。"
                )
            elif protocol == "anthropic":
                outcome = await _run_anthropic(
                    base_url, api_key, model, cfg, **transport_kwargs
                )
                report_protocol = Protocol.ANTHROPIC
                report_tier = DetectionTier.BEHAVIORAL
                tier_title = "多维证据级验证"
                tier_message = (
                    "Thinking signature 当前仅检查透传形态,不做独立密码学验签；"
                    "请结合身份、行为、能力与协议证据判断风险。"
                )
            else:
                raise ValueError(f"unsupported protocol: {protocol}")

            run_error = fatal_run_error(outcome.results)
            score = 0.0 if run_error else compute_total(outcome.results)
            verdict = effective_verdict(score, outcome.results)
            summary = run_error or summary_text(score, verdict)

            self_id: str | None = None
            brands: list[str] = []
            for r in outcome.results:
                if r.name != "identity" or not isinstance(r.details, dict):
                    continue
                text = r.details.get("response_text")
                if isinstance(text, str) and text.strip():
                    self_id = text.strip()
                b = r.details.get("detected_non_anthropic_brands")
                if isinstance(b, list):
                    brands = [x for x in b if isinstance(x, str)]
                break

            report = DetectionReport(
                protocol=report_protocol,
                tier=report_tier,
                tier_title=tier_title,
                tier_message=tier_message,
                base_url=base_url,
                api_key_masked=mask_api_key(api_key),
                target_model=model,
                mode=Mode(mode),
                timestamp=datetime.now(timezone.utc),
                total_score=score,
                verdict=verdict,
                results=outcome.results,
                performance=outcome.performance,
                summary=summary,
                run_error=run_error,
                self_reported_identity=self_id,
                detected_non_anthropic_brands=brands,
            )
            report_dict = redact_sensitive(
                json.loads(report.model_dump_json()),
                (api_key,),
            )
            _atomic_write_json(report_path(job_id, protocol), report_dict)

            async with _LOCK:
                if job_id in _JOBS:
                    _JOBS[job_id].status = "done"
                    _JOBS[job_id].protocol = protocol
                    _JOBS[job_id].report = report_dict
                    _JOBS[job_id].finished_at = time.time()
                    _evict_completed_locked()

        except Exception as e:  # noqa: BLE001 — bubble error into job state
            async with _LOCK:
                if job_id in _JOBS:
                    _JOBS[job_id].status = "error"
                    _JOBS[job_id].error = redact_sensitive(
                        f"{type(e).__name__}: {e}",
                        (api_key,),
                    )
                    _JOBS[job_id].finished_at = time.time()
                    _evict_completed_locked()


async def _run_anthropic(
    base_url: str,
    api_key: str,
    model: str,
    cfg: ExecutionConfig,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
):
    from relay_detector.protocols.anthropic import (
        build_detectors,
        build_runner,
        make_client,
    )

    async with make_client(
        base_url,
        api_key,
        timeout=cfg.request_timeout_s,
        transport=transport,
    ) as client:
        runner = build_runner(client, build_detectors(cfg.mode), cfg)
        return await runner.run(model)


async def _run_openai(
    base_url: str,
    api_key: str,
    model: str,
    cfg: ExecutionConfig,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
):
    from relay_detector.protocols.openai import (
        build_detectors,
        build_runner,
        make_client,
    )

    async with make_client(
        base_url,
        api_key,
        timeout=cfg.request_timeout_s,
        transport=transport,
    ) as client:
        runner = build_runner(client, build_detectors(cfg.mode), cfg)
        return await runner.run(model)


async def _run_gemini(
    base_url: str,
    api_key: str,
    model: str,
    cfg: ExecutionConfig,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
):
    from relay_detector.protocols.gemini import (
        build_detectors,
        build_runner,
        make_client,
    )

    async with make_client(
        base_url,
        api_key,
        timeout=cfg.request_timeout_s,
        transport=transport,
    ) as client:
        runner = build_runner(client, build_detectors(cfg.mode), cfg)
        return await runner.run(model)
