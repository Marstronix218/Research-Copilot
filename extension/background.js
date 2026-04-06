import { evaluateDrift } from './driftDetector.js';
import { notifyDrift, shouldSendNotification } from './notificationManager.js';
import { scorePageRelevance } from './relevanceScorer.js';
import {
  addManualOverride,
  createActiveSession,
  createDefaultBrowsingState,
  createDefaultDriftState,
  DEFAULT_DRIFT_SETTINGS,
  ensureDriftStateInitialized,
  getDriftBundle,
  hasManualOverride,
  resetDriftForSessionEnd,
  setActiveSession,
  setBrowsingState,
  setDriftState,
} from './sessionStore.js';

const DEFAULT_SETTINGS = {
  backendUrl: 'http://localhost:8000',
  autoAnalyze: true,
  maxContentLength: 12000,
  uiFontSize: 14,
};

const DRIFT_ALARM_NAME = 'drift-tick';
let currentIdleState = 'active';

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
    updatedAt: new Date().toISOString(),
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
  await ensureDriftStateInitialized();
  await ensureDriftAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDriftStateInitialized();
  await ensureDriftAlarm();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.tabs.onActivated.addListener(async () => {
  await syncActiveTabState('tabs.onActivated');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab?.active) return;
  await syncActiveTabState('tabs.onUpdated');
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  await syncActiveTabState('windows.onFocusChanged');
});

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener(async (state) => {
  currentIdleState = state;
  await runDriftTick('idle-state-change');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== DRIFT_ALARM_NAME) return;
  await runDriftTick('alarm');
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
        await resetDriftForSessionEnd();
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
      case 'SAVE_ANALYSIS_INSIGHTS': {
        const result = await saveAnalysisInsights(message.payload, sender);
        if (result && result.saved === false) {
          sendResponse({
            ok: false,
            error: result.reason || 'Failed to save analysis insights',
            data: result,
          });
        } else {
          sendResponse({ ok: true, data: result });
        }
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
      case 'USER_ACTIVITY_HEARTBEAT': {
        const result = await handleUserActivityHeartbeat(message.payload, sender);
        sendResponse({ ok: true, data: result });
        break;
      }
      case 'MARK_PAGE_RELEVANT': {
        const result = await handleMarkPageRelevant(message.payload, sender);
        sendResponse({ ok: true, data: result });
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

async function ensureDriftAlarm() {
  const alarm = await chrome.alarms.get(DRIFT_ALARM_NAME);
  if (!alarm) {
    chrome.alarms.create(DRIFT_ALARM_NAME, { periodInMinutes: 1 });
  }
}

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

function isSessionActive(session) {
  return Boolean(session?.goal) && !Boolean(session?.paused);
}

function logDrift(enabled, ...args) {
  if (!enabled) return;
  console.log('[drift]', ...args);
}

async function startSession(payload) {
  const settings = await getSettings();
  const response = await fetch(`${settings.backendUrl}/session/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
    updatedAt: new Date().toISOString(),
  };

  await setSession(session);

  const activeSession = createActiveSession({
    goal: session.goal,
    questions: session.questions,
    createdAt: session.createdAt,
  });
  await setActiveSession(activeSession);
  await setBrowsingState(createDefaultBrowsingState(Date.now()));
  await setDriftState(createDefaultDriftState(Date.now()));
  await syncActiveTabState('start-session');

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
        content: payload.content.slice(0, settings.maxContentLength),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Analysis failed: ${response.status}`);
  }

  const analysis = await response.json();
  const source = {
    url: payload.url,
    title: payload.title,
    domain: safeDomain(payload.url),
    analyzedAt: new Date().toISOString(),
  };

  const updated = {
    ...session,
    sources: mergeSources(session.sources, source),
    missingTopics: analysis.missing_topics || session.missingTopics,
  };

  await setSession(updated);

  const activeTabId = sender?.tab?.id;
  if (activeTabId && analysis.page_summary) {
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: 'PAGE_ANALYSIS_RESULT',
        payload: analysis,
      });
    } catch {
      // Ignore if content script is unavailable.
    }
  }

  return analysis;
}

