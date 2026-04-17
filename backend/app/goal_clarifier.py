"""
Goal clarification helper module.

Transforms vague research goals into specific, researchable ones via a
multi-turn clarification flow. Contains prompt builders, response parsers,
and heuristic fallbacks used when no LLM is available.
"""

from __future__ import annotations

import json
import re
from typing import Any, List

from pydantic import BaseModel, Field


# ── Request models ────────────────────────────────────────────────────────────

class ClarifyStartRequest(BaseModel):
    """Initial request for clarifying a rough research goal.

    Input:
        roughGoal: User-provided high-level research intent.
    """

    roughGoal: str = Field(..., min_length=1, max_length=1000)


class ClarifyNextRequest(BaseModel):
    """Follow-up request carrying clarification chat state and user answers.

    Input:
        roughGoal: Original user goal text.
        chatHistory: Prior assistant/user clarification turns.
        answers: User answer list captured so far.
    """

    roughGoal: str = Field(..., min_length=1, max_length=1000)
    chatHistory: List[dict] = Field(default_factory=list)
    answers: List[str] = Field(default_factory=list)


class ClarifyRefineRequest(BaseModel):
    """Request for improving an already proposed clarified goal.

    Input:
        roughGoal: Original user goal text.
        chatHistory: Prior clarification conversation.
        answers: Collected answers from the conversation.
        currentClarifiedGoal: Current candidate goal to improve.
    """

    roughGoal: str = Field(..., min_length=1, max_length=1000)
    chatHistory: List[dict] = Field(default_factory=list)
    answers: List[str] = Field(default_factory=list)
    currentClarifiedGoal: str | None = None


# ── Prompt builders ───────────────────────────────────────────────────────────

SYSTEM_PROMPT = (
    "You are a research goal clarification assistant. "
    "Help users transform vague research ideas into specific, researchable goals. "
    "Ask short targeted questions with multiple-choice options. Aim for 3–5 questions total. "
    "Always return valid JSON only. No markdown, no extra text, no code fences."
)

_SCHEMA_QUESTION = (
    '{"status":"needs_clarification","message":{"role":"assistant","type":"question",'
    '"text":"<your question>","options":["<opt1>","<opt2>","<opt3>","<opt4>"]}}'
)

_SCHEMA_COMPLETE = (
    '{"status":"complete","clarifiedGoal":"<specific researchable goal under 50 words>",'
    '"rationale":"<1-sentence explanation of what was improved>"}'
)


def build_start_prompt(rough_goal: str) -> str:
    """Build the first-turn prompt for goal clarification.

    Args:
        rough_goal: Raw goal text provided by the user.

    Returns:
        A strict prompt instructing the model to either finalize the goal or
        ask one high-value clarification question in JSON.

    Steps:
        1. Inject the user goal in a delimited block.
        2. Describe decision criteria (specific vs vague).
        3. Constrain output to one of two JSON schemas.
    """

    # The user goal is wrapped in XML-style tags to reduce prompt-injection risk.
    return f"""User's rough research goal:
<goal>{rough_goal}</goal>

Decide:
1. If the goal is ALREADY specific (clear topic + angle + scope + time frame if relevant), return {_SCHEMA_COMPLETE} with a lightly polished version.
2. If the goal is VAGUE, ask the single most important clarifying question with 4–6 short options.

Return ONLY one of these exact JSON shapes (nothing else):
{_SCHEMA_QUESTION}
OR
{_SCHEMA_COMPLETE}"""


def build_next_prompt(rough_goal: str, chat_history: list, answers: list) -> str:
    """Build a continuation prompt from prior clarification turns.

    Args:
        rough_goal: Original user goal text.
        chat_history: Ordered clarification messages.
        answers: User answers collected so far.

    Returns:
        A prompt that asks the model to either finalize or ask one next
        question based on progress.

    Steps:
        1. Count prior assistant questions.
        2. Render chat history into readable dialogue lines.
        3. Add explicit stopping and no-repeat rules.
    """

    question_count = sum(1 for m in chat_history if m.get("role") == "assistant")
    history_lines = [
        f"{'Assistant' if m.get('role') == 'assistant' else 'User'}: {m.get('text', '')}"
        for m in chat_history
    ]
    history_text = "\n".join(history_lines) if history_lines else "(none yet)"

    return f"""Research goal clarification in progress.

Original rough goal:
<goal>{rough_goal}</goal>

Clarification conversation so far:
{history_text}

Questions asked so far: {question_count}

Rules:
- If {question_count} >= 3 OR you now have enough detail (topic + angle + scope), FINALIZE.
- Otherwise ask the next most important question (max 5 questions total, no repeats).

The clarified goal must be: specific, under 50 words, include topic + angle + population/unit + time frame when relevant.

Return ONLY one JSON shape (nothing else):
{_SCHEMA_QUESTION}
OR
{_SCHEMA_COMPLETE}"""


