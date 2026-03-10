import json
import os
from typing import List

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

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
    client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
except Exception:
    client = None


class SessionInitRequest(BaseModel):
    goal: str = Field(..., min_length=3, max_length=500)


class SessionInitResponse(BaseModel):
    goal: str
    questions: List[str]


class PagePayload(BaseModel):
    url: str
    title: str
    content: str
    selection: str | None = ""
    timestamp: str | None = None


class AnalyzeRequest(BaseModel):
    goal: str
    questions: List[str] = []
    page: PagePayload


class Insight(BaseModel):
    topic: str
    summary: str
    evidence: str | None = ""
    relevance: str | None = "medium"


class AnalyzeResponse(BaseModel):
    primary_topic: str
    page_summary: str
    insights: List[Insight]
    missing_topics: List[str]


@app.get("/health")
def health():
    return {"healthy": True, "model": OPENAI_MODEL, "llm_enabled": bool(client)}


@app.post("/session/init", response_model=SessionInitResponse)
def initialize_session(req: SessionInitRequest):
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
            pass

    fallback_questions = heuristic_questions(req.goal)
    return SessionInitResponse(goal=req.goal, questions=fallback_questions)


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze_page(req: AnalyzeRequest):
    if client:
        prompt = f"""
You are analyzing a web page for an AI-assisted research workflow.

Research goal: {req.goal}
Research questions: {json.dumps(req.questions, ensure_ascii=False)}
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
    templates = [
        f"How is {goal} defined or measured?",
        f"What are the main causes or drivers of {goal}?",
        f"Who is most affected by {goal}?",
        f"What recent statistics or trends explain {goal}?",
        f"What policies or solutions are relevant to {goal}?",
    ]
    return templates


def heuristic_analysis(req: AnalyzeRequest) -> AnalyzeResponse:
    title = req.page.title or "Untitled page"
    content = req.page.content
    summary = content[:240].strip()
    if len(content) > 240:
        summary += "..."

    covered = []
    lower_content = content.lower()
    for q in req.questions:
        q_lower = q.lower()
        key_terms = [w for w in q_lower.replace('?', '').split() if len(w) > 4]
        if any(term in lower_content for term in key_terms[:3]):
            covered.append(q)

    missing = [q for q in req.questions if q not in covered]

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
