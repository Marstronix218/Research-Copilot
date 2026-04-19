// Centralized persistence layer for:
// - research sessions,
// - drift-tracking runtime state,
// - manual relevance overrides.
//
// All reads/writes go through chrome.storage.local to keep background and
// sidepanel views synchronized.

// Store sessions as an indexed map plus an explicit order list so export and sync can build on it later.
const SESSION_STORAGE_KEYS = ['currentSessionId', 'sessionOrder', 'sessionsById', 'session'];
const VALID_SESSION_STATUSES = new Set(['active', 'paused', 'saved']);

export const DEFAULT_DRIFT_SETTINGS = {
  enabled: true,
  inactivityThresholdMs: 10 * 60 * 1000,
  unrelatedSoftThresholdMs: 3 * 60 * 1000,
  unrelatedNotifyThresholdMs: 4 * 60 * 1000,
  distractionNotifyThresholdMs: 1 * 60 * 1000,
  notificationCooldownMs: 3 * 60 * 1000,
  maxRecentHistoryItems: 50,
  debug: true,
};

const LEGACY_DEFAULT_DRIFT_SETTINGS = {
  ...DEFAULT_DRIFT_SETTINGS,
  unrelatedSoftThresholdMs: 4 * 60 * 1000,
  unrelatedNotifyThresholdMs: 6 * 60 * 1000,
  distractionNotifyThresholdMs: 5 * 60 * 1000,
};

// TODO: Add user-configurable drift sensitivity controls in popup settings.
// TODO: Persist per-user domain allowlist/denylist overrides.

function normalizeTimestamp(value, fallback) {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return fallback;
}