def build_refine_prompt(
    rough_goal: str,
    chat_history: list,
    answers: list,
    current_goal: str | None,
) -> str:
    """Build a refinement prompt for improving a proposed clarified goal.

    Args:
        rough_goal: Original user goal text.
        chat_history: Existing clarification conversation.
        answers: User answers gathered so far.
        current_goal: Current proposed clarified goal, if available.

    Returns:
        A prompt asking the model to refine the current goal or ask one final
        targeted question.

    Steps:
        1. Render conversation context.
        2. Include current goal candidate when present.
        3. Enforce strict JSON output schema.
    """

    history_lines = [
        f"{'Assistant' if m.get('role') == 'assistant' else 'User'}: {m.get('text', '')}"
        for m in chat_history
    ]
    history_text = "\n".join(history_lines) if history_lines else "(none)"
    current_section = (
        f"\nCurrently proposed clarified goal:\n<current>{current_goal}</current>\n"
        if current_goal
        else ""
    )

    return f"""The user wants to refine their research goal.

Original rough goal:
<goal>{rough_goal}</goal>
{current_section}
Clarification conversation so far:
{history_text}

Generate a BETTER and more specific version of the clarified goal.
If something important is still unclear, ask one more targeted question instead.

Return ONLY one JSON shape (nothing else):
{_SCHEMA_QUESTION}
OR
{_SCHEMA_COMPLETE}"""


# ── Response parsing ──────────────────────────────────────────────────────────

def parse_clarification_response(raw: str) -> dict[str, Any]:
    """Parse and validate a clarification response payload.

    Args:
        raw: Raw model output expected to contain a JSON object.

    Returns:
        A normalized dict with one of two shapes:
        - needs_clarification: assistant message + options
        - complete: clarifiedGoal + rationale

    Raises:
        ValueError: If required fields are missing or status is unknown.
        json.JSONDecodeError: If the raw payload is not valid JSON.

    Steps:
        1. Trim payload and remove accidental markdown fences.
        2. Parse JSON.
        3. Validate based on status and normalize fields.
    """
    text = raw.strip()
    # Strip code fences if the model wraps output despite instructions
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)

    data = json.loads(text)
    status = data.get("status")

    if status == "needs_clarification":
        # Branch A: the model requests another question-answer turn.
        msg = data.get("message") or {}
        if not msg.get("text"):
            raise ValueError("Missing message.text in needs_clarification response")
        return {
            "status": "needs_clarification",
            "message": {
                "role": "assistant",
                "type": msg.get("type", "question"),
                "text": str(msg["text"]),
                "options": [str(o) for o in (msg.get("options") or [])],
            },
        }

    if status == "complete":
        # Branch B: the model finished and produced a clarified goal.
        if not data.get("clarifiedGoal"):
            raise ValueError("Missing clarifiedGoal in complete response")
        return {
            "status": "complete",
            "clarifiedGoal": str(data["clarifiedGoal"]),
            "rationale": str(data.get("rationale") or ""),
        }

    raise ValueError(f"Unknown status field: {status!r}")


# ── Heuristic fallback (no LLM) ───────────────────────────────────────────────

_QUESTION_BANK: List[dict] = [
    {
        "text": "Which aspect of this topic are you most interested in?",
        "options": ["Causes & drivers", "Effects & impact", "Policy & solutions", "Statistics & trends", "International comparisons"],
    },
    {
        "text": "Who or what is the main focus of your research?",
        "options": ["General population", "Children & youth", "Working-age adults", "A specific country or region", "A specific industry or sector"],
    },
    {
        "text": "What time period matters most?",
        "options": ["Current situation", "Last 10 years", "Since 2000", "Historical long-term", "Post-COVID (2020+)"],
    },
    {
        "text": "What is the purpose of this research?",
        "options": ["Academic study", "Policy understanding", "Business research", "General learning", "Journalism / reporting"],
    },
]


def heuristic_start(rough_goal: str) -> dict[str, Any]:
    """Return the first canned clarification question for offline mode.

    Args:
        rough_goal: Original user goal text (kept for interface consistency).

    Returns:
        A needs_clarification payload with the first question bank item.

    Steps:
        1. Select question index 0.
        2. Wrap it in the same contract used by LLM responses.
    """

    return {
        "status": "needs_clarification",
        "message": {
            "role": "assistant",
            "type": "question",
            **_QUESTION_BANK[0],
        },
    }


def heuristic_next(rough_goal: str, chat_history: list, answers: list) -> dict[str, Any]:
    """Advance or complete clarification using deterministic fallback rules.

    Args:
        rough_goal: Original user goal text.
        chat_history: Prior clarification turns.
        answers: User answers collected so far.

    Returns:
        A needs_clarification payload if more questions remain, otherwise a
        complete payload with a synthesized clarified goal.

    Steps:
        1. Count assistant questions already asked.
        2. Return the next canned question while the bank is not exhausted.
        3. Synthesize a concise clarified goal from collected answers.
    """

    question_count = sum(1 for m in chat_history if m.get("role") == "assistant")

    if question_count < len(_QUESTION_BANK):
        # Continue asking predefined questions until the bank is exhausted.
        return {
            "status": "needs_clarification",
            "message": {
                "role": "assistant",
                "type": "question",
                **_QUESTION_BANK[question_count],
            },
        }

    # Synthesize a basic clarified goal from the collected answers.
    parts = [rough_goal.rstrip(".")]
    if len(answers) > 0:
        parts.append(f"focusing on {answers[0].lower()}")
    if len(answers) > 1:
        parts.append(f"for {answers[1].lower()}")
    if len(answers) > 2:
        parts.append(f"({answers[2].lower()})")

    return {
        "status": "complete",
        "clarifiedGoal": " ".join(parts).rstrip(".") + ".",
        "rationale": "Synthesised from your clarification answers (AI unavailable).",
    }
