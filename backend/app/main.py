"""FastAPI backend for the Research Copilot browser extension.

This module exposes endpoints for:
- Creating research sessions and seed questions.
- Analyzing captured page content for insights.
- Running a multi-turn goal-clarification flow.

Most endpoints use the configured LLM when available and fall back to
heuristic behavior when the model call fails.
"""

import json
import os
from typing import Any, Dict, List

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .goal_clarifier import (
    ClarifyNextRequest,
    ClarifyRefineRequest,
    ClarifyStartRequest,
    build_next_prompt,
    build_refine_prompt,
    build_start_prompt,
    heuristic_next,
    heuristic_start,
    parse_clarification_response,
    SYSTEM_PROMPT,
)

load_dotenv()

app = FastAPI(title="Research Copilot Backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

try:
    from openai import OpenAI

    # Keep client optional so the backend can run in heuristic-only mode.
    client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
except Exception:
    client = None


class SessionInitRequest(BaseModel):
    """Request body for creating a new research session.

    Input:
        goal: User's research goal statement.
    """

    goal: str = Field(..., min_length=3, max_length=500)


class SessionInitResponse(BaseModel):
    """Response payload containing normalized goal and starter questions.

    Output:
        goal: Goal used for question generation.
        questions: Seed research questions for browsing.
    """

    goal: str
    questions: List[str]


class PagePayload(BaseModel):
    """Captured page payload sent from the extension for analysis.

    Input:
        sourceType: Document type such as html or pdf.
        url/title/content: Captured page metadata and text.
        selection: Optional selected user text.
        timestamp/metadata: Optional extraction details.
    """

    sourceType: str | None = "html"
    url: str
    title: str
    content: str
    selection: str | None = ""
    timestamp: str | None = None
    metadata: Dict[str, Any] | None = None


class AnalyzeRequest(BaseModel):
    """Request body for page analysis against the current research goal.

    Input:
        goal: Active research goal.
        questions: Session research questions.
        page: Captured document payload.
    """

    goal: str
    questions: List[str] = []
    page: PagePayload


class Insight(BaseModel):
    """Single insight item returned by analysis.

    Output:
        topic: Insight category.
        summary: Human-readable takeaway.
        evidence: Supporting fragment, quote, or source hint.
        relevance: Qualitative confidence label.
    """

    topic: str
    summary: str
    evidence: str | None = ""
    relevance: str | None = "medium"


class AnalyzeResponse(BaseModel):
    """Structured analysis response consumed by the sidebar UI.

    Output:
        primary_topic: Main page topic.
        page_summary: Short overall summary.
        insights: Key extracted insights.
        missing_topics: Research questions not covered by this page.
    """

    primary_topic: str
    page_summary: str
    insights: List[Insight]
    missing_topics: List[str]


@app.get("/health")
def health():
    """Return backend health metadata for extension connectivity checks.

    Returns:
        Dict with server status, configured model, and LLM availability.
    """

    return {
        "healthy": True,
        "model": OPENAI_MODEL,
        "llm_enabled": bool(client),
    }


@app.post("/session/init", response_model=SessionInitResponse)
def initialize_session(req: SessionInitRequest):
    """Create starter research questions for a new session.

    Args:
        req: Session initialization request containing the research goal.

    Returns:
        SessionInitResponse with generated or heuristic question list.

    Steps:
        1. Attempt LLM-based JSON question generation.
        2. Parse and validate questions from model output.
        3. Fall back to deterministic question templates on failure.
    """

    if client:
        prompt = f"""
You are helping a user structure a browsing-based research session.
Goal: {req.goal}

Return exactly JSON with this shape:
{{
  "questions": ["...", "...", "..."]
}}

Rules:
- Generate 4 to 6 concrete research questions.
- Questions must be useful for web research.
- Keep them concise.
- No markdown.
""".strip()
        try:
            # Step 1-2: Generate and parse structured questions via LLM.
            completion = client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": "You generate structured research plans in strict JSON."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.3,
                response_format={"type": "json_object"},
            )
            content = completion.choices[0].message.content or "{}"
            data = json.loads(content)
            questions = data.get("questions", [])
            if questions:
                return SessionInitResponse(goal=req.goal, questions=questions)
        except Exception:
            # Fall back to local heuristics for availability and predictable
            # UX.
            pass

    fallback_questions = heuristic_questions(req.goal)
    return SessionInitResponse(goal=req.goal, questions=fallback_questions)


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze_page(req: AnalyzeRequest):
    """Analyze captured page content and return actionable research insights.

    Args:
        req: Analysis request containing goal, questions, and page payload.

    Returns:
        AnalyzeResponse from LLM or heuristic fallback.

    Steps:
        1. Build a strict JSON extraction prompt.
        2. Attempt model analysis and parse typed response.
        3. Fall back to heuristic extraction if model call fails.
    """

    if client:
        prompt = f"""
You are analyzing a web page for an AI-assisted research workflow.

Research goal: {req.goal}
Research questions: {json.dumps(req.questions, ensure_ascii=False)}
Page source type: {req.page.sourceType or 'html'}
Page title: {req.page.title}
Page URL: {req.page.url}
Selected text: {req.page.selection or ''}
Page content:
{req.page.content[:12000]}

Return exactly JSON with this schema:
{{
  "primary_topic": "...",
  "page_summary": "1-2 sentence summary",
  "insights": [
    {{
      "topic": "...",
      "summary": "...",
      "evidence": "specific claim, number, or quotation fragment if available",
      "relevance": "high|medium|low"
    }}
  ],
  "missing_topics": ["..."]
}}

Rules:
- Provide 1 to 3 insights.
- Prioritize information relevant to the user's research goal.
- Missing topics should be based on the user's research questions not yet obviously covered by this page.
- No markdown.
""".strip()
        try:
            # Step 1-2: Ask the model for strict JSON and validate via schema.
            completion = client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": "You analyze pages and return strict JSON."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.2,
                response_format={"type": "json_object"},
            )
            content = completion.choices[0].message.content or "{}"
            data = json.loads(content)
            return AnalyzeResponse(**data)
        except Exception as exc:
            # Fall through to heuristic mode.
            print(f"LLM analyze fallback: {exc}")

    return heuristic_analysis(req)


