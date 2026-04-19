# Research Copilot

Research Copilot is a Chrome extension plus a lightweight FastAPI backend for guided web research. It helps you start a research session from a goal, generate research questions, analyze pages as you browse, organize insights in a side panel, and detect when your browsing starts drifting away from the topic.

## What it does

- Starts a research session from a goal such as `Understand poverty in Japan`
- Generates 4 to 6 research questions for the session
- Supports a `Clarify Goal` flow before starting the session
- Saves multiple sessions in `chrome.storage.local`
- Lets you switch, reopen, pause, resume, and delete sessions
- Auto-analyzes visited pages during an active session
- Extracts goal-relevant insights, tracked sources, and missing topics
- Shows research state in a side panel with `Overview`, `Insights`, `Questions`, and `Sources` tabs
- Groups insights by topic or shows them as a timeline
- Checks backend health and lets you configure the backend URL, font size, and auto-analysis behavior
- Detects off-topic browsing drift and can trigger notifications or in-page prompts
- Falls back to heuristic behavior when no OpenAI API key is configured

## Current UX

The extension currently has two UI surfaces:

- `Popup`
  - Start a session
  - Enter or edit a rough research goal
  - Run the `Clarify Goal` flow
  - Check backend status
  - Update backend URL, font size, and auto-analysis settings
  - Open the side panel
- `Side panel`
  - Switch between sessions
  - Review the active session overview
  - Inspect grouped insights or a timeline
  - Review questions, missing topics, and sources
  - Reopen or delete older sessions

## Project structure

```text
research-copilot/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── goal_clarifier.py
│   │   ├── main.py
│   │   └── relevance_benchmark.py
│   ├── requirements.txt
│   ├── run.sh
│   └── tests/
│       ├── conftest.py
│       ├── test_api_contracts.py
│       ├── test_goal_clarifier.py
│       ├── test_main_heuristics.py
│       └── fixtures/
│           └── relevance_cases.json
├── docs/
│   ├── ALGORITHM_RATIONALE.md
│   └── ARCHITECTURE_DECISIONS.md
├── extension/
│   ├── background/
│   │   └── sessionUtils.js
│   ├── background.js
│   ├── contracts/
│   │   └── messages.js
│   ├── content.js
│   ├── driftDetector.js
│   ├── icons/
│   │   └── icon.png
│   ├── insightGrouping.js
│   ├── manifest.json
│   ├── notificationManager.js
│   ├── popup.html
│   ├── popup.js
│   ├── relevanceScorer.js
│   ├── sessionStore.js
│   ├── sidebar.html
│   ├── sidebar.js
│   ├── tests/
│   │   ├── backgroundSessionUtils.test.js
│   │   ├── driftDetector.test.js
│   │   ├── insightGrouping.test.js
│   │   ├── messagesContract.test.js
│   │   ├── pdfDetection.test.js
│   │   └── relevanceScorer.test.js
│   └── styles.css
├── package.json
├── vitest.config.js
└── README.md
```

## Backend setup

1. Create a virtual environment.
2. Install the backend dependencies.
3. Create a `backend/.env` file if you want OpenAI-backed planning, analysis, and goal clarification.
4. Start the FastAPI server.

### Commands

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
./run.sh
```

### Optional environment variables

Create `backend/.env` with:

```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
```

If `OPENAI_API_KEY` is not set, the backend still runs and falls back to heuristic question generation, page analysis, and goal clarification.

The backend runs on `http://localhost:8000` by default.

## Chrome extension setup

1. Open Chrome.
2. Go to `chrome://extensions/`.
3. Enable Developer mode.
4. Click `Load unpacked`.
5. Select the `extension/` folder.

## Testing

Run backend tests:

```bash
cd /path/to/research-copilot/backend
python -m pytest -q tests
```

Run extension tests:

```bash
cd /path/to/research-copilot
npm test -- --run
```

Run heuristic benchmark (computational critique artifact):

```bash
cd /path/to/research-copilot/backend
python app/relevance_benchmark.py
```

## Engineering rationale docs

- `docs/ALGORITHM_RATIONALE.md`: Heuristic design choices and trade-offs.
- `docs/ARCHITECTURE_DECISIONS.md`: Separation-of-concerns and abstraction decisions.

## How to use

1. Start the backend.
2. Load the extension in Chrome.
3. Click the Research Copilot extension icon to open the popup.
4. Enter a research goal.
5. Optionally click `Clarify Goal` and walk through the clarification flow.
6. Click `Start session`.
7. Click `Open panel` to open the side panel workspace.
8. Browse normally while the extension analyzes relevant pages.
9. Use the side panel to inspect:
   - `Overview` for session summary and controls
   - `Insights` for grouped topics or timeline view
   - `Questions` for tracked research questions and missing topics
   - `Sources` for analyzed pages

## Key behaviors

### Sessions

- Sessions are stored locally in `chrome.storage.local`
- A session can be `active`, `paused`, or `saved`
- Starting a new session archives the current one
- The side panel session switcher lets you reopen past sessions

### Clarify Goal

- The popup supports a multi-step clarification flow
- Clarification drafts are saved locally so the flow can resume
- A confirmed clarified goal replaces the rough goal used to start the session

### Insights and sources

- Page analysis returns 1 to 3 structured insights per page
- Insights can be shown as topic clusters or a newest-first timeline
- Sources are deduplicated and tracked per session
- Missing topics are carried forward to show remaining gaps

### Drift detection

- While a research session is active, the extension tracks the current browsing context
- It scores whether the active page looks related to the research goal
- If browsing appears unrelated or distracting for long enough, it can show notifications and in-page prompts

### Settings

The popup currently exposes:

- Backend URL
- Backend health status
- UI font size
- Auto-analyze pages during research sessions

## Backend API summary

The backend exposes these main endpoints:

- `GET /health`
- `POST /session/init`
- `POST /analyze`
- `POST /api/clarify-goal/start`
- `POST /api/clarify-goal/next`
- `POST /api/clarify-goal/refine`

## Notes

- The extension uses a Chrome side panel for the main research workspace, but session setup and settings still begin in the popup.
- Auto-analysis only runs when a session is active and `Auto-analyze pages during research sessions` is enabled.
- The app is local-first. There is no user auth, remote sync, or cloud session history.
- Session data, settings, and clarification drafts are stored locally in the browser.

## Current limitations

- No cross-device sync
- No export flow yet
- No inline editing for insights or sources
- No citation extraction pipeline yet
- Drift sensitivity is not yet user-configurable in the UI

## Good next steps

- Move session setup and settings fully into the side panel
- Add export and sharing for session outputs
- Add source-quality ranking and citation extraction
- Add suggested follow-up queries and comparison workflows
- Add deeper controls for drift detection sensitivity and notifications
