// Background service worker orchestrator.
//
// Responsibilities:
// - session lifecycle and persistence,
// - HTML/PDF capture and backend analysis,
// - drift scoring and notification dispatch,
// - extension-to-UI messaging.

import { evaluateDrift } from './driftDetector.js';
import { notifyDrift, shouldSendNotification } from './notificationManager.js';
import {
  contentTypeSuggestsPdf,
  resolvePdfResourceUrl,
  shouldProbePdfContentType,
  tabCouldBePdf,
  urlClearlyIndicatesPdf,
} from './pdf/pdfDetection.js';
import { extractPdfText } from './pdf/pdfTextExtractor.js';
import { scorePageRelevance } from './relevanceScorer.js';
import {
  addManualOverride,
  createActiveSession,
  createDefaultBrowsingState,
  createDefaultDriftState,
  createSession,
  DEFAULT_DRIFT_SETTINGS,
  ensureDriftStateInitialized,
  ensureSessionStoreInitialized,
  getAllSessions,
  getDriftBundle,
  getCurrentSession,
  getCurrentSessionId,
  getSession,
  hasManualOverride,
  saveSession,
  resetDriftForSessionEnd,
  deleteSession as deleteStoredSession,
  setCurrentSession,
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
const PDF_STATUS_LOADING_MESSAGE = 'Reading PDF...';
const PDF_STATUS_GENERIC_ERROR = 'Could not process this PDF right now.';
const LOCAL_FILE_ACCESS_ERROR =
  "Local PDF access is blocked. Enable 'Allow access to file URLs' for this extension.";
let currentIdleState = 'active';
const pdfCaptureKeysInFlight = new Set();
const lastAutoCapturedPdfKeysByTab = new Map();

// Startup wiring keeps storage and alarms ready regardless of browser lifecycle path.
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['settings']);
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  await ensureSessionStoreInitialized();
  await ensureDriftStateInitialized();
  await ensureDriftAlarm();
  await configureSidePanelAction();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSessionStoreInitialized();
  await ensureDriftStateInitialized();
  await ensureDriftAlarm();
  await configureSidePanelAction();
});

if (!chrome.sidePanel?.setPanelBehavior) {
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  });
}