def heuristic_questions(goal: str) -> List[str]:
    """Generate baseline research questions when the LLM is unavailable.

    Args:
        goal: User research goal text.

    Returns:
        A stable list of question templates derived from the goal.
    """

    templates = [
        f"How is {goal} defined or measured?",
        f"What are the main causes or drivers of {goal}?",
        f"Who is most affected by {goal}?",
        f"What recent statistics or trends explain {goal}?",
        f"What policies or solutions are relevant to {goal}?",
    ]
    return templates


# ── Goal clarification endpoints ──────────────────────────────────────────────

def _call_llm_for_clarification(system: str, user: str) -> dict:
    """Call the LLM for goal clarification and parse normalized output.

    Args:
        system: System message defining clarifier behavior.
        user: User prompt for the current clarification turn.

    Returns:
        Normalized clarification payload from parse_clarification_response.

    Steps:
        1. Execute model call with JSON response mode.
        2. Read message content.
        3. Parse and validate response shape.
    """

    completion = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.4,
        response_format={"type": "json_object"},
    )
    raw = completion.choices[0].message.content or "{}"
    return parse_clarification_response(raw)


@app.post("/api/clarify-goal/start")
def clarify_goal_start(req: ClarifyStartRequest):
    """Start the clarification flow.

    Args:
        req: ClarifyStartRequest with the rough goal text.

    Returns:
        Clarification payload from LLM or heuristic fallback.
    """

    if client:
        try:
            prompt = build_start_prompt(req.roughGoal)
            return _call_llm_for_clarification(SYSTEM_PROMPT, prompt)
        except Exception as exc:
            print(f"clarify-goal/start LLM error: {exc}")
    return heuristic_start(req.roughGoal)


@app.post("/api/clarify-goal/next")
def clarify_goal_next(req: ClarifyNextRequest):
    """Advance clarification using chat history and collected answers.

    Args:
        req: ClarifyNextRequest containing ongoing conversation state.

    Returns:
        Next clarification message or final clarified goal payload.
    """

    if client:
        try:
            prompt = build_next_prompt(req.roughGoal, req.chatHistory, req.answers)
            return _call_llm_for_clarification(SYSTEM_PROMPT, prompt)
        except Exception as exc:
            print(f"clarify-goal/next LLM error: {exc}")
    return heuristic_next(req.roughGoal, req.chatHistory, req.answers)


@app.post("/api/clarify-goal/refine")
def clarify_goal_refine(req: ClarifyRefineRequest):
    """Refine an already proposed clarified goal.

    Args:
        req: ClarifyRefineRequest including current clarified goal candidate.

    Returns:
        Refined goal payload or follow-up clarification question payload.
    """

    if client:
        try:
            prompt = build_refine_prompt(
                req.roughGoal, req.chatHistory, req.answers, req.currentClarifiedGoal
            )
            return _call_llm_for_clarification(SYSTEM_PROMPT, prompt)
        except Exception as exc:
            print(f"clarify-goal/refine LLM error: {exc}")
    return heuristic_next(req.roughGoal, req.chatHistory, req.answers)


def heuristic_analysis(req: AnalyzeRequest) -> AnalyzeResponse:
    """Return a best-effort analysis when LLM analysis is unavailable.

    Args:
        req: Analysis request with goal, questions, and page content.

    Returns:
        AnalyzeResponse with a summary insight and inferred missing topics.

    Steps:
        1. Build a short page summary from captured content.
        2. Mark covered questions via simple keyword overlap.
        3. Return one conservative insight and remaining missing topics.
    """

    title = req.page.title or "Untitled page"
    content = req.page.content
    summary = content[:240].strip()
    if len(content) > 240:
        summary += "..."

    # Step 2: mark questions as covered when key terms appear in page text.
    covered = []
    lower_content = content.lower()
    for q in req.questions:
        q_lower = q.lower()
        key_terms = [w for w in q_lower.replace('?', '').split() if len(w) > 4]
        if any(term in lower_content for term in key_terms[:3]):
            covered.append(q)

    missing = [q for q in req.questions if q not in covered]

    # Step 3: emit a minimal but consistent insight payload.
    insights = [
        Insight(
            topic=title[:80],
            summary=summary or "This page may contain potentially relevant information.",
            evidence=req.page.selection[:160] if req.page.selection else req.page.url,
            relevance="medium",
        )
    ]

    return AnalyzeResponse(
        primary_topic=title[:80],
        page_summary=summary or "Relevant page captured.",
        insights=insights,
        missing_topics=missing,
    )
