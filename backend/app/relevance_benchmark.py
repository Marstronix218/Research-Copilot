"""Benchmark heuristic question-coverage strategies used in offline analysis.

This script compares lightweight lexical strategies for deciding whether a
research question appears covered by a page's content. It is intended for
algorithmic critique and documentation, not runtime production use.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class CoverageCase:
    question: str
    content: str
    expected_covered: bool


def _tokenize_question(question: str, *, min_len: int = 5) -> list[str]:
    """Extract normalized informative terms from a question string."""
    return [
        token
        for token in question.lower().replace("?", "").split()
        if len(token) >= min_len
    ]


def strategy_prefix_terms(question: str, content: str) -> bool:
    """Match if any of the first three informative terms appears in content.

    This mirrors the current runtime-style heuristic used in fallback analysis.
    """
    terms = _tokenize_question(question)
    content_lower = content.lower()
    return any(term in content_lower for term in terms[:3])


def strategy_majority_terms(question: str, content: str) -> bool:
    """Match if at least half of informative terms are present in content."""
    terms = _tokenize_question(question)
    if not terms:
        return False

    content_lower = content.lower()
    matches = sum(1 for term in terms if term in content_lower)
    return matches >= max(1, len(terms) // 2)


def evaluate_strategy(
    cases: list[CoverageCase],
    strategy: Callable[[str, str], bool],
) -> dict[str, float]:
    """Return accuracy, precision, recall, and F1 for one strategy."""
    tp = fp = tn = fn = 0

    for case in cases:
        predicted = strategy(case.question, case.content)
        actual = case.expected_covered

        if predicted and actual:
            tp += 1
        elif predicted and not actual:
            fp += 1
        elif not predicted and not actual:
            tn += 1
        else:
            fn += 1

    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (
        (2 * precision * recall / (precision + recall))
        if (precision + recall)
        else 0.0
    )
    accuracy = (tp + tn) / len(cases) if cases else 0.0

    return {
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


def load_cases(path: Path) -> list[CoverageCase]:
    """Load benchmark cases from JSON fixture file."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    return [CoverageCase(**item) for item in raw]


def main() -> None:
    fixture_path = (
        Path(__file__).resolve().parent.parent
        / "tests"
        / "fixtures"
        / "relevance_cases.json"
    )
    cases = load_cases(fixture_path)

    strategies = {
        "prefix_terms": strategy_prefix_terms,
        "majority_terms": strategy_majority_terms,
    }

    print("Coverage strategy benchmark")
    print("=" * 32)
    for name, strategy in strategies.items():
        metrics = evaluate_strategy(cases, strategy)
        print(f"{name}: {metrics}")


if __name__ == "__main__":
    main()