chrome.tabs.onActivated.addListener(async () => {
  await syncActiveTabState('tabs.onActivated');
  await maybeAutoCaptureCurrentPdfTab('tabs.onActivated');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    lastAutoCapturedPdfKeysByTab.delete(tabId);
  }

  if (changeInfo.status !== 'complete') return;
  if (!tab?.active) return;
  await syncActiveTabState('tabs.onUpdated');
  await maybeAutoCapturePdfTab(tab, 'tabs.onUpdated');
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastAutoCapturedPdfKeysByTab.delete(tabId);
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

// Central message router for popup/sidebar/content-script requests.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'START_SESSION': {
        const result = await startSession(message.payload);
        sendResponse({ ok: true, data: result });
        break;
      }
      case 'GET_SESSION': {
        const data = await buildSessionStatePayload();
        sendResponse({ ok: true, data });
        break;
      }
      case 'CLEAR_SESSION': {
        const sessionId = message.payload?.sessionId || await getCurrentSessionId();
        const deleted = await deleteSessionAndSync(sessionId);
        sendResponse({ ok: true, data: deleted });
        break;
      }
      case 'OPEN_SESSION': {
        const opened = await openSession(message.payload?.sessionId);
        sendResponse({ ok: true, data: opened });
        break;
      }
      case 'DELETE_SESSION': {
        const deleted = await deleteSessionAndSync(message.payload?.sessionId);
        sendResponse({ ok: true, data: deleted });
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
      case 'UPDATE_SESSION_GOAL': {
        const updated = await updateSessionGoal(
          message.payload?.sessionId,
          message.payload?.goal,
        );
        sendResponse({ ok: true, data: updated });
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
  // One-minute cadence keeps drift state fresh without frequent wakeups.
  const alarm = await chrome.alarms.get(DRIFT_ALARM_NAME);
  if (!alarm) {
    chrome.alarms.create(DRIFT_ALARM_NAME, { periodInMinutes: 1 });
  }
}

async function configureSidePanelAction() {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('Failed to enable sidepanel action behavior', error);
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(['settings']);
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function buildSessionStatePayload() {
  // Bundle state in one response so sidebar can render atomically.
  const [settings, session, currentSessionId, allSessions] = await Promise.all([
    getSettings(),
    getCurrentSession(),
    getCurrentSessionId(),
    getAllSessions(),
  ]);

  return {
    settings,
    session,
    currentSessionId,
    allSessions,
  };
}

async function commitSessionUpdate(session) {
  const saved = await saveSession(session);
  await broadcastSessionUpdate();
  return saved;
}

async function archiveCurrentSession({ excludeSessionId = null } = {}) {
  const currentSession = await getCurrentSession();
  if (!currentSession?.id || currentSession.id === excludeSessionId) {
    return currentSession;
  }

  if (currentSession.status === 'paused') {
    return currentSession;
  }

  return commitSessionUpdate({
    ...currentSession,
    status: 'saved',
    paused: false,
    pausedAt: null,
  });
}

async function syncDriftToCurrentSession(reason, { resetTracking = false } = {}) {
  const session = await getCurrentSession();
  if (!isSessionActive(session)) {
    await resetDriftForSessionEnd();
    return session;
  }

  await setActiveSession(createActiveSession({
    id: session.id,
    goal: session.goal,
    researchQuestions: session.researchQuestions,
    createdAt: session.createdAt,
  }));

  if (resetTracking) {
    await setBrowsingState(createDefaultBrowsingState(Date.now()));
    await setDriftState(createDefaultDriftState(Date.now()));
  }

  await syncActiveTabState(reason);
  await maybeAutoCaptureCurrentPdfTab(reason);
  return session;
}

async function openSession(sessionId) {
  if (!sessionId) {
    return null;
  }

  const targetSession = await getSession(sessionId);
  if (!targetSession) {
    return null;
  }

  const currentSessionId = await getCurrentSessionId();
  if (currentSessionId !== sessionId) {
    await archiveCurrentSession({ excludeSessionId: sessionId });
    await setCurrentSession(sessionId);
  }

  let updatedSession = targetSession;
  if (targetSession.status !== 'active' || targetSession.paused) {
    updatedSession = await commitSessionUpdate({
      ...targetSession,
      status: 'active',
      paused: false,
      pausedAt: null,
    });
    await setCurrentSession(updatedSession.id);
  } else {
    await broadcastSessionUpdate();
  }

  await syncDriftToCurrentSession('open-session', { resetTracking: currentSessionId !== sessionId });
  return updatedSession;
}

async function deleteSessionAndSync(sessionId) {
  if (!sessionId) {
    return null;
  }

  const previousCurrentSessionId = await getCurrentSessionId();
  const deletedSession = await deleteStoredSession(sessionId);
  if (!deletedSession) {
    return null;
  }

  if (previousCurrentSessionId === sessionId) {
    await syncDriftToCurrentSession('delete-session', { resetTracking: true });
  }
  await broadcastSessionUpdate();
  return deletedSession;
}

function isSessionActive(session) {
  return Boolean(session?.goal) && session?.status === 'active' && !Boolean(session?.paused);
}

function logDrift(enabled, ...args) {
  if (!enabled) return;
  console.log('[drift]', ...args);
}

async function startSession(payload) {
  // Create backend-generated seed questions, then persist a fresh active session.
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
  await archiveCurrentSession();

  const session = await createSession({
    title: data.goal,
    goal: data.goal,
    researchQuestions: data.questions || [],
    insights: [],
    sources: [],
    missingTopics: data.questions || [],
    status: 'active',
  });

  await broadcastSessionUpdate();
  await syncDriftToCurrentSession('start-session', { resetTracking: true });

  return session;
}

function getEffectiveTabUrl(tab) {
  return resolvePdfResourceUrl(tab) || tab?.url || '';
}

function normalizeHtmlDocument(payload, senderTab) {
  const extractedAt = payload?.metadata?.extractedAt || payload?.timestamp || new Date().toISOString();

  return {
    sourceType: 'html',
    url: payload?.url || senderTab?.url || '',
    title: payload?.title || senderTab?.title || '',
    content: String(payload?.content || '').trim(),
    selection: payload?.selection || '',
    metadata: {
      extractedAt,
      extractionMethod: payload?.metadata?.extractionMethod || 'content-script-innerText',
    },
  };
}

function buildTrackedSource(document, analyzedAt = new Date().toISOString()) {
  const metadata = document?.metadata && typeof document.metadata === 'object'
    ? document.metadata
    : {};

  return {
    url: document?.url || '',
    title: document?.title || '',
    domain: safeDomain(document?.url || ''),
    sourceType: document?.sourceType || 'html',
    pageCount: Number.isFinite(metadata.pageCount) ? metadata.pageCount : undefined,
    extractionMethod: metadata.extractionMethod || '',
    extractedAt: metadata.extractedAt || analyzedAt,
    analyzedAt,
  };
}

function mergeAnalysisIntoSession(session, analysis, source, { persistInsights = false } = {}) {
  const existingSources = Array.isArray(session?.sources) ? session.sources : [];
  const existingInsights = Array.isArray(session?.insights) ? session.insights : [];
  const nextInsights = persistInsights
    ? mergeInsights(existingInsights, analysis?.insights || [], source)
    : existingInsights;

  return {
    ...session,
    sources: mergeSources(existingSources, source),
    insights: nextInsights,
    topics: persistInsights ? collectTopicsFromInsights(nextInsights) : session.topics,
    missingTopics: Array.isArray(analysis?.missing_topics)
      ? analysis.missing_topics
      : session.missingTopics,
  };
}

function mergeInsightsIntoSession(session, insights, source) {
  const existingInsights = Array.isArray(session?.insights) ? session.insights : [];
  const existingSources = Array.isArray(session?.sources) ? session.sources : [];
  const updatedInsights = mergeInsights(existingInsights, insights, source);

  return {
    updatedSession: {
      ...session,
      insights: updatedInsights,
      topics: collectTopicsFromInsights(updatedInsights),
      sources: mergeSources(existingSources, source),
    },
    addedCount: Math.max(0, updatedInsights.length - existingInsights.length),
    sourceAlreadyTracked: existingSources.some((item) => item.url === source.url),
    updatedInsights,
  };
}

async function analyzeExtractedDocument(document, { activeTabId = null, persistInsights = false } = {}) {
  // Shared analysis path for both HTML and PDF captures.
  const settings = await getSettings();
  const session = await getCurrentSession();
  const minimumContentLength = document?.sourceType === 'pdf' ? 80 : 200;

  if (!settings.autoAnalyze) {
    return { skipped: true, reason: 'Auto analysis disabled' };
  }

  if (!session?.goal) {
    return { skipped: true, reason: 'No active research session' };
  }

  if (!isSessionActive(session)) {
    return {
      skipped: true,
      reason: session.status === 'paused'
        ? 'Research session is paused'
        : 'Research session is not active',
    };
  }

  if (!document?.content || document.content.trim().length < minimumContentLength) {
    return { skipped: true, reason: 'Insufficient page content' };
  }

  const response = await fetch(`${settings.backendUrl}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: session.goal,
      questions: session.researchQuestions,
      page: {
        ...document,
        content: document.content.slice(0, settings.maxContentLength),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Analysis failed: ${response.status}`);
  }

  const analysis = await response.json();
  const source = buildTrackedSource(document);
  const updatedSession = mergeAnalysisIntoSession(session, analysis, source, { persistInsights });
  await commitSessionUpdate(updatedSession);

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

function deriveTitleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const lastSegment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    if (lastSegment) {
      return lastSegment;
    }
    return parsed.hostname || 'Untitled PDF';
  } catch {
    return 'Untitled PDF';
  }
}

