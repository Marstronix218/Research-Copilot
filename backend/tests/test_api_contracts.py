from __future__ import annotations


def test_health_endpoint_contract(api_client) -> None:
    response = api_client.get("/health")

    assert response.status_code == 200
    data = response.json()
    assert set(data.keys()) == {"healthy", "model", "llm_enabled"}
    assert isinstance(data["healthy"], bool)
    assert isinstance(data["model"], str)
    assert isinstance(data["llm_enabled"], bool)


def test_session_init_endpoint_contract(api_client) -> None:
    response = api_client.post("/session/init", json={"goal": "Understand poverty in Japan"})

    assert response.status_code == 200
    data = response.json()
    assert data["goal"] == "Understand poverty in Japan"
    assert isinstance(data["questions"], list)
    assert len(data["questions"]) >= 4
    assert all(isinstance(question, str) for question in data["questions"])


def test_analyze_endpoint_contract(api_client) -> None:
    payload = {
        "goal": "Understand poverty in Japan",
        "questions": ["What are the main drivers?"],
        "page": {
            "sourceType": "html",
            "url": "https://example.com/report",
            "title": "Report",
            "content": "The report discusses poverty drivers, labor, and housing trends in Japan.",
            "selection": "",
        },
    }

    response = api_client.post("/analyze", json=payload)

    assert response.status_code == 200
    data = response.json()
    assert set(data.keys()) == {
        "primary_topic",
        "page_summary",
        "insights",
        "missing_topics",
    }
    assert isinstance(data["insights"], list)
    assert isinstance(data["missing_topics"], list)


def test_clarify_goal_start_endpoint_contract(api_client) -> None:
    response = api_client.post("/api/clarify-goal/start", json={"roughGoal": "Study AI safety"})

    assert response.status_code == 200
    data = response.json()
    assert data["status"] in {"needs_clarification", "complete"}

    if data["status"] == "needs_clarification":
        assert "message" in data
        assert isinstance(data["message"].get("text"), str)


def test_clarify_goal_next_endpoint_contract(api_client) -> None:
    payload = {
        "roughGoal": "Study AI safety",
        "chatHistory": [
            {"role": "assistant", "text": "Which part of AI safety?"},
            {"role": "user", "text": "Policy"},
        ],
        "answers": ["Policy"],
    }

    response = api_client.post("/api/clarify-goal/next", json=payload)

    assert response.status_code == 200
    data = response.json()
    assert data["status"] in {"needs_clarification", "complete"}


def test_clarify_goal_refine_endpoint_contract(api_client) -> None:
    payload = {
        "roughGoal": "Study AI safety",
        "chatHistory": [{"role": "assistant", "text": "Which part of AI safety?"}],
        "answers": ["Policy"],
        "currentClarifiedGoal": "Analyze AI policy responses in OECD countries",
    }

    response = api_client.post("/api/clarify-goal/refine", json=payload)

    assert response.status_code == 200
    data = response.json()
    assert data["status"] in {"needs_clarification", "complete"}