async function saveAnalysisInsights(payload, sender) {
  const session = await getSession();
  if (!session?.goal) {
    throw new Error('No active research session');
  }

  const insights = Array.isArray(payload?.insights) ? payload.insights : [];
  if (!insights.length) {
    throw new Error('No insights to save');
  }

  const sourceUrl = payload?.page?.url || sender?.tab?.url || '';
  const sourceTitle = payload?.page?.title || sender?.tab?.title || '';
  const source = {
    url: sourceUrl,
    title: sourceTitle,
    domain: safeDomain(sourceUrl),
    analyzedAt: new Date().toISOString(),
  };

  const existingInsights = Array.isArray(session.insights) ? session.insights : [];
  const existingSources = Array.isArray(session.sources) ? session.sources : [];
  const updatedInsights = mergeInsights(existingInsights, insights, source);
  const sourceAlreadyTracked = existingSources.some((item) => item.url === source.url);

  if (updatedInsights.length === existingInsights.length && sourceAlreadyTracked) {
    return { saved: true, addedCount: 0, session };
  }

  const updated = {
    ...session,
    insights: updatedInsights,
    sources: mergeSources(existingSources, source),
  };

  await setSession(updated);
  return {
    saved: true,
    addedCount: Math.max(0, updatedInsights.length - existingInsights.length),
    session: updated,
  };
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
    pausedAt: shouldPause ? new Date().toISOString() : null,
  };

  await setSession(updated);

  if (shouldPause) {
    const { activeSession } = await getDriftBundle();
    if (activeSession) {
      await setActiveSession({ ...activeSession, isActive: false });
    }
  } else {
    const newActive = createActiveSession({
      goal: updated.goal,
      questions: updated.questions,
      createdAt: updated.createdAt,
    });
    await setActiveSession(newActive);
    await syncActiveTabState('resume-session');
  }

  return updated;
}

async function handleUserActivityHeartbeat(payload, sender) {
  const { browsingState, activeSession, driftSettings } = await getDriftBundle();
  if (!activeSession?.isActive) {
    return { skipped: true, reason: 'No active drift session' };
  }

  const now = Date.now();
  const tab = sender?.tab;
  const updated = {
    ...browsingState,
    lastUserActivityAt: now,
  };

  if (tab?.id && tab.id === updated.currentTabId) {
    updated.currentUrl = payload?.url || tab.url || updated.currentUrl;
    updated.currentDomain = safeDomain(updated.currentUrl || '');
    updated.currentTitle = payload?.title || tab.title || updated.currentTitle;
    if (payload?.snippet) {
      updated.currentSnippet = String(payload.snippet).slice(0, 1200);
    }
  }

  await setBrowsingState(updated);
  logDrift(driftSettings.debug, 'heartbeat', { tabId: tab?.id, state: currentIdleState });

  return { updatedAt: now };
}

async function handleMarkPageRelevant(payload, sender) {
  const { activeSession, driftSettings } = await getDriftBundle();
  if (!activeSession?.id) {
    return { marked: false, reason: 'No active session id' };
  }

  const url = payload?.url || sender?.tab?.url;
  if (!url) {
    return { marked: false, reason: 'No URL to mark' };
  }

  await addManualOverride(activeSession.id, url);
  logDrift(driftSettings.debug, 'manual override added', { url, sessionId: activeSession.id });
  return { marked: true };
}

async function syncActiveTabState(reason) {
  const session = await getSession();
  if (!isSessionActive(session)) return;

  const { browsingState, driftSettings, activeSession } = await getDriftBundle();
  if (!activeSession?.isActive) return;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !activeTab.url) return;

  const now = Date.now();
  const samePage =
    browsingState.currentTabId === activeTab.id &&
    browsingState.currentUrl === activeTab.url;

  if (samePage) {
    const refreshed = {
      ...browsingState,
      currentTitle: activeTab.title || browsingState.currentTitle,
      currentDomain: safeDomain(activeTab.url),
      lastUserActivityAt: now,
    };
    await setBrowsingState(refreshed);
    return;
  }

  const history = finalizeCurrentHistoryItem(browsingState.recentHistory || [], now);
  history.push({
    tabId: activeTab.id,
    url: activeTab.url,
    domain: safeDomain(activeTab.url),
    title: activeTab.title || '',
    startedAt: now,
    endedAt: null,
    dwellMs: 0,
    relevanceScore: 0,
    relevanceLabel: 'unknown',
    isDistraction: false,
    distractionCategory: null,
  });

  const maxItems = driftSettings.maxRecentHistoryItems || DEFAULT_DRIFT_SETTINGS.maxRecentHistoryItems;
  const trimmed = history.slice(-maxItems);

  const updated = {
    ...browsingState,
    currentTabId: activeTab.id,
    currentUrl: activeTab.url,
    currentDomain: safeDomain(activeTab.url),
    currentTitle: activeTab.title || '',
    currentSnippet: '',
    currentTabStartedAt: now,
    lastUserActivityAt: now,
    recentHistory: trimmed,
  };

  await setBrowsingState(updated);
  logDrift(driftSettings.debug, 'tab synced', { reason, url: activeTab.url, domain: updated.currentDomain });
}

