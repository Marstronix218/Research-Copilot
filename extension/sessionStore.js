export const DEFAULT_DRIFT_SETTINGS = {
  enabled: true,
  inactivityThresholdMs: 10 * 60 * 1000,
  unrelatedSoftThresholdMs: 4 * 60 * 1000,
  unrelatedNotifyThresholdMs: 6 * 60 * 1000,
  distractionNotifyThresholdMs: 5 * 60 * 1000,
  notificationCooldownMs: 8 * 60 * 1000,
  maxRecentHistoryItems: 50,
  debug: true,
};

// TODO: Add user-configurable drift sensitivity controls in popup settings.
// TODO: Persist per-user domain allowlist/denylist overrides.

export function createDefaultBrowsingState(now = Date.now()) {
  return {
    currentTabId: null,
    currentUrl: null,
    currentDomain: null,
    currentTitle: null,
    currentSnippet: '',
    currentTabStartedAt: null,
    lastUserActivityAt: now,
    recentHistory: [],
  };
}

export function createDefaultDriftState(now = Date.now()) {
  return {
    status: 'focused',
    score: 0,
    reasons: [],
    lastUpdatedAt: now,
    lastNotificationAt: null,
    lastNotificationType: null,
  };
}

export function createActiveSession({ goal, questions = [], createdAt }) {
  const startedAt = createdAt ? new Date(createdAt).getTime() : Date.now();
  return {
    id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    goal,
    keywords: extractKeywords(goal, questions),
    researchQuestions: questions,
    startedAt,
    isActive: true,
  };
}

export function extractKeywords(goal, researchQuestions = []) {
  const text = [goal, ...(researchQuestions || [])].join(' ').toLowerCase();
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'what',
    'when', 'where', 'which', 'while', 'how', 'why', 'who', 'are', 'is', 'was',
    'were', 'will', 'can', 'could', 'should', 'would', 'your', 'their', 'our',
  ]);
  const uniq = [];
  for (const token of text.split(/[^a-z0-9]+/g)) {
    if (token.length < 3 || stop.has(token)) continue;
    if (!uniq.includes(token)) uniq.push(token);
    if (uniq.length >= 24) break;
  }
  return uniq;
}

export function normalizePageKey(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '') || '/';
    return `${u.hostname}${path}`.toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

export async function ensureDriftStateInitialized() {
  const now = Date.now();
  const existing = await chrome.storage.local.get([
    'driftSettings',
    'browsingState',
    'driftState',
    'manualRelevanceOverrides',
    'activeSession',
  ]);

  const updates = {};
  if (!existing.driftSettings) updates.driftSettings = { ...DEFAULT_DRIFT_SETTINGS };
  if (!existing.browsingState) updates.browsingState = createDefaultBrowsingState(now);
  if (!existing.driftState) updates.driftState = createDefaultDriftState(now);
  if (!existing.manualRelevanceOverrides) updates.manualRelevanceOverrides = {};
  if (!existing.activeSession) updates.activeSession = null;

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

export async function getDriftBundle() {
  const now = Date.now();
  const stored = await chrome.storage.local.get([
    'driftSettings',
    'browsingState',
    'driftState',
    'manualRelevanceOverrides',
    'activeSession',
  ]);

  return {
    driftSettings: { ...DEFAULT_DRIFT_SETTINGS, ...(stored.driftSettings || {}) },
    browsingState: stored.browsingState || createDefaultBrowsingState(now),
    driftState: stored.driftState || createDefaultDriftState(now),
    manualRelevanceOverrides: stored.manualRelevanceOverrides || {},
    activeSession: stored.activeSession || null,
  };
}

export async function setBrowsingState(browsingState) {
  await chrome.storage.local.set({ browsingState });
}

export async function setDriftState(driftState) {
  await chrome.storage.local.set({ driftState });
}

export async function setActiveSession(activeSession) {
  await chrome.storage.local.set({ activeSession });
}

export async function resetDriftForSessionEnd() {
  await chrome.storage.local.set({
    activeSession: null,
    browsingState: createDefaultBrowsingState(Date.now()),
    driftState: createDefaultDriftState(Date.now()),
  });
}

export async function addManualOverride(sessionId, url) {
  if (!sessionId || !url) return;
  const pageKey = normalizePageKey(url);
  const stored = await chrome.storage.local.get(['manualRelevanceOverrides']);
  const map = stored.manualRelevanceOverrides || {};
  map[sessionId] = map[sessionId] || {};
  map[sessionId][pageKey] = true;
  await chrome.storage.local.set({ manualRelevanceOverrides: map });
}

export function hasManualOverride({ manualRelevanceOverrides, sessionId, url }) {
  if (!sessionId || !url) return false;
  const pageKey = normalizePageKey(url);
  return Boolean(manualRelevanceOverrides?.[sessionId]?.[pageKey]);
}