function buildPdfTitle(tab, url) {
  const tabTitle = String(tab?.title || '').trim();
  if (tabTitle && !/^chrome pdf viewer$/i.test(tabTitle)) {
    return tabTitle;
  }

  return deriveTitleFromUrl(url);
}

function buildPdfError(code, message, details = '', metadata = {}) {
  return {
    code,
    message,
    details,
    metadata,
  };
}

async function probePdfContentType(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) {
      return '';
    }
    return response.headers.get('content-type') || '';
  } catch {
    return '';
  }
}

async function detectPdfTab(tab) {
  // Use cheap URL/title heuristics first, then optional HEAD content-type probe.
  const hint = tabCouldBePdf(tab);
  if (hint.isPdfHint) {
    return {
      isPdf: true,
      url: hint.resolvedUrl,
      detectionReason: hint.reasons.join(','),
    };
  }

  if (!shouldProbePdfContentType(tab, hint.resolvedUrl)) {
    return {
      isPdf: false,
      url: hint.resolvedUrl,
      detectionReason: '',
    };
  }

  const contentType = await probePdfContentType(hint.resolvedUrl);
  if (contentTypeSuggestsPdf(contentType)) {
    return {
      isPdf: true,
      url: hint.resolvedUrl,
      detectionReason: 'content-type',
    };
  }

  return {
    isPdf: false,
    url: hint.resolvedUrl,
    detectionReason: '',
  };
}