function finalizeCurrentHistoryItem(history, now) {
  if (!history.length) return history;
  const clone = [...history];
  const index = clone.findLastIndex((x) => x.endedAt == null);
  if (index === -1) return clone;

  const item = clone[index];
  const startedAt = item.startedAt || now;
  clone[index] = {
    ...item,
    endedAt: now,
    dwellMs: Math.max(0, now - startedAt),
  };
  return clone;
}

async function runDriftTick(trigger) {
  // TODO: Add lightweight session analytics counters for drift events over time.
  const session = await getSession();
  if (!isSessionActive(session)) return;

  const bundle = await getDriftBundle();
  const { driftSettings } = bundle;
  if (!driftSettings.enabled) return;

  let activeSession = bundle.activeSession;
  if (!activeSession?.isActive) {
    activeSession = createActiveSession({
      goal: session.goal,
      questions: session.questions,
      createdAt: session.createdAt,
    });
    await setActiveSession(activeSession);
  }

  await syncActiveTabState(`tick:${trigger}`);

  const refreshed = await getDriftBundle();
  const browsingState = refreshed.browsingState;
  const driftState = refreshed.driftState;
  const manualRelevanceOverrides = refreshed.manualRelevanceOverrides;
  const now = Date.now();

  if (!browsingState.currentUrl) {
    logDrift(driftSettings.debug, 'tick skipped: no current url');
    return;
  }

  const manualOverride = hasManualOverride({
    manualRelevanceOverrides,
    sessionId: activeSession.id,
    url: browsingState.currentUrl,
  });

  const relevance = scorePageRelevance({
    goal: activeSession.goal,
    keywords: activeSession.keywords,
    researchQuestions: activeSession.researchQuestions,
    url: browsingState.currentUrl,
    domain: browsingState.currentDomain,
    title: browsingState.currentTitle,
    snippet: browsingState.currentSnippet,
    manualOverride,
  });

  const updatedHistory = [...(browsingState.recentHistory || [])];
  const activeIndex = updatedHistory.findLastIndex((x) => x.endedAt == null);
  if (activeIndex >= 0) {
    const startedAt = updatedHistory[activeIndex].startedAt || now;
    updatedHistory[activeIndex] = {
      ...updatedHistory[activeIndex],
      title: browsingState.currentTitle || updatedHistory[activeIndex].title,
      domain: browsingState.currentDomain || updatedHistory[activeIndex].domain,
      dwellMs: Math.max(0, now - startedAt),
      relevanceScore: relevance.score,
      relevanceLabel: relevance.label,
      isDistraction: relevance.isDistraction,
      distractionCategory: relevance.distractionCategory,
    };
  }

  const newBrowsingState = {
    ...browsingState,
    recentHistory: updatedHistory,
    currentRelevanceScore: relevance.score,
    currentRelevanceLabel: relevance.label,
    currentDistractionCategory: relevance.distractionCategory,
  };

  const evaluation = evaluateDrift({
    activeSession,
    browsingState: newBrowsingState,
    idleState: currentIdleState,
    driftSettings,
    now,
    currentPage: {
      url: newBrowsingState.currentUrl,
      relevanceScore: relevance.score,
      relevanceLabel: relevance.label,
      isDistraction: relevance.isDistraction,
      distractionCategory: relevance.distractionCategory,
    },
  });

  const canNotify = shouldSendNotification({
    driftState,
    evaluation,
    driftSettings,
    now,
  });

  const nextDriftState = {
    status: evaluation.status,
    score: evaluation.score,
    reasons: evaluation.reasons,
    lastUpdatedAt: now,
    lastNotificationAt: driftState.lastNotificationAt || null,
    lastNotificationType: driftState.lastNotificationType || null,
  };

  if (canNotify) {
    await notifyDrift({
      evaluation,
      goal: activeSession.goal,
      currentTabId: newBrowsingState.currentTabId,
    });
    nextDriftState.lastNotificationAt = now;
    nextDriftState.lastNotificationType = evaluation.notificationType;
  }

  await setBrowsingState(newBrowsingState);
  await setDriftState(nextDriftState);

  logDrift(driftSettings.debug, 'tick', {
    trigger,
    idle: currentIdleState,
    score: relevance.score,
    label: relevance.label,
    status: evaluation.status,
    reasons: evaluation.reasons,
    notify: canNotify,
  });
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
        sources: [source],
      });
    } else {
      const existingSources = Array.isArray(normalized[index].sources) ? normalized[index].sources : [];
      const alreadyLinked = existingSources.some((x) => x.url === source.url);
      if (!alreadyLinked) {
        normalized[index] = {
          ...normalized[index],
          sources: [...existingSources, source],
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
