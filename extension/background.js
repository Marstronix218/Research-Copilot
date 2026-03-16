const DEFAULT_SETTINGS = {
  backendUrl: 'http://localhost:8000',
  autoAnalyze: true,
  maxContentLength: 12000,
  uiFontSize: 14
};

function createEmptySession() {
  return {
    goal: '',
    questions: [],
    insights: [],
    sources: [],
    missingTopics: [],
    paused: false,
    pausedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['settings', 'session']);
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  if (!existing.session) {
    await chrome.storage.local.set({ session: createEmptySession() });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'START_SESSION': {
        const result = await startSession(message.payload);
        sendResponse({ ok: true, data: result });
        break;
      }
      case 'GET_SESSION': {
        const data = await chrome.storage.local.get(['session', 'settings']);
        sendResponse({ ok: true, data });
        break;
      }
      case 'CLEAR_SESSION': {
        const emptySession = createEmptySession();
        await chrome.storage.local.set({ session: emptySession });
        sendResponse({ ok: true, data: emptySession });
        break;
      }
      case 'TOGGLE_SESSION_PAUSE': {
        const updated = await toggleSessionPause(message.payload?.paused);
        sendResponse({ ok: true, data: updated });
        break;
      }
      case 'PAGE_CONTENT': {
        const result = await handlePageContent(message.payload, sender);
        sendResponse({ ok: true, data: result });
        break;
      }
      case 'SAVE_SETTINGS': {
        const current = await chrome.storage.local.get(['settings']);
        const settings = { ...(current.settings || DEFAULT_SETTINGS), ...message.payload };
        await chrome.storage.local.set({ settings });
        await broadcastSettingsUpdate(settings);
        sendResponse({ ok: true, data: settings });
        break;
      }
      case 'PING_BACKEND': {
        const healthy = await pingBackend();
        sendResponse({ ok: true, data: healthy });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })().catch((error) => {
    console.error(error);
    sendResponse({ ok: false, error: error.message || 'Unexpected error' });
  });

  return true;
});

async function getSettings() {
  const stored = await chrome.storage.local.get(['settings']);
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function getSession() {
  const stored = await chrome.storage.local.get(['session']);
  return stored.session;
}

async function setSession(session) {
  session.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ session });
  await broadcastSessionUpdate(session);
  return session;
}

async function startSession(payload) {
  const settings = await getSettings();
  const response = await fetch(`${settings.backendUrl}/session/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Failed to initialize session: ${response.status}`);
  }

  const data = await response.json();
  const session = {
    goal: data.goal,
    questions: data.questions || [],
    insights: [],
    sources: [],
    missingTopics: data.questions || [],
    paused: false,
    pausedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await setSession(session);
  return session;
}

async function handlePageContent(payload, sender) {
  const settings = await getSettings();
  const session = await getSession();

  if (!settings.autoAnalyze) {
    return { skipped: true, reason: 'Auto analysis disabled' };
  }

  if (!session?.goal) {
    return { skipped: true, reason: 'No active research session' };
  }

  if (session.paused) {
    return { skipped: true, reason: 'Research session is paused' };
  }

  if (!payload?.content || payload.content.trim().length < 200) {
    return { skipped: true, reason: 'Insufficient page content' };
  }

  const response = await fetch(`${settings.backendUrl}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: session.goal,
      questions: session.questions,
      page: {
        ...payload,
        content: payload.content.slice(0, settings.maxContentLength)
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Analysis failed: ${response.status}`);
  }

  const analysis = await response.json();
  const source = {
    url: payload.url,
    title: payload.title,
    domain: safeDomain(payload.url),
    analyzedAt: new Date().toISOString()
  };

  const updatedInsights = mergeInsights(session.insights, analysis.insights || [], source);
  const updated = {
    ...session,
    insights: updatedInsights,
    sources: mergeSources(session.sources, source),
    missingTopics: analysis.missing_topics || session.missingTopics
  };

  await setSession(updated);

  const activeTabId = sender?.tab?.id;
  if (activeTabId && analysis.page_summary) {
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: 'PAGE_ANALYSIS_RESULT',
        payload: analysis
      });
    } catch (err) {
      // Ignore if content script is unavailable.
    }
  }

  return analysis;
}

async function toggleSessionPause(paused) {
  const session = await getSession();
  if (!session?.goal) {
    return session;
  }

  const shouldPause = typeof paused === 'boolean' ? paused : !Boolean(session.paused);
  const updated = {
    ...session,
    paused: shouldPause,
    pausedAt: shouldPause ? new Date().toISOString() : null
  };

  await setSession(updated);
  return updated;
}

function insightKey(item) {
  return `${item.topic || ''}::${item.summary || ''}`;
}

function mergeInsights(existing, incoming, source) {
  const normalized = [...existing];
  for (const item of incoming) {
    const key = insightKey(item);
    const index = normalized.findIndex((x) => insightKey(x) === key);
    if (index === -1) {
      normalized.push({
        ...item,
        addedAt: new Date().toISOString(),
        sources: [source]
      });
    } else {
      const existingSources = Array.isArray(normalized[index].sources) ? normalized[index].sources : [];
      const alreadyLinked = existingSources.some((x) => x.url === source.url);
      if (!alreadyLinked) {
        normalized[index] = {
          ...normalized[index],
          sources: [...existingSources, source]
        };
      }
    }
  }
  return normalized;
}

function mergeSources(existing, source) {
  const found = existing.find((x) => x.url === source.url);
  if (found) {
    return existing.map((x) => (x.url === source.url ? { ...x, ...source } : x));
  }
  return [source, ...existing];
}

function safeDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function broadcastSessionUpdate(session) {
  const views = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL', 'POPUP'] });
  for (const view of views) {
    try {
      chrome.runtime.sendMessage({ type: 'SESSION_UPDATED', payload: session, targetContextId: view.contextId });
    } catch {
      // no-op
    }
  }
}

async function broadcastSettingsUpdate(settings) {
  const views = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL', 'POPUP'] });
  for (const view of views) {
    try {
      chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', payload: settings, targetContextId: view.contextId });
    } catch {
      // no-op
    }
  }
}

async function pingBackend() {
  const settings = await getSettings();
  try {
    const response = await fetch(`${settings.backendUrl}/health`);
    if (!response.ok) {
      return { healthy: false, status: response.status };
    }
    return await response.json();
  } catch (error) {
    return { healthy: false, error: error.message };
  }
}
