"""One model-name to protocol heuristic shared by CLI and web callers."""

from __future__ import annotations

from ..core.models import Protocol


def protocol_from_model(
    model: str,
    *,
    default: Protocol | None = None,
) -> Protocol | None:
    """Infer a protocol from common model aliases and provider namespaces."""
    if not isinstance(model, str) or not model.strip():
        return default
    normalized = model.strip().lower().removeprefix("models/")
    if normalized.startswith("claude") or "/claude" in normalized:
        return Protocol.ANTHROPIC
    if normalized.startswith("gemini") or "/gemini" in normalized:
        return Protocol.GEMINI
    if normalized.startswith(
        (
            "gpt-",
            "o1",
            "o3",
            "o4",
            "chatgpt",
            "text-embedding-",
            "openai/",
            "azure/openai",
        )
    ):
        return Protocol.OPENAI
    return default
