from __future__ import annotations

import pytest

from app.goal_clarifier import (
    build_next_prompt,
    build_refine_prompt,
    build_start_prompt,
    heuristic_next,
    heuristic_start,
    parse_clarification_response,
)


def test_parse_clarification_response_strips_code_fences() -> None:
    raw = """```json
    {
      "status": "needs_clarification",
      "message": {
        "text": "Which scope matters most?",
        "options": ["Global", "Japan"]
      }
    }
    ```"""

    parsed = parse_clarification_response(raw)

    assert parsed["status"] == "needs_clarification"
    assert parsed["message"]["text"] == "Which scope matters most?"
    assert parsed["message"]["options"] == ["Global", "Japan"]


def test_parse_clarification_response_complete_shape() -> None:
    raw = '{"status":"complete","clarifiedGoal":"Analyze poverty trends in Japan from 2010 to 2025","rationale":"Adds scope and timeframe."}'

    parsed = parse_clarification_response(raw)

    assert parsed["status"] == "complete"
    assert "clarifiedGoal" in parsed
    assert "rationale" in parsed


def test_parse_clarification_response_unknown_status_raises() -> None:
    with pytest.raises(ValueError, match="Unknown status field"):
        parse_clarification_response('{"status":"oops"}')


def test_build_start_prompt_contains_goal_and_schemas() -> None:
    goal = "Understand poverty in Japan"
    prompt = build_start_prompt(goal)

    assert f"<goal>{goal}</goal>" in prompt
    assert '"status":"needs_clarification"' in prompt
    assert '"status":"complete"' in prompt


def test_build_next_prompt_counts_questions_from_history() -> None:
    chat_history = [
        {"role": "assistant", "text": "Which region?"},
        {"role": "user", "text": "Tokyo"},
    ]
    prompt = build_next_prompt("Study poverty", chat_history, ["Tokyo"])

    assert "Questions asked so far: 1" in prompt
    assert "Assistant: Which region?" in prompt
    assert "User: Tokyo" in prompt


def test_build_refine_prompt_includes_current_goal_when_present() -> None:
    prompt = build_refine_prompt(
        rough_goal="Study poverty",
        chat_history=[{"role": "assistant", "text": "Which population?"}],
        answers=["Children"],
        current_goal="Study child poverty in Japan from 2015 onward",
    )

    assert "<current>Study child poverty in Japan from 2015 onward</current>" in prompt


def test_heuristic_start_returns_first_question_payload() -> None:
    response = heuristic_start("Study poverty")

    assert response["status"] == "needs_clarification"
    assert response["message"]["role"] == "assistant"
    assert response["message"]["type"] == "question"
    assert len(response["message"]["options"]) >= 4


def test_heuristic_next_completes_after_question_bank_is_exhausted() -> None:
    chat_history = [{"role": "assistant", "text": f"Q{i}"} for i in range(4)]
    answers = ["Causes & drivers", "General population", "Current situation"]

    response = heuristic_next("Climate change impacts", chat_history, answers)

    assert response["status"] == "complete"
    assert "focusing on causes & drivers" in response["clarifiedGoal"]
    assert "for general population" in response["clarifiedGoal"]
