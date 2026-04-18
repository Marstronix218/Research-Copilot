# Mini Capstone Submission: Research Copilot

**Course:** CP192 -- Year 3 Spring, Unit 3  
**Date:** April 2026  
**Project:** Research Copilot -- A Goal-Driven Browser Research Assistant  
**Repository:** [GitHub -- Marstronix218/research-copilot](https://github.com/Marstronix218/research-copilot)

---

# Part 1: Executive Summary

Online research is messy. A student starts with a vague question, opens dozens of tabs, loses track of which sources mattered, and ends up with scattered notes and no clear synthesis. Existing tools either clip content without research structure (Notion Web Clipper, Google Keep) or provide structure without browsing integration (Zotero, reference managers). None of them actively guide the research process or alert the user when they drift off-topic.

**Research Copilot** is a Chrome extension paired with a lightweight Python backend that turns browsing into a structured research workflow. Users begin by entering a rough research goal. A multi-turn clarification flow refines that goal into specific research questions. As the user browses, the system automatically analyzes each visited page, extracts structured insights, and tracks which questions have and have not been addressed. A drift detection system monitors browsing behavior and nudges the user when they spend too long on unrelated pages. All insights, sources, and questions are organized in a persistent side panel that serves as the research workspace.

The system is designed to work even without an internet-connected AI service: deterministic heuristic algorithms handle relevance scoring, drift detection, and insight clustering locally, while an OpenAI-backed backend provides deeper analysis when available.

Over five weeks and 29 commits across 7 pull requests, I built a working product with 40 automated tests, architecture decision records, and a benchmark comparing heuristic strategies with measurable metrics.

### System Architecture

```
+---------------------------------------------------------------+
|                        Chrome Browser                          |
|                                                                |
|  +------------------+   messages   +------------------------+  |
|  |  Content Script  | <==========> | Background Service     |  |
|  |  (content.js)    |              | Worker (background.js) |  |
|  |  - page text     |              | - session lifecycle    |  |
|  |    extraction     |              | - analysis routing     |  |
|  |  - insight toasts |              | - drift tick alarm     |  |
|  |  - drift toasts   |              | - PDF capture          |  |
|  +------------------+              +----------+--------------+  |
|                                         |    ^                  |
|  +------------------+    storage        |    |  chrome.storage   |
|  |   Side Panel     | <================+    |                   |
|  |  (sidebar.js)    |                       |                   |
|  |  - research      |    +------------------+-------+           |
|  |    workspace      |   | Algorithm Modules        |           |
|  |  - insights,     |   | - relevanceScorer.js     |           |
|  |    questions,     |   | - driftDetector.js       |           |
|  |    sources tabs   |   | - insightGrouping.js     |           |
|  +------------------+   | - notificationManager.js  |           |
|                          +---------------------------+           |
+-------------------------------+----------------------------------+
                                |  HTTP
                                v
                  +----------------------------+
                  |   FastAPI Backend           |
                  |   - /session/init           |
                  |   - /analyze                |
                  |   - /api/clarify-goal/*     |
                  |                              |
                  |   OpenAI (gpt-4.1-mini)     |
                  |      |                       |
                  |      v  fallback             |
                  |   Heuristic Engine           |
                  +----------------------------+
```

*Figure 1: Data flow through the Research Copilot system. The content script extracts page text and sends it to the background worker, which routes it to the backend for analysis. Insights flow back through storage to the side panel. Algorithm modules run locally in the service worker for low-latency scoring and drift evaluation.*

---

# Part 2: Academic Abstract

Unstructured web research leads to goal drift, lost sources, and weak synthesis -- problems that existing browser tools fail to address as an integrated workflow. This project presents Research Copilot, a Chrome Manifest V3 extension with a FastAPI backend that scaffolds the research process through goal clarification, automatic page analysis, insight capture, and behavioral drift detection.

The backend provides two analysis paths: an OpenAI-backed pipeline that extracts structured insights with topic labels, summaries, evidence quotes, and relevance assessments; and a deterministic heuristic fallback that operates when LLM services are unavailable. The extension implements three local algorithms: a relevance scorer combining keyword overlap with domain priors and distraction penalties; a drift detector evaluating temporal, behavioral, and categorical signals to distinguish focused, slipping, drifting, and inactive states; and an insight clustering module using Jaccard similarity over lexical and source features. A benchmark comparing two heuristic coverage strategies (prefix-term and majority-term matching) provides quantitative evidence for algorithm selection using precision, recall, and F1 metrics.

The system was developed iteratively over five weeks through 29 commits and 7 pull requests, progressing from core functionality through UX refinement to engineering quality. The final product includes 40 automated tests across pytest and Vitest, runtime message contract validation, architecture decision records, and algorithm rationale documentation. The project demonstrates that lightweight heuristic approaches can deliver useful research scaffolding in browser-constrained environments, with graceful degradation when LLM services are unavailable.

---

# Part 3: Capstone Work Product

## 3.1 Problem and Audience

The target user is a student conducting web-based research for a paper, project, or assignment. The core pain points are:

- **Goal drift**: Starting with a vague question and wandering across unrelated topics without realizing it.
- **Scattered notes**: Insights end up in separate tabs, documents, or are forgotten entirely.
- **Lost sources**: Closing a tab means losing the evidence that came from it.
- **Weak synthesis**: Without explicit research questions, there is no way to know what has been covered and what remains.

No existing tool combines goal-driven session management, automatic page analysis, and behavioral drift detection in a single browser extension.

## 3.2 Technical Architecture

### Backend (FastAPI + Python)

The backend (`backend/app/main.py`, 448 lines) exposes four endpoint groups:

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Server status, configured model, LLM availability |
| `POST /session/init` | Generate 4-6 seed research questions from a clarified goal |
| `POST /analyze` | Analyze page content (HTML or PDF text) against the research goal |
| `POST /api/clarify-goal/{start,next,refine}` | Multi-turn goal clarification conversation |

The goal clarification module (`backend/app/goal_clarifier.py`, 358 lines) uses prompt templates and response parsing to drive a structured conversation. When the LLM is unavailable, a heuristic fallback generates questions from a curated question bank covering topic scope, focus area, timeframe, and research purpose.

All request and response models are defined with Pydantic for strict type validation. The backend uses a `{ ok, data, error }` response shape for consistent error handling.

### Extension (Chrome Manifest V3)

The extension is organized into clearly separated modules:

**Entry points:**
- `background.js` (1,241 lines) -- service worker orchestrating session lifecycle, analysis routing, drift ticks, and PDF capture
- `content.js` (395 lines) -- content script for page text extraction, insight toasts, drift toasts, and activity heartbeats
- `sidebar.js` (2,772 lines) -- side panel UI with five tabs: Overview, Insights, Questions, Sources, Settings
- `popup.js` (50 lines) -- minimal launcher showing session status and opening the side panel

**Algorithm modules (pure functions, no side effects):**
- `relevanceScorer.js` -- keyword overlap + domain priors + distraction penalties
- `driftDetector.js` -- multi-signal drift evaluation (temporal, behavioral, categorical)
- `insightGrouping.js` -- Jaccard-based lexical clustering with explainable group titles
- `notificationManager.js` -- notification policy with cooldown logic

**Infrastructure modules:**
- `sessionStore.js` (534 lines) -- Chrome storage persistence with schema migration
- `contracts/messages.js` -- runtime message validation for internal messaging
- `background/sessionUtils.js` -- extracted data-merge utilities for testability
- `pdf/pdfDetection.js`, `pdf/pdfTextExtractor.js` -- PDF URL detection and text extraction

## 3.3 Key Features

### Goal Clarification
The user enters a rough goal (e.g., "understand poverty in Japan"). The backend asks 3-5 targeted questions with multiple-choice options, collects answers, and synthesizes a clarified goal with specific research questions. This clarified goal drives all downstream analysis. Drafts are persisted locally so users can resume the clarification flow.

### Page Analysis
When the user visits a page during an active session, the content script extracts the page text (from `<article>`, `<main>`, or `<body>`) and sends it to the background worker, which routes it to the backend `/analyze` endpoint. The backend returns 1-3 structured insights, each with a topic label, summary, evidence quote, and relevance assessment. It also identifies which research questions the page does *not* address (missing topics).

### Insight Organization
The side panel offers two views: a **timeline view** showing insights in reverse chronological order, and a **grouped view** that clusters related insights by topic using Jaccard similarity over lexical and source features. Group titles are automatically generated from shared keywords, with filtering for generic labels.

### Drift Detection
A periodic alarm tick in the background worker evaluates browsing context against drift thresholds. The detector considers five signals: user inactivity (idle state + time since last activity), current page relevance, dwell time on unrelated pages, distraction domain penalties, and recent browsing history patterns. It returns a status (`focused`, `slipping`, `drifting`, `inactive`), a numeric score, and human-readable reasons. Notifications are dispatched through both Chrome notifications and in-page toasts, with cooldown logic to prevent spam.

### Session Management
Sessions are stored in `chrome.storage.local` with three states: active, paused, and saved. Users can create, pause, resume, and delete sessions. A session switcher allows reopening past research. Each session tracks the goal, research questions, insights, sources, missing topics, and chat history.

### PDF Support
The extension detects PDF URLs through multiple strategies (URL patterns, MIME types, query parameters in embedded viewers) and extracts text content for backend analysis.

## 3.4 Testing and Quality

| Suite | Framework | Tests | Coverage Focus |
|-------|-----------|-------|----------------|
| Backend | pytest | 18 | API contracts, heuristic behavior, response parsing, goal clarification |
| Extension | Vitest | 22 | Relevance scoring, drift detection, insight grouping, PDF detection, message contracts, session utilities |
| Benchmark | Custom script | 6 fixtures | Compares prefix-term vs. majority-term coverage strategies with precision/recall/F1 |

All 40 tests pass. The benchmark script (`backend/app/relevance_benchmark.py`) provides reproducible evidence for heuristic strategy selection.

---

# Part 4: Process Documentation

## 4.1 Overview

Research Copilot was built over five weeks (March 11 -- April 17, 2026) through 29 commits and 7 pull requests. The development followed a clear arc:

1. **Core functionality** (Mar 11-16): Basic extension scaffolding, backend integration, goal clarification flow
2. **UX feature sprint** (Apr 6): Insight save button, topic clustering, session management, popup removal -- four PRs in a single day
3. **Engineering quality** (Apr 10-17): Module extraction, runtime contracts, automated tests, PDF support, documentation, docstrings

This arc -- from working prototype to evidence-backed engineering quality -- was the most important structural decision of the project.

## 4.2 Modeling Professional Process

This project followed practices common in professional software development:

- **Feature branches and pull requests**: All 7 PRs followed a branch-per-feature workflow. Each PR delivered a coherent, user-visible capability increment rather than mixing unrelated changes.
- **Iterative delivery**: The product was usable after the first commit. Each subsequent PR added value without breaking existing functionality.
- **Test-before-refactor discipline**: The April 10 "claude initial commit" added automated tests and module extraction *together*, ensuring that structural changes were protected by regression tests.
- **Documentation as engineering artifact**: `ALGORITHM_RATIONALE.md` and `ARCHITECTURE_DECISIONS.md` are not afterthoughts; they record trade-offs and reasoning that would otherwise be lost. This mirrors the practice of Architecture Decision Records (ADRs) used in professional teams.
- **API contracts**: Pydantic models on the backend and runtime message validation on the extension enforce interface boundaries. This prevents the silent-failure bugs that plague loosely-typed systems.
- **Graceful degradation**: The heuristic fallback path ensures the extension remains functional when the LLM backend is unavailable. This is a production-readiness concern that most prototypes skip.

## 4.3 Use of Generative AI

### 4.3.1 Tools Used

I used three AI tools during development:
- **GitHub Copilot**: Code completion and codebase navigation during development in VS Code
- **ChatGPT (GPT-4)**: Architectural brainstorming and drafting detailed implementation prompts
- **OpenAI Codex**: Executing multi-file code changes from detailed prompts

### 4.3.2 Case Study: The Insight Notification Refactor

This is the AI interaction I am most proud of, because it demonstrates a type of engineering work I value: taking an unclear product instinct and turning it into a concrete, technically scoped change request that an agent can execute reliably.

**Context.** The original behavior was: when the system generated an insight, it (1) showed an on-page toast notification and (2) automatically added the insight to the sidebar. I wanted to change this so the user could choose whether to save each insight. The risk was that the extension had multiple UI surfaces -- an on-page toast, a popup triggered by clicking the extension icon, and the side panel -- and a coding agent could easily modify the wrong files.

**Step 1: Identifying file ownership with GitHub Copilot.** Before drafting any prompt, I used Copilot to ask which file handled which UI component:

> *"Which file is responsible for the notification thingy -- the one which pops up when you visit the new page and is in a small window with 'Research Copilot' on the top, the summary of the content, and 'topic:' in the bottom?"*

Copilot correctly identified `content.js` as the file rendering the on-page toast (lines 66-68 at the time). I then asked about `popup.js` and `popup.html` and confirmed they only handled the toolbar popup, not the on-page notification.

This was the most important step. Without it, any implementation prompt would have been ambiguous about which UI surface to modify.

**Step 2: Crafting a detailed implementation prompt with ChatGPT.** I described the desired behavior change to ChatGPT in natural language:

> *"Right now, the product automatically gets insights to make a pop-up and then automatically adds them to the sidebar. But I want the user to be able to select whether they will add or not."*

ChatGPT's initial prompt was reasonable but did not distinguish between the toast and the popup. I provided clarification:

> *"For clarification, the file responsible for the notification is content.js and popup.js and popup.html is responsible for the thing that appears when I click on the extension icon (we don't want to change that now)."*

ChatGPT then produced a refined prompt that included:
- **Important clarification**: "Do NOT modify `popup.js` or `popup.html`"
- **Files to inspect**: `content.js`, `background.js`, `sessionStore.js`, `sidebar.js`, `styles.css`
- **Architecture preference**: Separate "show insight notification" from "save insight to sidebar"
- **Strict requirements**: Dismissing or timing out must NOT save; only explicit click saves; prevent duplicate saves
- **Acceptance criteria**: 11 specific conditions for completeness
- **Output format**: Current flow explanation, files changed, code changes, new flow explanation, manual test steps

I reviewed and lightly edited this prompt to match my codebase's exact file names and patterns.

**Step 3: Execution with OpenAI Codex.** I fed the final prompt to Codex. It correctly identified the auto-save location in `background.js` (the `handlePageContent()` function), removed the automatic persistence, and added:
- A new `SAVE_ANALYSIS_INSIGHTS` message type in `background.js`
- Toast UI buttons ("Add to sidebar", "Dismiss", "X") in `content.js`
- Confirmation feedback after save
- Double-click prevention via UI state
- `popup.js` and `popup.html` were left untouched

I reviewed the diff, adjusted toast dismiss timing, and merged.

**Key reflection.** The highest-value skill was not writing code with AI, but translating a vague UX request into a precise implementation prompt that respected the existing architecture. The prompt included file boundaries, behavioral constraints, architectural preferences, and testable acceptance criteria. Without these, Codex would have produced working but architecturally inconsistent code -- likely modifying `popup.js` instead of `content.js`, or auto-saving on toast dismiss.

### 4.3.3 Other AI Use Throughout the Project

- **Backend prompt templates**: I used ChatGPT to iterate on the OpenAI system/user prompts for goal clarification and page analysis (visible in `goal_clarifier.py` prompt builder functions). I tested multiple prompt variations and selected the ones that produced the most structured, parseable responses.
- **Heuristic design**: I consulted ChatGPT on relevance scoring signal weights and distraction category penalties, then validated the suggestions using the benchmark script.
- **Documentation**: I used AI to draft initial versions of docstrings in `main.py` and `goal_clarifier.py`, then edited for accuracy and consistency with the actual code behavior.
- **Test scaffolding**: Some test case structures were generated with Copilot, then I adjusted assertions to match the actual module behavior.

### 4.3.4 Reflection on AI Use

- **What AI was good at**: Boilerplate generation, exploring design options quickly, producing multi-file diffs when given precise instructions, drafting documentation.
- **What AI was bad at**: Understanding the existing architecture without guidance, making UX judgment calls, choosing appropriate thresholds for heuristic algorithms.
- **Overall pattern**: I operated as the architect and quality gate; AI operated as a fast executor. The coding session case study demonstrates that the quality of AI output depends almost entirely on the quality of the human-authored prompt.

## 4.4 Strategies for #navigation

### Decomposition
I decomposed the project into two independent technology stacks early: a Python backend (FastAPI, OpenAI SDK) and a JavaScript extension (Chrome Manifest V3 APIs). This allowed me to develop and test each stack independently before integrating them.

### Working end-to-end before polish
The first commit delivered a basic but functional end-to-end flow: the extension captured page text, sent it to the backend, received analysis results, and displayed them. Every subsequent PR added capability on top of a working system, rather than building components in isolation.

### Feature-to-quality phase shift
The most important navigation decision was shifting from feature development to engineering quality after April 6. By that point, the product had all its core features (goal clarification, page analysis, insight grouping, drift detection, session management). I recognized that adding more features would not improve the product as much as tests, contracts, and documentation would. The April 10-17 phase focused entirely on quality: module extraction, runtime contracts, 40 automated tests, PDF support, architecture decisions, algorithm rationale, and docstrings.

### Scope management
I explicitly deferred features that did not serve the core research workflow: cross-device sync, export/sharing, inline insight editing, citation extraction, and user-configurable drift sensitivity. These are documented in the README as "Good next steps" rather than pretending they do not exist. Deferring them allowed me to invest that time in testing and documentation instead.

## 4.5 HC/LO Reflection

The HCs I applied most naturally were `#algorithms` and `#breakitdown` -- designing the heuristic algorithms and decomposing the system into testable modules felt like the core engineering work of the project. The HC I found most challenging to apply deliberately was `#selfawareness`, because it requires honest assessment of weaknesses in work you are proud of. Writing the "Current limitations" section of the README and acknowledging the 2,772-line `sidebar.js` as a technical debt item required stepping back from the builder's perspective and adopting the critic's perspective.

Among the LOs, `#outcomeanalysis` pushed me to go beyond "it works" and toward "here is measurable evidence that it works well." The benchmark script is small (6 fixture cases), but building it forced me to think rigorously about what "correct" means for a heuristic system. `#curation` was unexpectedly important: deciding what to include in the architecture decision records and what to leave out required judgment about which decisions would matter to a future reader.

---

## 4.6 HC Descriptions

### HC 1: #algorithms
*Apply algorithmic thinking strategies to solve problems and effectively implement working code.*

I designed and implemented three heuristic algorithms, each operating under browser-extension constraints (low latency, no network dependency, deterministic output):

- **Relevance scoring** (`relevanceScorer.js`): Tokenizes goal text and page metadata, computes keyword overlap as a base score, applies domain-prior boosts (`.edu`, `.gov`, research sites) and distraction penalties (social media, shopping, video), and handles manual relevance overrides. The scoring pipeline uses `clip01()` normalization to keep scores in a consistent 0-1 range for downstream label assignment.

- **Drift detection** (`driftDetector.js`): Evaluates five signals -- user inactivity, current page relevance, dwell time on unrelated pages, distraction domain presence, and consecutive off-topic browsing history. Returns a status (`focused`/`slipping`/`drifting`/`inactive`), a numeric score, and an array of human-readable reasons. The algorithm uses early returns for the inactive state to avoid unnecessary computation.

- **Insight clustering** (`insightGrouping.js`): Computes Jaccard similarity over tokenized topic labels, keywords, and source URLs with configurable weights. Seeds clusters with the highest-richness items first, then assigns remaining items to their best-matching cluster or creates new clusters when similarity falls below a threshold. Generates human-readable group titles from shared tokens.

Each algorithm was chosen for speed (O(n) or O(n*k) where k is small), determinism, and explainability -- properties documented in `docs/ALGORITHM_RATIONALE.md`.

### HC 2: #breakitdown
*Organize problems into tractable components and design solutions.*

I decomposed the full-stack system into independently testable modules, each with a single responsibility:

- The background service worker (`background.js`) orchestrates but delegates: scoring to `relevanceScorer.js`, drift evaluation to `driftDetector.js`, notification policy to `notificationManager.js`, session persistence to `sessionStore.js`, and data-merge logic to `background/sessionUtils.js`.
- The backend separates endpoint routing (`main.py`) from prompt construction and response parsing (`goal_clarifier.py`).
- The extension test suite mirrors this decomposition: each of the 6 test files targets exactly one module.

This decomposition was not just organizational -- it was necessary. A Chrome service worker can be suspended at any time by the browser. Mixing persistence logic with analysis routing in a single function would create race conditions when the worker restarts. Separating concerns into pure-function modules made each piece testable in isolation and reduced the blast radius of changes. The rationale is documented in `docs/ARCHITECTURE_DECISIONS.md`, Decision 1 ("Background utility extraction").

### HC 3: #designthinking
*Apply design research processes and iterative design thinking to conceive and refine products or solutions.*

The product evolved through multiple design iterations, each responding to a concrete usability problem:

1. **Popup to side panel** (PR #6): The initial design used a popup for session setup, but the popup was too small for research monitoring and disappeared when the user clicked elsewhere. I migrated the primary workspace to a persistent side panel.
2. **Auto-save to explicit save** (PR #3 + coding session): Automatically adding every insight to the sidebar was disorienting -- users could not distinguish important insights from noise. The refactored design shows a toast with "Add to sidebar" and "Dismiss" buttons, giving users control.
3. **Flat list to topic clusters** (PR #4): As sessions grew, the flat insight list became unusable. I added a grouped view that clusters insights by topic, with automatically generated group titles.
4. **Goal clarification flow** (PR #2): Early testing showed users entered vague goals ("learn about poverty") that produced low-quality analysis. The multi-turn clarification flow refines goals into specific, answerable research questions.

Each iteration was driven by observing how the product felt during actual use, not by following a fixed specification.

### HC 4: #gapanalysis
*Identify and evaluate whether there are suitable existing solutions to a problem or whether a creative new solution is required.*

Before building Research Copilot, I surveyed existing tools:

| Tool | What it does | What it lacks |
|------|-------------|---------------|
| Zotero | Reference management, PDF annotation | No browsing integration, no drift detection |
| Notion Web Clipper | Saves pages to a database | No research structure, no analysis |
| Google Keep | Quick notes from browser | No goal tracking, no source management |
| Hypothes.is | Web annotation | No session management, no synthesis |

The gap I identified was that no tool combined **goal-driven session management** (clarify a research goal, track questions), **automatic page analysis** (extract insights without manual effort), and **behavioral drift detection** (alert when browsing drifts off-topic) in a single browser extension. Each existing tool addresses at most one of these three needs. Research Copilot targets the intersection.

The "Current limitations" and "Good next steps" sections of the README document features I chose *not* to build, demonstrating awareness of where the gap has been filled and where it remains.

### HC 5: #heuristics
*Identify when to use heuristics and when to avoid them.*

I made a deliberate, documented decision to use heuristic algorithms rather than embedding-based or LLM-based approaches for three real-time operations: relevance scoring, drift detection, and insight clustering. The trade-offs are recorded in `docs/ALGORITHM_RATIONALE.md`:

- **Why heuristics were right**: The extension service worker needs sub-millisecond scoring. The system must work when the LLM backend is unavailable. Users need to understand *why* they received a drift notification, so reasons must be human-readable. Heuristics satisfy all three requirements; embedding-based scoring satisfies none.
- **Why heuristics have limits**: Lexical overlap cannot detect semantic relevance when wording differs from the goal. A page about "income inequality in Tokyo" would score low against a goal about "poverty in Japan" despite being highly relevant.
- **Evidence-based validation**: I built a benchmark (`backend/app/relevance_benchmark.py`) comparing two heuristic coverage strategies -- `prefix_terms` (matches if any of the first 3 informative terms appear) and `majority_terms` (matches if at least 50% of terms appear) -- on 6 fixture cases with precision, recall, and F1 metrics. This provides reproducible evidence for the strategy selection.

The decision to use heuristics was not a shortcut; it was an informed trade-off backed by documented rationale and quantitative benchmarking.

### HC 6: #optimization
*Evaluate and apply optimization techniques appropriately.*

I applied targeted optimizations throughout the system, each motivated by a specific performance concern:

- **Heartbeat throttling** (`content.js`): Activity heartbeats are throttled to one per 25 seconds. Without throttling, every mouse move or keypress would send a message to the background worker, creating unnecessary IPC overhead.
- **Early returns** (`relevanceScorer.js`): Manual relevance overrides bypass the entire scoring pipeline. If a user marks a page as relevant, there is no reason to compute keyword overlap and domain priors.
- **Inactive short-circuit** (`driftDetector.js`): The detector returns immediately for inactive states without evaluating behavioral signals, because an inactive user cannot be drifting.
- **Richness-ordered clustering** (`insightGrouping.js`): Insights are sorted by a richness score (keyword count + evidence presence) before clustering, so that clusters are seeded with the most informative items, producing better group titles.
- **Notification cooldown** (`notificationManager.js`): An 8-minute base cooldown with a 1.75x multiplier for repeated notification types prevents notification spam while still surfacing sustained drift.
- **Content truncation** (`backend/app/main.py`): Page content is truncated to 12,000 characters before sending to the LLM, bounding API cost and latency.

Each optimization addresses a measured or observable performance concern rather than optimizing speculatively.

### HC 7: #professionalism
*Follow established guidelines to present yourself and your work products professionally.*

I maintained professional engineering standards throughout the project:

- **README** (244 lines): Includes project overview, setup instructions for both backend and extension, usage guide, feature descriptions, current limitations, and recommended next steps. A new contributor could onboard from the README alone.
- **Architecture Decision Records** (`docs/ARCHITECTURE_DECISIONS.md`): Documents four key structural decisions (background utility extraction, runtime message contracts, automated test scaffolding, modularity strategy) with context, decision, and rationale for each.
- **Algorithm Rationale** (`docs/ALGORITHM_RATIONALE.md`): Explains why heuristic approaches were chosen for each algorithm, the signals used, the key trade-offs, and future improvement paths.
- **Docstrings**: All backend functions in `main.py` and `goal_clarifier.py` have descriptive docstrings defining input/output expectations and fallback behavior.
- **Error handling**: The backend uses a consistent `{ ok, data, error }` response shape. The extension validates messages at runtime boundaries via `contracts/messages.js`.

### HC 8: #selfawareness
*Identify and monitor your strengths and weaknesses; mitigate behaviors and habits that impair effective performance.*

I identified three specific weaknesses in the project and documented them honestly:

1. **`sidebar.js` at 2,772 lines is too large.** It contains UI rendering, event handling, and tab management logic for all five tabs. The next refactor should extract each tab into its own module. I recognized this as the highest-priority technical debt item.
2. **Heuristic scoring cannot detect semantic relevance when wording differs.** A page about "income inequality in Tokyo" would score low against a goal about "poverty in Japan." This is a fundamental limitation of lexical overlap that can only be addressed by adding embedding-based scoring.
3. **No cross-device sync or export.** The local-first storage design is a strength for privacy and offline use, but a weakness for users who research across multiple devices.

Each weakness has a documented path forward in the README and algorithm rationale. Acknowledging these limitations honestly -- rather than hiding them -- demonstrates readiness for the iterative improvement that professional software development requires.

### HC 9: #organization
*Effectively organize communications.*

This submission document demonstrates deliberate organizational choices:

- The **Executive Summary** provides a one-page overview accessible to a general audience.
- The **Academic Abstract** condenses the technical contribution into 250 words for an academic audience.
- The **Work Product** section progresses from problem to architecture to features to testing.
- The **Process Documentation** follows the Capstone Handbook's recommended structure with clear subsection headings.

Within the codebase, organization is equally deliberate. The extension separates entry points (`background.js`, `content.js`, `sidebar.js`) from pure algorithm modules (`relevanceScorer.js`, `driftDetector.js`, `insightGrouping.js`) from infrastructure (`sessionStore.js`, `contracts/messages.js`). The backend separates routing (`main.py`) from prompt logic (`goal_clarifier.py`). The `docs/` directory separates rationale documents from the submission document.

### HC 10: #audience
*Tailor oral and written work by considering the situation and perspective of the people receiving it.*

This submission contains two documents about the same project, tailored for different audiences:

- The **Executive Summary** is written for a general audience (a friend or family member). It uses no technical jargon, explains the problem in everyday terms ("students lose focus during web research"), and describes the solution through its user-facing behavior. The architecture diagram uses labeled boxes and arrows rather than code or API specifications.
- The **Academic Abstract** is written for a technical audience (a professor in computer science). It uses domain-specific terminology (Manifest V3, Jaccard similarity, precision/recall/F1, deterministic heuristic fallback) and focuses on the technical contribution rather than the user experience.

The README also demonstrates audience awareness: it is written for a developer who wants to set up, run, and contribute to the project. It includes terminal commands, file paths, and technical prerequisites.

---

## 4.7 LO Descriptions

### LO 1: #qualitydeliverables
*Submit work products with the scope, depth, and rigor appropriate to the setting or stage of project.*

The work product is a complete, functioning Chrome extension with a FastAPI backend. It is not a mockup or a design document; it is installable software that captures page text, analyzes it against a research goal, clusters insights, detects drift, and persists sessions across browser restarts.

Quality is demonstrated through multiple layers:
- **Functionality**: All advertised features work end-to-end.
- **Testing**: 40 automated tests across two frameworks (pytest, Vitest) covering API contracts, heuristic behavior, algorithm correctness, and message validation.
- **Documentation**: A comprehensive README, two rationale documents, and descriptive docstrings.
- **Evidence**: A benchmark script with fixture cases providing reproducible metrics for heuristic strategy comparison.

The shift from "feature complete" to "evidence-backed" in the final development phase -- adding tests, contracts, benchmarks, and documentation -- represents the most significant quality improvement of the project. Without these artifacts, the product would be a working prototype. With them, it is a defensible engineering contribution.

### LO 2: #navigation
*Work strategically to meet commitments and accomplish the aims of a project by relevant deadlines.*

The development progressed through three phases over five weeks:

1. **Core functionality (Mar 11-16)**: Basic extension, backend integration, goal clarification. This established the end-to-end flow.
2. **Feature sprint (Apr 6)**: Four PRs in a single day delivered insight save button, topic clustering, session management, and popup removal. This was the most productive day of the project, made possible by the stable foundation from Phase 1.
3. **Quality engineering (Apr 10-17)**: Module extraction, tests, contracts, PDF support, documentation. This phase transformed the prototype into a maintainable system.

The most important navigation decision was recognizing when to stop adding features. After April 6, I had more feature ideas (citation extraction, export workflows, semantic scoring) but chose to invest in quality instead. The deferred features are explicitly listed in the README rather than silently dropped.

I also managed risk through feature branches: each of the 7 PRs was developed on a separate branch, tested independently, and merged only when complete. This prevented half-finished features from destabilizing the main branch.

### LO 3: #outcomeanalysis
*Identify and utilize appropriate measures and rubrics to develop and evaluate work products.*

I evaluated the project's quality through three types of measurement:

1. **Automated tests** (40 total): These are binary pass/fail measures that verify specific behaviors. For example, `test_driftDetector.test.js` verifies that an inactive user is correctly classified as "inactive" and that 3+ consecutive off-topic pages trigger drift status. Tests do not measure overall product quality, but they prevent regression.

2. **Benchmark metrics**: The coverage benchmark (`relevance_benchmark.py`) compares two heuristic strategies on 6 fixture cases using precision, recall, and F1. This goes beyond "does it work?" to "how well does it work, and how do alternatives compare?" The benchmark is small (6 cases), but it demonstrates the discipline of quantitative evaluation and provides a framework for expansion.

3. **Architecture rationale**: The algorithm rationale document evaluates design decisions against three criteria: speed, explainability, and offline capability. This qualitative evaluation complements the quantitative benchmark by explaining *why* certain trade-offs were made.

The benchmark corpus is admittedly small. A production system would need a larger, more diverse test corpus and A/B testing with real users. Acknowledging this limitation is itself part of outcome analysis.

### LO 4: #curation
*Select, organize, and present essential content for an intended purpose.*

Curation is about selective emphasis. I applied it in three key artifacts:

- **Architecture Decision Records** (`ARCHITECTURE_DECISIONS.md`): This document records four decisions, not every decision. I selected the four most consequential structural choices: extracting background utilities, adding message contracts, building test scaffolding, and establishing modularity principles. Less consequential decisions (e.g., choosing `chrome.storage.local` over `chrome.storage.sync`) were omitted to keep the document focused and useful.

- **Algorithm Rationale** (`ALGORITHM_RATIONALE.md`): For each algorithm, I curated the explanation to three elements: why this approach, signals used, and key trade-off. This structure forces conciseness and ensures every paragraph serves a purpose.

- **README**: The README curates onboarding information for developers. It includes setup instructions, feature descriptions, limitations, and next steps -- but does not include implementation details, which belong in the code and its comments. This selective boundary keeps the README useful for its intended purpose.

The process of writing this mini capstone submission was itself an exercise in curation: selecting which aspects of a 10,000+ line codebase to present, and organizing them so a reader can understand the project's scope, quality, and thought process.

### LO 5: #cs162-testing
*Write comprehensive and meaningful testing code for the system.*

I built a test suite spanning both stacks:

**Backend (pytest, 18 tests):**
- `test_api_contracts.py`: Validates that every endpoint accepts the expected request shape and returns the expected response shape. These tests catch breaking changes to the API contract.
- `test_main_heuristics.py`: Tests the heuristic fallback path: question generation from goals, keyword overlap for missing topics, content truncation behavior, evidence source preference.
- `test_goal_clarifier.py`: Tests response parsing (including code-fence stripping), prompt building for each clarification stage, heuristic fallback question selection, and question bank exhaustion.

**Extension (Vitest, 22 tests):**
- `relevanceScorer.test.js`: Manual override bypasses heuristics, research domain boost, distraction penalty offset by keyword overlap.
- `driftDetector.test.js`: No active session returns focused, inactivity detection, consecutive off-topic tracking, distraction patterns.
- `insightGrouping.test.js`: API exposure, empty input handling, lexical/source-based grouping.
- `pdfDetection.test.js`: URL pattern matching for various PDF URL formats.
- `backgroundSessionUtils.test.js`: Data merge utilities.
- `messagesContract.test.js`: Runtime message validation.

Tests were added *before* the module extraction refactor (April 10), ensuring that structural changes were protected by regression coverage. This test-before-refactor discipline is documented in `ARCHITECTURE_DECISIONS.md`, Decision 3.

### LO 6: #cs110-AlgoStratDataStruct
*Explain and apply the underlying principles of algorithmic techniques and data structures.*

I applied algorithmic strategies appropriate for browser-extension constraints:

- **Sets** for fast membership testing and deduplication: `relevanceScorer.js` converts goal tokens to a Set for O(1) lookup during keyword overlap computation. `insightGrouping.js` uses Sets for Jaccard similarity (intersection and union operations).
- **Maps** for frequency counting: Keyword frequency maps in the clustering module track term importance across insight groups.
- **Jaccard similarity** for set-based cluster matching: The `jaccard()` function in `insightGrouping.js` computes |A intersection B| / |A union B| over tokenized feature sets. This is a well-understood similarity metric with known properties (symmetric, bounded [0,1], handles empty sets gracefully).
- **Threshold-based state machines** for drift detection: The drift detector transitions between four states (focused, slipping, drifting, inactive) based on score thresholds derived from weighted signal combinations. The early return for inactive state is a form of short-circuit evaluation.
- **Linear-time algorithms**: All three heuristic modules operate in O(n) or O(n*k) time where k is a small constant (number of clusters, number of distraction categories). This is necessary because the algorithms run in a browser service worker that shares resources with the page.

---

## 4.8 Timeline

| Date | Phase | Milestone | Commits/PRs |
|------|-------|-----------|-------------|
| Mar 11 | Core | Initial commit: extension scaffolding + backend | `fb6b9dc` |
| Mar 15 | Core | UI polish, popup timing, insight highlighting, source tracking | PR #1 (`802f38b`) |
| Mar 16 | Core | Goal clarification flow | PR #2 (`0908ed8`) |
| Apr 6 (AM) | Features | Insight save button with toast UI | PR #3 (`e3053d4`) |
| Apr 6 (midday) | Features | Topic clustering for insight organization | PR #4 (`c0326c7`) |
| Apr 6 (PM) | Features | Session persistence and past session management | PR #5 (`f93c69e`) |
| Apr 6 (PM) | Features | Remove popup, consolidate to side panel | PR #6 (`f7e27d4`) |
| Apr 10 | Quality | Module extraction, runtime contracts, automated tests | `0379563` |
| Apr 16 | Quality | PDF reader support | PR #7 (`8334507`) |
| Apr 17 | Quality | Docstrings, comments, documentation polish | `550030d` |

---

## Appendix A: Test Verification Commands

```bash
# Backend tests (18 passing)
cd backend && pytest -q tests

# Extension tests (22 passing)
cd .. && npm test -- --run

# Coverage benchmark
cd backend && python app/relevance_benchmark.py
```

## Appendix B: Repository Statistics

- **Total source files**: ~35 files
- **Total lines of code**: ~10,800 (excluding dependencies)
- **Commits**: 29
- **Pull requests**: 7
- **Automated tests**: 40 (18 backend + 22 extension)
- **Documentation files**: 3 (`README.md`, `ALGORITHM_RATIONALE.md`, `ARCHITECTURE_DECISIONS.md`)