function generateSessionId(now = Date.now()) {
  return `session-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildSessionTitle(title, goal) {
  const base = String(title || goal || '').trim();
  if (!base) return 'Untitled research session';
  return base.length > 80 ? `${base.slice(0, 77)}...` : base;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function collectSessionTopics(insights, fallbackTopics) {
  const normalizedFallback = normalizeStringList(fallbackTopics);
  if (normalizedFallback.length) {
    return normalizedFallback;
  }

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

function normalizeSessionStatus(status, paused) {
  if (VALID_SESSION_STATUSES.has(status)) {
    return status;
  }
  if (paused) {
    return 'paused';
  }
  return 'active';
}

function normalizeSession(input = {}, nowIso = new Date().toISOString()) {
  const goal = String(input.goal || '').trim();
  const researchQuestions = normalizeStringList(
    Array.isArray(input.researchQuestions) ? input.researchQuestions : input.questions,
  );
  const insights = Array.isArray(input.insights) ? input.insights : [];
  const sources = Array.isArray(input.sources) ? input.sources : [];
  const missingTopics = normalizeStringList(input.missingTopics);
  const groups = Array.isArray(input.groups) ? input.groups : [];
  const chatHistory = Array.isArray(input.chatHistory)
    ? input.chatHistory
    : Array.isArray(input.clarificationChat)
      ? input.clarificationChat
      : [];
  const paused = Boolean(input.paused);
  const status = normalizeSessionStatus(input.status, paused);
  const createdAt = normalizeTimestamp(input.createdAt, nowIso);
  const updatedAt = normalizeTimestamp(input.updatedAt, nowIso);

  return {
    id: String(input.id || generateSessionId()).trim(),
    title: buildSessionTitle(input.title, goal),
    goal,
    createdAt,
    updatedAt,
    status,
    researchQuestions,
    insights,
    topics: collectSessionTopics(insights, input.topics),
    groups,
    sources,
    missingTopics,
    chatHistory,
    paused: status === 'paused',
    pausedAt: status === 'paused'
      ? normalizeTimestamp(input.pausedAt, updatedAt)
      : null,
  };
}

function hasMeaningfulSession(session) {
  if (!session || typeof session !== 'object') return false;
  return Boolean(
    String(session.goal || '').trim()
      || session.questions?.length
      || session.researchQuestions?.length
      || session.insights?.length
      || session.sources?.length,
  );
}

function moveSessionIdToFront(sessionOrder, sessionId) {
  const next = (Array.isArray(sessionOrder) ? sessionOrder : []).filter((id) => id !== sessionId);
  next.unshift(sessionId);
  return next;
}

function normalizeSessionStoreSnapshot(snapshot = {}) {
  // Normalize shape and IDs so legacy data does not break current UI assumptions.
  let changed = false;
  const rawSessions = snapshot.sessionsById && typeof snapshot.sessionsById === 'object'
    ? snapshot.sessionsById
    : {};

  const sessionsById = {};
  for (const [sessionId, sessionValue] of Object.entries(rawSessions)) {
    const normalized = normalizeSession({ ...sessionValue, id: sessionId });
    sessionsById[normalized.id] = normalized;
    if (sessionId !== normalized.id || JSON.stringify(sessionValue) !== JSON.stringify(normalized)) {
      changed = true;
    }
  }

  const rawOrder = Array.isArray(snapshot.sessionOrder) ? snapshot.sessionOrder : [];
  const seen = new Set();
  const sessionOrder = [];
  for (const sessionId of rawOrder) {
    if (seen.has(sessionId) || !sessionsById[sessionId]) continue;
    seen.add(sessionId);
    sessionOrder.push(sessionId);
  }

  const missingIds = Object.keys(sessionsById)
    .filter((sessionId) => !seen.has(sessionId))
    .sort((leftId, rightId) => {
      return sessionsById[rightId].updatedAt.localeCompare(sessionsById[leftId].updatedAt);
    });

  if (missingIds.length > 0 || rawOrder.length !== sessionOrder.length) {
    changed = true;
  }

  sessionOrder.push(...missingIds);

  const currentSessionId = typeof snapshot.currentSessionId === 'string' && sessionsById[snapshot.currentSessionId]
    ? snapshot.currentSessionId
    : sessionOrder[0] || null;

  if (currentSessionId !== (snapshot.currentSessionId ?? null)) {
    changed = true;
  }

  return {
    changed,
    store: {
      currentSessionId,
      sessionOrder,
      sessionsById,
    },
  };
}

function migrateLegacySessionSnapshot(snapshot) {
  const normalized = normalizeSessionStoreSnapshot(snapshot);
  let { store } = normalized;
  let changed = normalized.changed;
  const shouldRemoveLegacy = Object.prototype.hasOwnProperty.call(snapshot, 'session');

  if (!store.sessionOrder.length && hasMeaningfulSession(snapshot.session)) {
    const legacySession = normalizeSession(snapshot.session);
    store = {
      currentSessionId: legacySession.id,
      sessionOrder: [legacySession.id],
      sessionsById: {
        [legacySession.id]: legacySession,
      },
    };
    changed = true;
  }

  return {
    changed,
    shouldRemoveLegacy,
    store,
  };
}

async function persistSessionStore(store, { removeLegacy = false } = {}) {
  await chrome.storage.local.set({
    currentSessionId: store.currentSessionId,
    sessionOrder: store.sessionOrder,
    sessionsById: store.sessionsById,
  });

  if (removeLegacy) {
    await chrome.storage.local.remove(['session']);
  }
}

async function getSessionStore() {
  // Run migration and normalization on every read; writes are idempotent.
  const snapshot = await chrome.storage.local.get(SESSION_STORAGE_KEYS);
  const { store, changed, shouldRemoveLegacy } = migrateLegacySessionSnapshot(snapshot);

  if (changed || shouldRemoveLegacy) {
    await persistSessionStore(store, { removeLegacy: shouldRemoveLegacy });
  }

  return store;
}

function cloneSession(session) {
  return session ? structuredClone(session) : null;
}

function cloneSessions(sessions) {
  return structuredClone(sessions);
}

export async function ensureSessionStoreInitialized() {
  // Warm up storage schema/migrations at extension startup.
  await getSessionStore();
}

export async function getAllSessions() {
  // Return newest-first according to sessionOrder.
  const store = await getSessionStore();
  return cloneSessions(
    store.sessionOrder
      .map((sessionId) => store.sessionsById[sessionId])
      .filter(Boolean),
  );
}

export async function getSession(sessionId) {
  if (!sessionId) return null;
  const store = await getSessionStore();
  return cloneSession(store.sessionsById[sessionId] || null);
}

export async function getCurrentSession() {
  const store = await getSessionStore();
  if (!store.currentSessionId) return null;
  return cloneSession(store.sessionsById[store.currentSessionId] || null);
}

export async function getCurrentSessionId() {
  const store = await getSessionStore();
  return store.currentSessionId || null;
}

export async function saveSession(session) {
  // Upsert session and keep it at the front of the recency order.
  const store = await getSessionStore();
  const existing = session?.id ? store.sessionsById[session.id] : null;
  const nowIso = new Date().toISOString();
  const normalized = normalizeSession(
    {
      ...existing,
      ...session,
      id: session?.id || existing?.id || generateSessionId(),
      createdAt: existing?.createdAt || session?.createdAt || nowIso,
      updatedAt: nowIso,
    },
    nowIso,
  );

  const nextStore = {
    ...store,
    sessionsById: {
      ...store.sessionsById,
      [normalized.id]: normalized,
    },
    sessionOrder: moveSessionIdToFront(store.sessionOrder, normalized.id),
    currentSessionId: store.currentSessionId === normalized.id || !store.currentSessionId
      ? normalized.id
      : store.currentSessionId,
  };

  await persistSessionStore(nextStore);
  return cloneSession(normalized);
}

export async function createSession(sessionData = {}) {
  // Create a fresh session and make it current immediately.
  const nowIso = new Date().toISOString();
  const session = normalizeSession(
    {
      ...sessionData,
      id: generateSessionId(),
      createdAt: sessionData.createdAt || nowIso,
      updatedAt: nowIso,
    },
    nowIso,
  );

  const store = await getSessionStore();
  const nextStore = {
    currentSessionId: session.id,
    sessionOrder: moveSessionIdToFront(store.sessionOrder, session.id),
    sessionsById: {
      ...store.sessionsById,
      [session.id]: session,
    },
  };

  await persistSessionStore(nextStore);
  return cloneSession(session);
}

export async function deleteSession(sessionId) {
  // Remove session and move current pointer to the next available session.
  if (!sessionId) return null;

  const store = await getSessionStore();
  if (!store.sessionsById[sessionId]) {
    return null;
  }

  const deletedSession = store.sessionsById[sessionId];
  const sessionsById = { ...store.sessionsById };
  delete sessionsById[sessionId];

  const sessionOrder = store.sessionOrder.filter((id) => id !== sessionId);
  const currentSessionId = store.currentSessionId === sessionId
    ? sessionOrder[0] || null
    : store.currentSessionId;

  await persistSessionStore({
    currentSessionId,
    sessionOrder,
    sessionsById,
  });

  return cloneSession(deletedSession);
}

export async function setCurrentSession(sessionId) {
  if (!sessionId) return null;

  const store = await getSessionStore();
  if (!store.sessionsById[sessionId]) {
    return null;
  }

  const nextStore = {
    ...store,
    currentSessionId: sessionId,
    sessionOrder: moveSessionIdToFront(store.sessionOrder, sessionId),
  };

  await persistSessionStore(nextStore);
  return cloneSession(nextStore.sessionsById[sessionId]);
}

export function createDefaultBrowsingState(now = Date.now()) {
  // Baseline runtime browsing context used by drift detection.
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
  // Baseline drift score/status snapshot.
  return {
    status: 'focused',
    score: 0,
    reasons: [],
    lastUpdatedAt: now,
    lastNotificationAt: null,
    lastNotificationType: null,
  };
}

export function createActiveSession({ id, goal, questions = [], researchQuestions, createdAt }) {
  // Runtime projection used by drift scoring; decoupled from full session object.
  const startedAt = createdAt ? new Date(createdAt).getTime() : Date.now();
  const normalizedQuestions = Array.isArray(researchQuestions) ? researchQuestions : questions;
  return {
    id: id || generateSessionId(startedAt),
    goal,
    keywords: extractKeywords(goal, normalizedQuestions),
    researchQuestions: normalizedQuestions,
    startedAt,
    isActive: true,
  };
}

export function extractKeywords(goal, researchQuestions = []) {
  // Cheap keyword extraction for on-device relevance scoring.
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

function normalizeDriftSettings(input) {
  const stored = input && typeof input === 'object' ? input : {};
  const normalized = {
    ...DEFAULT_DRIFT_SETTINGS,
    ...stored,
  };

  // Apply new defaults to previously persisted default values while preserving
  // any manually tuned settings already stored in the profile.
  [
    'unrelatedSoftThresholdMs',
    'unrelatedNotifyThresholdMs',
    'distractionNotifyThresholdMs',
  ].forEach((key) => {
    if (stored[key] === LEGACY_DEFAULT_DRIFT_SETTINGS[key]) {
      normalized[key] = DEFAULT_DRIFT_SETTINGS[key];
    }
  });

  return normalized;
}

export async function ensureDriftStateInitialized() {
  // Initialize drift-specific storage keys if missing.
  const now = Date.now();
  const existing = await chrome.storage.local.get([
    'driftSettings',
    'browsingState',
    'driftState',
    'manualRelevanceOverrides',
    'activeSession',
  ]);

  const updates = {};
  if (!existing.driftSettings) {
    updates.driftSettings = { ...DEFAULT_DRIFT_SETTINGS };
  } else {
    const normalizedDriftSettings = normalizeDriftSettings(existing.driftSettings);
    if (JSON.stringify(normalizedDriftSettings) !== JSON.stringify(existing.driftSettings)) {
      updates.driftSettings = normalizedDriftSettings;
    }
  }
  if (!existing.browsingState) updates.browsingState = createDefaultBrowsingState(now);
  if (!existing.driftState) updates.driftState = createDefaultDriftState(now);
  if (!existing.manualRelevanceOverrides) updates.manualRelevanceOverrides = {};
  if (!existing.activeSession) updates.activeSession = null;

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

export async function getDriftBundle() {
  // Retrieve drift settings and runtime state in one read.
  const now = Date.now();
  const stored = await chrome.storage.local.get([
    'driftSettings',
    'browsingState',
    'driftState',
    'manualRelevanceOverrides',
    'activeSession',
  ]);

  return {
    driftSettings: normalizeDriftSettings(stored.driftSettings),
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
  // Clear runtime drift context when a session is paused/ended/switched.
  await chrome.storage.local.set({
    activeSession: null,
    browsingState: createDefaultBrowsingState(Date.now()),
    driftState: createDefaultDriftState(Date.now()),
  });
}

export async function addManualOverride(sessionId, url) {
  // Mark a page as relevant for the current session to suppress false positives.
  if (!sessionId || !url) return;
  const pageKey = normalizePageKey(url);
  const stored = await chrome.storage.local.get(['manualRelevanceOverrides']);
  const map = stored.manualRelevanceOverrides || {};
  map[sessionId] = map[sessionId] || {};
  map[sessionId][pageKey] = true;
  await chrome.storage.local.set({ manualRelevanceOverrides: map });
}

export function hasManualOverride({ manualRelevanceOverrides, sessionId, url }) {
  // Read-side helper used by drift scoring loop.
  if (!sessionId || !url) return false;
  const pageKey = normalizePageKey(url);
  return Boolean(manualRelevanceOverrides?.[sessionId]?.[pageKey]);
}