async function isAllowedFileSchemeAccess() {
  if (!chrome.extension?.isAllowedFileSchemeAccess) {
    return false;
  }

  return new Promise((resolve) => {
    chrome.extension.isAllowedFileSchemeAccess((isAllowed) => {
      resolve(Boolean(isAllowed));
    });
  });
}

async function fetchPdfBytes(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return {
        ok: false,
        error: buildPdfError('PDF_FETCH_FAILED', 'Could not read this PDF.', `HTTP ${response.status}`),
      };
    }

    const contentType = response.headers.get('content-type') || '';
    const finalUrl = response.url || url;
    if (!contentTypeSuggestsPdf(contentType) && !urlClearlyIndicatesPdf(finalUrl)) {
      return {
        ok: false,
        error: buildPdfError('PDF_NOT_DETECTED', 'Could not read this PDF.', 'Response was not application/pdf.'),
      };
    }

    return {
      ok: true,
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType,
      finalUrl,
    };
  } catch (error) {
    return {
      ok: false,
      error: buildPdfError('PDF_FETCH_FAILED', 'Could not read this PDF.', error?.message || ''),
    };
  }
}

// PDF.js runs directly in the service worker here because text extraction only needs raw bytes.
// That keeps PDFs on the same capture path as HTML without depending on Chrome's viewer DOM.
async function extractPdfDocumentFromTab(tab, pdfDetection) {
  const targetUrl = pdfDetection?.url || getEffectiveTabUrl(tab);
  if (!targetUrl) {
    return {
      ok: false,
      error: buildPdfError('PDF_URL_MISSING', 'Could not read this PDF.'),
    };
  }

  if (targetUrl.startsWith('blob:')) {
    return {
      ok: false,
      error: buildPdfError('PDF_BLOB_UNSUPPORTED', 'Could not read this PDF.'),
    };
  }

  if (targetUrl.startsWith('file:')) {
    const allowed = await isAllowedFileSchemeAccess();
    if (!allowed) {
      return {
        ok: false,
        error: buildPdfError('LOCAL_FILE_ACCESS_BLOCKED', LOCAL_FILE_ACCESS_ERROR),
      };
    }
  }

  const fetched = await fetchPdfBytes(targetUrl);
  if (!fetched.ok) {
    return fetched;
  }

  const parsed = await extractPdfText(fetched.bytes);
  if (!parsed.ok) {
    return {
      ok: false,
      error: buildPdfError(
        parsed.error?.code || 'PDF_PARSE_FAILED',
        parsed.error?.message || 'Could not read this PDF.',
        parsed.error?.details || '',
        parsed.metadata || {},
      ),
    };
  }

  return {
    ok: true,
    document: {
      sourceType: 'pdf',
      url: fetched.finalUrl,
      title: buildPdfTitle(tab, fetched.finalUrl),
      content: parsed.content,
      metadata: {
        pageCount: parsed.metadata?.pageCount,
        extractedAt: new Date().toISOString(),
        extractionMethod: 'pdfjs-service-worker',
        contentType: fetched.contentType || undefined,
        detectionReason: pdfDetection?.detectionReason || undefined,
      },
    },
  };
}

async function extractCurrentTabContent({ htmlPayload, senderTab, tab, pdfDetection } = {}) {
  if (htmlPayload) {
    return {
      ok: true,
      document: normalizeHtmlDocument(htmlPayload, senderTab),
    };
  }

  const detection = pdfDetection || await detectPdfTab(tab);
  if (!detection.isPdf) {
    return {
      ok: false,
      skipped: true,
      reason: 'Not a PDF tab',
    };
  }

  return extractPdfDocumentFromTab(tab, detection);
}

async function broadcastCaptureStatus(payload) {
  try {
    await chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS', payload });
  } catch {
    // Ignore when no extension page is listening.
  }
}

async function maybeAutoCaptureCurrentPdfTab(reason) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return null;
  }

  return maybeAutoCapturePdfTab(tab, reason);
}

