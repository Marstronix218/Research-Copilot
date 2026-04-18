from __future__ import annotations

from app.main import AnalyzeRequest, PagePayload, heuristic_analysis, heuristic_questions


def test_heuristic_questions_returns_five_goal_specific_questions() -> None:
    goal = "poverty in Japan"
    questions = heuristic_questions(goal)

    assert len(questions) == 5
    assert all(goal in question for question in questions)


def test_heuristic_analysis_marks_missing_topics_by_keyword_overlap() -> None:
    req = AnalyzeRequest(
        goal="Understand climate change",
        questions=[
            "What causes climate change?",
            "What policy solutions are working?",
        ],
        page=PagePayload(
            url="https://example.com/climate",
            title="Climate causes",
            content=(
                "Climate change causes include fossil fuel emissions and land use changes. "
                "These causes are measured across sectors and regions."
            ),
            selection="",
        ),
    )

    analysis = heuristic_analysis(req)

    assert analysis.primary_topic == "Climate causes"
    assert "What causes climate change?" not in analysis.missing_topics
    assert "What policy solutions are working?" in analysis.missing_topics
    assert len(analysis.insights) == 1


def test_heuristic_analysis_truncates_long_summary() -> None:
    req = AnalyzeRequest(
        goal="Test truncation",
        questions=[],
        page=PagePayload(
            url="https://example.com/long",
            title="Long page",
            content="x" * 300,
            selection="",
        ),
    )

    analysis = heuristic_analysis(req)

    assert analysis.page_summary.endswith("...")


def test_heuristic_analysis_prefers_selection_as_evidence() -> None:
    req = AnalyzeRequest(
        goal="Evidence behavior",
        questions=[],
        page=PagePayload(
            url="https://example.com/evidence",
            title="Evidence page",
            content="Short body content",
            selection="Selected supporting snippet",
        ),
    )

    analysis = heuristic_analysis(req)

    assert analysis.insights[0].evidence == "Selected supporting snippet"
