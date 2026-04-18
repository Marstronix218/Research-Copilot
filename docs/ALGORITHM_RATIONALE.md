# Algorithm Rationale

This document explains the heuristic choices used in Research Copilot and the
trade-offs considered while selecting them.

## 1. Page Relevance Scoring

Primary implementation: [extension/relevanceScorer.js](../extension/relevanceScorer.js)

### Why this approach
- Needs low-latency scoring in a browser extension service worker.
- Must be explainable because drift notifications should be auditable.
- Must work even when backend LLM is unavailable.

### Signals used
- Keyword overlap between goal/questions and page metadata/snippet.
- Domain priors (research-oriented boost and distraction penalties).
- Manual relevance override.

### Key trade-off
- Heuristic lexical overlap is fast and deterministic, but can miss semantic
  matches where wording differs.
- Future work: add embedding-backed semantic scoring as an optional layer.

## 2. Drift Detection

Primary implementation: [extension/driftDetector.js](../extension/driftDetector.js)

### Why this approach
- Drift should reflect behavior over time, not one page classification.
- Combined signals (idle state + dwell time + recent history) reduce false
  positives from brief off-topic page switches.

### Key trade-off
- Conservative thresholds delay some notifications but improve trust by
  reducing noisy nudges.

## 3. Insight Grouping

Primary implementation: [extension/insightGrouping.js](../extension/insightGrouping.js)

### Why this approach
- Clustering must run locally, quickly, and produce human-readable reasons.
- A weighted lexical-source matching approach supports explainable grouping.

### Key trade-off
- Heuristic clusters are explainable but may be less semantically rich than
  embedding-based clustering.

## 4. Coverage Heuristic Benchmark (Backend)

Benchmark script: [backend/app/relevance_benchmark.py](../backend/app/relevance_benchmark.py)
Fixture cases: [backend/tests/fixtures/relevance_cases.json](../backend/tests/fixtures/relevance_cases.json)

### Compared strategies
- `prefix_terms`: matches if any of first 3 informative terms appears.
- `majority_terms`: matches if at least half of informative terms appear.

### Intended use
- Provide reproducible evidence for selecting fallback heuristics.
- Support capstone-level computational critique with measurable outcomes.
