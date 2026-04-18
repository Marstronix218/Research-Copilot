from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def api_client() -> TestClient:
    """Provide a scoped FastAPI test client for endpoint contract tests."""
    with TestClient(app) as client:
        yield client
