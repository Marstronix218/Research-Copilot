# Architecture Decisions

This document records structural decisions that improve code readability,
separation of concerns, and abstraction quality.

## Decision 1: Background utility extraction

- Original state: [extension/background.js](../extension/background.js) held
  both orchestration and low-level merge/domain helpers.
- Change: helper logic moved to
  [extension/background/sessionUtils.js](../extension/background/sessionUtils.js).
- Rationale: keep background worker focused on workflow orchestration while
  utility logic remains independently testable.

## Decision 2: Runtime message contract validation

- Original state: handlers assumed incoming runtime messages were well-formed.
- Change: added
  [extension/contracts/messages.js](../extension/contracts/messages.js) and
  integrated parser into background message router.
- Rationale: strengthen abstraction boundaries and fail fast on malformed
  message payloads.

## Decision 3: Automated test scaffolding for backend and extension

- Backend tests added under [backend/tests](../backend/tests).
- Extension tests added under [extension/tests](../extension/tests) with
  Vitest tooling.
- Rationale: provide regression protection before deeper refactors and create
  measurable evidence for testing rigor.

## Decision 4: Keep behavior stable while increasing modularity

- Refactors prioritize extraction of pure helpers first.
- Integration-facing workflows remain in existing entry files.
- Rationale: reduce regression risk in a browser-extension runtime where
  debugging can be expensive.