async function maybeAutoCapturePdfTab(tab, reason) {
  // Deduplicate by session+goal+url so refreshes do not re-analyze the same PDF.
  const settings = await getSettings();
  const session = await getCurrentSession();
  if (!settings.autoAnalyze || !isSessionActive(session) || !tab?.id) {
    return { skipped: true, reason: 'No active auto-analysis session' };
  }

  const pdfDetection = await detectPdfTab(tab);
  if (!pdfDetection.isPdf) {
    return { skipped: true, reason: 'Not a PDF tab' };
  }

  const captureKey = `${session.id}::${session.goal}::${pdfDetection.url}`;
  if (
    pdfCaptureKeysInFlight.has(captureKey)
    || lastAutoCapturedPdfKeysByTab.get(tab.id) === captureKey
  ) {
    return { skipped: true, reason: 'PDF already captured' };
  }

  pdfCaptureKeysInFlight.add(captureKey);
  await broadcastCaptureStatus({
    state: 'loading',
    sourceType: 'pdf',
    message: PDF_STATUS_LOADING_MESSAGE,
    url: pdfDetection.url,
  });

  try {
    const extracted = await extractCurrentTabContent({ tab, pdfDetection });
    if (!extracted.ok) {
      if (extracted.error?.message) {
        await broadcastCaptureStatus({
          state: extracted.error.code === 'PDF_TEXT_UNAVAILABLE' ? 'warning' : 'error',
          sourceType: 'pdf',
          message: extracted.error.message,
          url: pdfDetection.url,
        });
      } else {
        await broadcastCaptureStatus({
          state: 'idle',
          sourceType: 'pdf',
          url: pdfDetection.url,
        });
      }
      return extracted;
    }

    const analysis = await analyzeExtractedDocument(extracted.document, {
      activeTabId: tab.id,
      persistInsights: true,
    });

    if (analysis?.skipped) {
      await broadcastCaptureStatus({
        state: 'error',
        sourceType: 'pdf',
        message: analysis.reason || 'Could not read this PDF.',
        url: extracted.document.url,
      });
      return analysis;
    }

    lastAutoCapturedPdfKeysByTab.set(tab.id, captureKey);
    await broadcastCaptureStatus({
      state: 'idle',
      sourceType: 'pdf',
      url: extracted.document.url,
    });
    return analysis;
  } catch (error) {
    console.error(`PDF capture failed during ${reason}`, error);
    await broadcastCaptureStatus({
      state: 'error',
      sourceType: 'pdf',
      message: PDF_STATUS_GENERIC_ERROR,
      url: pdfDetection.url,
    });
    return {
      ok: false,
      error: buildPdfError('PDF_CAPTURE_FAILED', PDF_STATUS_GENERIC_ERROR, error?.message || ''),
    };
  } finally {
    pdfCaptureKeysInFlight.delete(captureKey);
  }
}

async function handlePageContent(payload, sender) {
  const extracted = await extractCurrentTabContent({
    htmlPayload: payload,
    senderTab: sender?.tab,
  });

  if (!extracted.ok) {
    return extracted;
  }

  return analyzeExtractedDocument(extracted.document, {
    activeTabId: sender?.tab?.id || null,
    persistInsights: false,
  });
}

async function saveAnalysisInsights(payload, sender) {
  const session = await getCurrentSession();
  if (!session?.goal) {
    throw new Error('No current research session');
  }

  const insights = Array.isArray(payload?.insights) ? payload.insights : [];
  if (!insights.length) {
    throw new Error('No insights to save');
  }

  const sourceUrl = payload?.page?.url || sender?.tab?.url || '';
  const sourceTitle = payload?.page?.title || sender?.tab?.title || '';
  const source = buildTrackedSource({
    sourceType: payload?.page?.sourceType || 'html',
    url: sourceUrl,
    title: sourceTitle,
    metadata: payload?.page?.metadata || {},
  });

  const merged = mergeInsightsIntoSession(session, insights, source);
  if (merged.addedCount === 0 && merged.sourceAlreadyTracked) {
    return { saved: true, addedCount: 0, session };
  }

  const savedSession = await commitSessionUpdate(merged.updatedSession);
  return {
    saved: true,
    addedCount: merged.addedCount,
    session: savedSession,
  };
}

async function toggleSessionPause(paused) {
  const session = await getCurrentSession();
  if (!session?.goal) {
    return session;
  }

  const shouldPause = typeof paused === 'boolean' ? paused : !Boolean(session.paused);
  const updated = await commitSessionUpdate({
    ...session,
    status: shouldPause ? 'paused' : 'active',
    paused: shouldPause,
    pausedAt: shouldPause ? new Date().toISOString() : null,
  });

  if (shouldPause) {
    await resetDriftForSessionEnd();
  } else {
    await syncDriftToCurrentSession('resume-session', { resetTracking: true });
  }

  return updated;
}

