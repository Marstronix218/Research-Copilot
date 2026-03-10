# Research Copilot

Research Copilot is a Chrome extension plus a lightweight AI backend for guided web research.

## What it does

- Starts a research session from a goal like “Understand poverty in Japan”
- Generates research questions for the session
- Watches pages you browse during the session
- Extracts page-level insights relevant to the goal
- Tracks sources and missing topics in a side panel

## Directory structure

```text
research-copilot/
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   ├── popup.js
│   ├── sidebar.html
│   ├── sidebar.js
│   └── styles.css
├── backend/
│   ├── requirements.txt
│   ├── .env.example
│   ├── run.sh
│   └── app/
│       ├── __init__.py
│       └── main.py
└── README.md
```

## Backend setup

1. Create a virtual environment.
2. Install dependencies.
3. Copy `.env.example` to `.env` and add your OpenAI API key.
4. Run the API server.

### Commands

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
./run.sh
```

The backend will run on `http://localhost:8000`.

## Chrome extension setup

1. Open Chrome.
2. Go to `chrome://extensions/`.
3. Enable Developer mode.
4. Click **Load unpacked**.
5. Select the `extension/` folder.

## How to use

1. Start the backend.
2. Open the extension popup.
3. Enter a research goal.
4. Click **Start session**.
5. Browse normally.
6. Open the side panel to inspect questions, insights, missing topics, and sources.

## Notes

- The extension analyzes page text after load.
- If there is no OpenAI key, the backend falls back to heuristics so the app still works in a limited way.
- This is an MVP. It does not yet include per-source note editing, user authentication, embeddings, sync, or multi-session history.

## Good next steps

- Add session history and export
- Add source-quality ranking
- Add citation extraction
- Add “suggest next query” and “compare sources” features
- Add Browser Use style agent mode for active source collection