async function updateSessionGoal(sessionId, goal) {
  const nextGoal = String(goal || '').trim();
  if (!nextGoal) {
    throw new Error('Research goal cannot be empty');
  }

  const targetId = sessionId || await getCurrentSessionId();
  const session = targetId ? await getSession(targetId) : await getCurrentSession();
  if (!session?.id) {
    throw new Error('Research session not found');
  }

  const updated = await commitSessionUpdate({
    ...session,
    goal: nextGoal,
    title: nextGoal,
  });

  const currentId = await getCurrentSessionId();
  if (updated.id === currentId && isSessionActive(updated)) {
    await syncDriftToCurrentSession('update-session-goal');
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
    updated.currentUrl = payload?.url || getEffectiveTabUrl(tab) || updated.currentUrl;
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

  const url = payload?.url || getEffectiveTabUrl(sender?.tab);
  if (!url) {
    return { marked: false, reason: 'No URL to mark' };
  }

  await addManualOverride(activeSession.id, url);
  logDrift(driftSettings.debug, 'manual override added', { url, sessionId: activeSession.id });
  return { marked: true };
}

async function syncActiveTabState(reason) {
  const session = await getCurrentSession();
  if (!isSessionActive(session)) return;

  const { browsingState, driftSettings, activeSession } = await getDriftBundle();
  if (!activeSession?.isActive) return;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !activeTab.url) return;
  const activeTabUrl = getEffectiveTabUrl(activeTab);

  const now = Date.now();
  const samePage =
    browsingState.currentTabId === activeTab.id &&
    browsingState.currentUrl === activeTabUrl;

  if (samePage) {
    const refreshed = {
      ...browsingState,
      currentTitle: activeTab.title || browsingState.currentTitle,
      currentDomain: safeDomain(activeTabUrl),
      lastUserActivityAt: now,
    };
    await setBrowsingState(refreshed);
    return;
  }

  const history = finalizeCurrentHistoryItem(browsingState.recentHistory || [], now);
  history.push({
    tabId: activeTab.id,
    url: activeTabUrl,
    domain: safeDomain(activeTabUrl),
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
    currentUrl: activeTabUrl,
    currentDomain: safeDomain(activeTabUrl),
    currentTitle: activeTab.title || '',
    currentSnippet: '',
    currentTabStartedAt: now,
    lastUserActivityAt: now,
    recentHistory: trimmed,
  };

  await setBrowsingState(updated);
  logDrift(driftSettings.debug, 'tab synced', { reason, url: activeTabUrl, domain: updated.currentDomain });
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
  // This tick computes relevance, updates browsing history, evaluates drift,
  // and emits at most one notification per cooldown window.
  const session = await getCurrentSession();
  if (!isSessionActive(session)) return;

  const bundle = await getDriftBundle();
  const { driftSettings } = bundle;
  if (!driftSettings.enabled) return;

  let activeSession = bundle.activeSession;
  if (!activeSession?.isActive) {
    activeSession = createActiveSession({
      id: session.id,
      goal: session.goal,
      researchQuestions: session.researchQuestions,
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

function collectTopicsFromInsights(insights) {
  const seen = new Set();
  const topics = [];
  for (const insight of Array.isArray(insights) ? insights : []) {
    const topic = String(insight?.topic || '').trim();
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
  }
  return topics;
}

function mergeInsights(existing, incoming, source) {
  // Merge by topic+summary key and attach additional source provenance.
  const normalized = [...(Array.isArray(existing) ? existing : [])];
  for (const item of Array.isArray(incoming) ? incoming : []) {
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
  const normalized = Array.isArray(existing) ? existing : [];
  const found = normalized.find((x) => x.url === source.url);
  if (found) {
    return normalized.map((x) => (x.url === source.url ? { ...x, ...source } : x));
  }
  return [source, ...normalized];
}

function safeDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function broadcastSessionUpdate() {
  const payload = await buildSessionStatePayload();
  try {
    await chrome.runtime.sendMessage({ type: 'SESSION_UPDATED', payload });
  } catch {
    // Ignore when no extension page is listening.
  }
}

async function broadcastSettingsUpdate(settings) {
  try {
    await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', payload: settings });
  } catch {
    // Ignore when no extension page is listening.
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
