const insightGroupingApi = globalThis.ResearchCopilotInsightGrouping;

const SIDEBAR_UI_STATE_KEY = 'sidebarUiState';
const DEFAULT_TAB = 'overview';
const DEFAULT_INSIGHTS_VIEW = 'grouped';
const SESSION_DRAFT_CONTEXT = 'new-session';
const DEFAULT_SETTINGS = {
  backendUrl: 'http://localhost:8000',
  autoAnalyze: true,
  uiFontSize: 14,
};
const VALID_TABS = new Set(['overview', 'insights', 'questions', 'sources', 'settings']);
const STATE_STORAGE_KEYS = [
  'settings',
  'currentSessionId',
  'sessionOrder',
  'sessionsById',
  'session',
];
const RELEVANT_STORAGE_KEYS = new Set([
  'settings',
  'currentSessionId',
  'sessionOrder',
  'sessionsById',
  'session',
]);

let previousInsightKeys = new Set();
let currentSession = null;
let currentSessionId = null;
let allSessions = [];
let currentSettings = { ...DEFAULT_SETTINGS };
let settingsDraft = { ...DEFAULT_SETTINGS };
let settingsDraftDirty = false;
let backendHealth = { healthy: null, error: '', checking: false };
let goalEditorState = { contextKey: null, value: '', dirty: false };
let newSessionGoalDraft = '';
let newSessionComposerOpen = false;
let overviewActionPending = false;
let overviewMode = 'default';
let overviewError = '';
let clarificationPending = false;
let clarificationChatError = '';
let clarificationAnswerDraft = '';
let activeContextSyncPromise = Promise.resolve();
let selectedTab = DEFAULT_TAB;
let insightsViewMode = DEFAULT_INSIGHTS_VIEW;
let groupedViewAvailable = Boolean(insightGroupingApi?.prepareInsightViewModel);
let openClusterIds = new Set();
let highlightedInsightKeys = new Set();
let forcedTimelineFallback = false;
let sidebarUiState = { sessions: {} };
let persistUiStatePromise = Promise.resolve();
let sessionMenuOpen = false;
let scheduledRefreshHandle = null;

const sessionSwitcherSectionEl = document.querySelector('.session-switcher-section');
const sessionSwitcherBtn = document.getElementById('sessionSwitcherBtn');
const sessionSwitcherLabelEl = document.getElementById('sessionSwitcherLabel');
const sessionSwitcherMetaEl = document.getElementById('sessionSwitcherMeta');
const sessionDropdownMenuEl = document.getElementById('sessionDropdownMenu');
const overviewTabContentEl = document.getElementById('overviewTabContent');
const questionsTabContentEl = document.getElementById('questionsTabContent');
const sourcesTabContentEl = document.getElementById('sourcesTabContent');
const settingsTabContentEl = document.getElementById('settingsTabContent');
const groupedInsightsBtn = document.getElementById('groupedInsightsBtn');
const timelineInsightsBtn = document.getElementById('timelineInsightsBtn');
const insightsMetaEl = document.getElementById('insightsMeta');
const insightsNoticeEl = document.getElementById('insightsNotice');
const insightsListEl = document.getElementById('insightsList');
const tabButtons = [...document.querySelectorAll('.tab-btn')];
const tabPanels = {
  overview: document.getElementById('overviewTabPanel'),
  insights: document.getElementById('insightsTabPanel'),
  questions: document.getElementById('questionsTabPanel'),
  sources: document.getElementById('sourcesTabPanel'),
  settings: document.getElementById('settingsTabPanel'),
};

const clarificationState = createEmptyClarificationState();

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) {
    throw new Error(response?.error || 'Unexpected extension error');
  }
  return response.data;
}

async function getState() {
  return sendMessage('GET_SESSION');
}

function sortSessionIdsByUpdatedAt(ids, sessionsById) {
  return [...ids].sort((leftId, rightId) => {
    const leftValue = sessionsById[leftId]?.updatedAt || '';
    const rightValue = sessionsById[rightId]?.updatedAt || '';
    return rightValue.localeCompare(leftValue);
  });
}

function buildStorageBackedState(snapshot = {}) {
  const settings = snapshot?.settings || {};
  const sessionsById = snapshot?.sessionsById && typeof snapshot.sessionsById === 'object'
    ? snapshot.sessionsById
    : {};
  const knownIds = new Set(Object.keys(sessionsById));
  const orderedIds = Array.isArray(snapshot?.sessionOrder)
    ? snapshot.sessionOrder.filter((sessionId) => knownIds.has(sessionId))
    : [];
  const missingIds = sortSessionIdsByUpdatedAt(
    [...knownIds].filter((sessionId) => !orderedIds.includes(sessionId)),
    sessionsById,
  );
  const allSessionIds = [...orderedIds, ...missingIds];

  let currentSessionIdFromStore = typeof snapshot?.currentSessionId === 'string'
    && sessionsById[snapshot.currentSessionId]
    ? snapshot.currentSessionId
    : allSessionIds[0] || null;
  let session = currentSessionIdFromStore ? sessionsById[currentSessionIdFromStore] || null : null;

  if (!session && snapshot?.session && typeof snapshot.session === 'object') {
    session = snapshot.session;
    currentSessionIdFromStore = snapshot.session.id || currentSessionIdFromStore;
  }

  return {
    settings,
    session,
    currentSessionId: currentSessionIdFromStore,
    allSessions: allSessionIds.map((sessionId) => sessionsById[sessionId]).filter(Boolean),
  };
}

function hasLoadedSessionData(state) {
  return Boolean(state?.session?.id || state?.currentSessionId || state?.allSessions?.length);
}

function pickBestAvailableState(runtimeState, storageState) {
  if (!hasLoadedSessionData(runtimeState)) {
    return storageState;
  }

  if (hasLoadedSessionData(storageState)) {
    const runtimeCount = Array.isArray(runtimeState?.allSessions) ? runtimeState.allSessions.length : 0;
    const storageCount = Array.isArray(storageState?.allSessions) ? storageState.allSessions.length : 0;

    if (storageCount > runtimeCount) {
      return storageState;
    }

    if (!runtimeState?.session?.id && storageState?.session?.id) {
      return storageState;
    }
  }

  return runtimeState;
}

async function getStateFromStorage() {
  const snapshot = await chrome.storage.local.get(STATE_STORAGE_KEYS);
  return buildStorageBackedState(snapshot);
}

async function getBestAvailableState() {
  const storageStatePromise = getStateFromStorage();

  try {
    const runtimeState = await getState();
    const storageState = await storageStatePromise;
    return pickBestAvailableState(runtimeState, storageState);
  } catch (error) {
    console.warn('Falling back to chrome.storage.local for sidebar state', error);
    return storageStatePromise;
  }
}

function normalizeFontSize(value) {
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num)) return 14;
  return Math.min(20, Math.max(12, num));
}

function applyFontSize(sizePx) {
  document.documentElement.style.setProperty('--ui-font-size', `${sizePx}px`);
}

function setTextContent(element, value) {
  if (!element) return;
  element.textContent = value;
}

function normalizeSettings(value = {}) {
  const settings = value && typeof value === 'object' ? value : {};
  const backendUrl = String(settings.backendUrl || DEFAULT_SETTINGS.backendUrl).trim()
    || DEFAULT_SETTINGS.backendUrl;

  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    backendUrl,
    autoAnalyze: settings.autoAnalyze == null
      ? DEFAULT_SETTINGS.autoAnalyze
      : Boolean(settings.autoAnalyze),
    uiFontSize: normalizeFontSize(settings.uiFontSize ?? DEFAULT_SETTINGS.uiFontSize),
  };
}

function settingsAreEqual(left, right) {
  return left.backendUrl === right.backendUrl
    && left.autoAnalyze === right.autoAnalyze
    && left.uiFontSize === right.uiFontSize;
}

function createEmptyClarificationState() {
  return {
    contextKey: null,
    roughGoal: '',
    chatHistory: [],
    answers: [],
    clarifiedGoal: null,
    rationale: null,
    isGoalConfirmed: false,
  };
}

function resetClarificationState({ contextKey = null } = {}) {
  clarificationState.contextKey = contextKey;
  clarificationState.roughGoal = '';
  clarificationState.chatHistory = [];
  clarificationState.answers = [];
  clarificationState.clarifiedGoal = null;
  clarificationState.rationale = null;
  clarificationState.isGoalConfirmed = false;
  clarificationPending = false;
  clarificationChatError = '';
  clarificationAnswerDraft = '';
  overviewMode = 'default';
}

async function clearClarificationDraftStorage() {
  await chrome.storage.local.remove([
    'researchSessionDraft',
    'activeResearchGoal',
    'originalResearchGoal',
  ]);
}

async function saveClarificationDraft() {
  if (!clarificationState.contextKey) return;

  await chrome.storage.local.set({
    researchSessionDraft: {
      contextKey: clarificationState.contextKey,
      roughGoal: clarificationState.roughGoal,
      clarificationChat: clarificationState.chatHistory,
      clarifiedGoal: clarificationState.clarifiedGoal,
      rationale: clarificationState.rationale,
      isGoalConfirmed: clarificationState.isGoalConfirmed,
    },
  });
}

async function loadClarificationDraft(contextKey, fallbackGoal = '') {
  resetClarificationState({ contextKey });

  const data = await chrome.storage.local.get(['researchSessionDraft']);
  const draft = data.researchSessionDraft;
  if (!draft) {
    return;
  }

  const storedContextKey = draft.contextKey || null;
  const shouldUseLegacyDraft = !storedContextKey
    && (
      contextKey === SESSION_DRAFT_CONTEXT
      || String(draft.roughGoal || '').trim() === String(fallbackGoal || '').trim()
      || String(draft.clarifiedGoal || '').trim() === String(fallbackGoal || '').trim()
    );

  if (storedContextKey && storedContextKey !== contextKey && !shouldUseLegacyDraft) {
    return;
  }

  if (!storedContextKey && !shouldUseLegacyDraft) {
    return;
  }

  clarificationState.contextKey = contextKey;
  clarificationState.roughGoal = String(draft.roughGoal || '').trim();
  clarificationState.chatHistory = Array.isArray(draft.clarificationChat) ? draft.clarificationChat : [];
  clarificationState.clarifiedGoal = draft.clarifiedGoal || null;
  clarificationState.rationale = draft.rationale || null;
  clarificationState.isGoalConfirmed = Boolean(draft.isGoalConfirmed);
  clarificationState.answers = clarificationState.chatHistory
    .filter((message) => message.role === 'user')
    .map((message) => message.text);
}

function getClarificationQuestionCount() {
  return clarificationState.chatHistory.filter((message) => message.role === 'assistant').length;
}

function isOverviewDraftMode(session = currentSession) {
  return newSessionComposerOpen || !session?.id;
}

function getOverviewContextKey(session = currentSession) {
  return isOverviewDraftMode(session)
    ? SESSION_DRAFT_CONTEXT
    : `session:${session.id}`;
}

function getStoredGoalForCurrentContext(session = currentSession) {
  if (isOverviewDraftMode(session)) {
    return newSessionGoalDraft;
  }
  return session?.goal || '';
}

function getGoalValueForContext(session = currentSession) {
  const fallback = getStoredGoalForCurrentContext(session);
  if (
    clarificationState.contextKey === getOverviewContextKey(session)
    && clarificationState.isGoalConfirmed
    && clarificationState.clarifiedGoal
  ) {
    return clarificationState.clarifiedGoal;
  }

  if (
    clarificationState.contextKey === SESSION_DRAFT_CONTEXT
    && isOverviewDraftMode(session)
    && clarificationState.roughGoal
  ) {
    return clarificationState.roughGoal;
  }

  return fallback;
}

function setGoalEditorState(contextKey, value, dirty = false) {
  goalEditorState = {
    contextKey,
    value,
    dirty,
  };

  if (contextKey === SESSION_DRAFT_CONTEXT) {
    newSessionGoalDraft = value;
  }
}

function updateGoalEditorValue(value, { dirty = true } = {}) {
  setGoalEditorState(goalEditorState.contextKey, value, dirty);
}

function shouldMarkGoalEditorDirty(session, contextKey, value) {
  if (contextKey === SESSION_DRAFT_CONTEXT) {
    return false;
  }

  return String(value || '').trim() !== String(session?.goal || '').trim();
}

async function syncOverviewContext(session = currentSession) {
  const contextKey = getOverviewContextKey(session);
  const contextChanged = goalEditorState.contextKey !== contextKey
    || clarificationState.contextKey !== contextKey;

  if (contextChanged) {
    setGoalEditorState(
      contextKey,
      getStoredGoalForCurrentContext(session),
      shouldMarkGoalEditorDirty(session, contextKey, getStoredGoalForCurrentContext(session)),
    );
    await loadClarificationDraft(contextKey, getStoredGoalForCurrentContext(session));
    const goalValue = getGoalValueForContext(session);
    setGoalEditorState(
      contextKey,
      goalValue,
      shouldMarkGoalEditorDirty(session, contextKey, goalValue),
    );
    return;
  }

  if (!goalEditorState.dirty) {
    const goalValue = getGoalValueForContext(session);
    setGoalEditorState(
      contextKey,
      goalValue,
      shouldMarkGoalEditorDirty(session, contextKey, goalValue),
    );
  }
}

function queueContextSync(session = currentSession) {
  activeContextSyncPromise = activeContextSyncPromise
    .catch(() => {})
    .then(() => syncOverviewContext(session));
  return activeContextSyncPromise;
}

function clearOverviewError() {
  overviewError = '';
}

function setOverviewError(message) {
  overviewError = message || '';
}

function getEffectiveOverviewGoal() {
  if (clarificationState.isGoalConfirmed && clarificationState.clarifiedGoal) {
    return clarificationState.clarifiedGoal;
  }
  return String(goalEditorState.value || '').trim();
}

function createDefaultSessionUiState() {
  return {
    selectedTab: DEFAULT_TAB,
    insightsViewMode: DEFAULT_INSIGHTS_VIEW,
    openClusterIds: [],
  };
}

function normalizeSessionUiState(value = {}) {
  const next = createDefaultSessionUiState();

  if (VALID_TABS.has(value?.selectedTab)) {
    next.selectedTab = value.selectedTab;
  }

  if (value?.insightsViewMode === 'timeline') {
    next.insightsViewMode = 'timeline';
  }

  next.openClusterIds = Array.from(
    new Set(
      (Array.isArray(value?.openClusterIds) ? value.openClusterIds : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );

  return next;
}

function normalizeSidebarUiState(value = {}) {
  const rawSessions = value?.sessions && typeof value.sessions === 'object'
    ? value.sessions
    : {};
  const sessions = {};

  for (const [sessionId, sessionState] of Object.entries(rawSessions)) {
    if (!sessionId) continue;
    sessions[sessionId] = normalizeSessionUiState(sessionState);
  }

  return { sessions };
}

async function loadSidebarUiState() {
  const stored = await chrome.storage.local.get([SIDEBAR_UI_STATE_KEY]);
  sidebarUiState = normalizeSidebarUiState(stored[SIDEBAR_UI_STATE_KEY]);
}

function queuePersistSidebarUiState() {
  persistUiStatePromise = persistUiStatePromise
    .catch(() => {})
    .then(() => chrome.storage.local.set({ [SIDEBAR_UI_STATE_KEY]: sidebarUiState }))
    .catch((error) => {
      console.error('Failed to persist sidebar UI state', error);
    });
}

function getStoredSessionUiState(sessionId) {
  if (!sessionId) return createDefaultSessionUiState();
  return normalizeSessionUiState(sidebarUiState.sessions[sessionId]);
}

function updateSessionUiState(sessionId, patch) {
  if (!sessionId) return;
  const currentUiState = getStoredSessionUiState(sessionId);
  sidebarUiState.sessions[sessionId] = normalizeSessionUiState({
    ...currentUiState,
    ...patch,
  });
  queuePersistSidebarUiState();
}

function syncCurrentSessionUiState(patch) {
  if (!currentSession?.id) return;
  updateSessionUiState(currentSession.id, patch);
}

function getResearchQuestions(session) {
  if (Array.isArray(session?.researchQuestions)) return session.researchQuestions;
  if (Array.isArray(session?.questions)) return session.questions;
  return [];
}

function getSessionDisplayTitle(session) {
  return session?.title || session?.goal || 'Untitled research session';
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getSessionCounts(session) {
  return {
    questionCount: getResearchQuestions(session).length,
    insightCount: Array.isArray(session?.insights) ? session.insights.length : 0,
    sourceCount: Array.isArray(session?.sources) ? session.sources.length : 0,
  };
}

function buildSessionCountSummary(session) {
  const counts = getSessionCounts(session);
  return [
    pluralize(counts.questionCount, 'question'),
    pluralize(counts.insightCount, 'insight'),
    pluralize(counts.sourceCount, 'source'),
  ].join(' • ');
}

function formatSessionTimestamp(value, prefix = 'Updated') {
  if (!value) return '';

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return `${prefix} ${parsed.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

function getSessionStatusLabel(session) {
  switch (session?.status) {
    case 'paused':
      return 'Paused';
    case 'saved':
      return 'Saved';
    default:
      return 'Active';
  }
}

function getSessionStatusClass(session) {
  switch (session?.status) {
    case 'paused':
      return 'warning';
    case 'saved':
      return 'muted';
    default:
      return 'success';
  }
}

function formatCapturedAt(value) {
  if (!value) return 'Captured recently';

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Captured recently';
  }

  return `Captured ${parsed.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

function normalizeTextKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function textsOverlap(left, right) {
  const leftKey = normalizeTextKey(left);
  const rightKey = normalizeTextKey(right);
  if (!leftKey || !rightKey) return false;
  return leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey);
}

function getQuestionCoverageState(question, session) {
  const missingTopics = Array.isArray(session?.missingTopics) ? session.missingTopics : [];
  const isMissing = missingTopics.some((topic) => textsOverlap(question, topic));

  if (isMissing) {
    return { label: 'Missing', className: 'warning' };
  }

  const hasEvidence = (Array.isArray(session?.insights) && session.insights.length > 0)
    || (Array.isArray(session?.sources) && session.sources.length > 0);

  if (hasEvidence) {
    return { label: 'Covered', className: 'success' };
  }

  return { label: 'In progress', className: 'muted' };
}

function getStandaloneMissingTopics(session) {
  const questions = getResearchQuestions(session);
  const missingTopics = Array.isArray(session?.missingTopics) ? session.missingTopics : [];
  const seen = new Set();
  const standalone = [];

  for (const topic of missingTopics) {
    const topicKey = normalizeTextKey(topic);
    if (!topicKey || seen.has(topicKey)) continue;
    seen.add(topicKey);

    const matchesTrackedQuestion = questions.some((question) => textsOverlap(question, topic));
    if (!matchesTrackedQuestion) {
      standalone.push(topic);
    }
  }

  return standalone;
}

function getSourceDomain(source) {
  if (source?.domain) return source.domain;

  try {
    return new URL(source?.url || '').hostname;
  } catch {
    return '';
  }
}

function createStatusPill(label, className = 'muted') {
  const pill = document.createElement('span');
  pill.className = `status-pill ${className}`.trim();
  pill.textContent = label;
  return pill;
}

function createMetaChip(text) {
  const chip = document.createElement('span');
  chip.className = 'meta-chip';
  chip.textContent = text;
  return chip;
}

function createSessionStats(session, className = 'session-stats') {
  const stats = document.createElement('div');
  stats.className = className;

  const counts = getSessionCounts(session);
  const items = [
    pluralize(counts.questionCount, 'question'),
    pluralize(counts.insightCount, 'insight'),
    pluralize(counts.sourceCount, 'source'),
  ];

  for (const label of items) {
    const stat = document.createElement('span');
    stat.className = 'session-stat';
    stat.textContent = label;
    stats.appendChild(stat);
  }

  return stats;
}

function createSectionBlock(title, metaText = '') {
  const section = document.createElement('section');
  section.className = 'section-block';

  const header = document.createElement('div');
  header.className = 'section-block-header';

  const heading = document.createElement('h2');
  heading.textContent = title;
  header.appendChild(heading);

  if (metaText) {
    const meta = document.createElement('div');
    meta.className = 'muted small';
    meta.textContent = metaText;
    header.appendChild(meta);
  }

  section.appendChild(header);
  return section;
}

function createEmptyStateCard(message, options = {}) {
  const card = document.createElement('div');
  card.className = 'card empty-state';

  const body = document.createElement('p');
  body.className = 'muted';
  body.textContent = message;
  card.appendChild(body);

  if (options.actionLabel && typeof options.onAction === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    if (options.actionClassName) {
      button.className = options.actionClassName;
    }
    button.textContent = options.actionLabel;
    button.addEventListener('click', options.onAction);
    card.appendChild(button);
  }

  return card;
}

function createQuestionCard(text, state) {
  const card = document.createElement('article');
  card.className = 'card question-item';

  const row = document.createElement('div');
  row.className = 'question-item-row';

  const questionText = document.createElement('div');
  questionText.className = 'question-item-text';
  questionText.textContent = text;
  row.appendChild(questionText);

  row.appendChild(createStatusPill(state.label, state.className));
  card.appendChild(row);
  return card;
}

function createMissingTopicCard(text) {
  const card = document.createElement('article');
  card.className = 'card question-item missing-topic-item';

  const row = document.createElement('div');
  row.className = 'question-item-row';

  const topicText = document.createElement('div');
  topicText.className = 'question-item-text';
  topicText.textContent = text;
  row.appendChild(topicText);

  row.appendChild(createStatusPill('Missing', 'warning'));
  card.appendChild(row);
  return card;
}

function createSourceCard(source) {
  const card = document.createElement('article');
  card.className = 'card source-item';

  const title = source?.title || source?.url || 'Untitled source';
  const url = source?.url || '';
  const domain = getSourceDomain(source);

  if (url) {
    const link = document.createElement('a');
    link.className = 'source-link';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = title;
    card.appendChild(link);
  } else {
    const label = document.createElement('div');
    label.className = 'source-link';
    label.textContent = title;
    card.appendChild(label);
  }

  const metaRow = document.createElement('div');
  metaRow.className = 'source-meta-row';

  if (domain) {
    metaRow.appendChild(createMetaChip(domain));
  }

  const captured = document.createElement('span');
  captured.className = 'muted small';
  captured.textContent = formatCapturedAt(source?.analyzedAt || source?.capturedAt);
  metaRow.appendChild(captured);

  card.appendChild(metaRow);
  return card;
}

function setSessionMenuOpen(isOpen) {
  sessionMenuOpen = Boolean(isOpen);
  sessionSwitcherBtn.setAttribute('aria-expanded', String(sessionMenuOpen));
  sessionSwitcherBtn.classList.toggle('is-open', sessionMenuOpen);
  sessionDropdownMenuEl.classList.toggle('hidden', !sessionMenuOpen);
}

async function setNewSessionComposerOpen(isOpen) {
  if (!isOpen && !currentSession?.id) {
    return;
  }

  newSessionComposerOpen = Boolean(isOpen);
  setSessionMenuOpen(false);
  clearOverviewError();
  clarificationChatError = '';
  clarificationAnswerDraft = '';
  overviewMode = 'default';

  if (newSessionComposerOpen) {
    selectedTab = DEFAULT_TAB;
    renderTabBar();
  }

  await queueContextSync(currentSession);
  renderOverviewTab(currentSession);

  if (newSessionComposerOpen) {
    queueMicrotask(() => {
      document.getElementById('overviewGoalInput')?.focus();
    });
  }
}

async function handleCurrentSessionAction(session) {
  if (!session?.id) return;

  if (session.status === 'saved') {
    await sendMessage('OPEN_SESSION', { sessionId: session.id });
    return;
  }

  await sendMessage('TOGGLE_SESSION_PAUSE', {
    paused: session.status === 'active',
  });
}

async function handleDeleteSession(sessionId) {
  if (!sessionId) return;
  if (!window.confirm('Delete this research session from local storage?')) return;

  if (clarificationState.contextKey === `session:${sessionId}`) {
    resetClarificationState();
    await clearClarificationDraftStorage();
  }

  await sendMessage('DELETE_SESSION', { sessionId });
}

async function handleStartNewSession() {
  const goal = getEffectiveOverviewGoal();
  if (!goal) {
    setOverviewError('Please enter a research goal first.');
    renderOverviewTab(currentSession);
    return;
  }

  clearOverviewError();
  overviewActionPending = true;
  renderOverviewTab(currentSession);

  try {
    const session = await sendMessage('START_SESSION', { goal });
    updateSessionUiState(session?.id, createDefaultSessionUiState());

    if (clarificationState.isGoalConfirmed && clarificationState.clarifiedGoal) {
      clarificationState.contextKey = `session:${session.id}`;
      await saveClarificationDraft();
    } else {
      resetClarificationState({ contextKey: SESSION_DRAFT_CONTEXT });
      await clearClarificationDraftStorage();
    }

    newSessionGoalDraft = '';
    newSessionComposerOpen = false;
    selectedTab = DEFAULT_TAB;
    insightsViewMode = DEFAULT_INSIGHTS_VIEW;
    openClusterIds = new Set();
    forcedTimelineFallback = false;
    await refreshState(false);
  } catch (error) {
    setOverviewError(error.message || 'Failed to start session.');
    renderOverviewTab(currentSession);
  } finally {
    overviewActionPending = false;
    renderOverviewTab(currentSession);
  }
}

async function handleSaveSessionGoal(session) {
  const goal = getEffectiveOverviewGoal();
  if (!goal) {
    setOverviewError('Please enter a research goal first.');
    renderOverviewTab(currentSession);
    return;
  }

  overviewActionPending = true;
  clearOverviewError();
  renderOverviewTab(currentSession);

  try {
    await sendMessage('UPDATE_SESSION_GOAL', {
      sessionId: session.id,
      goal,
    });

    goalEditorState.dirty = false;
    if (clarificationState.contextKey === getOverviewContextKey(session)) {
      await saveClarificationDraft();
    }

    await refreshState(false);
  } catch (error) {
    setOverviewError(error.message || 'Failed to save the session goal.');
    renderOverviewTab(currentSession);
  } finally {
    overviewActionPending = false;
    renderOverviewTab(currentSession);
  }
}

async function refreshBackendHealth({ rerender = true } = {}) {
  backendHealth = { ...backendHealth, checking: true };
  if (rerender) {
    renderOverviewTab(currentSession);
    renderSettingsTab();
  }

  try {
    const result = await sendMessage('PING_BACKEND');
    backendHealth = {
      healthy: Boolean(result?.healthy),
      error: result?.error || '',
      checking: false,
    };
  } catch (error) {
    backendHealth = {
      healthy: false,
      error: error.message || 'Failed to reach backend.',
      checking: false,
    };
  }

  if (rerender) {
    renderOverviewTab(currentSession);
    renderSettingsTab();
  }
}

function updateSettingsFormUi() {
  setTextContent(
    document.getElementById('settingsFontValue'),
    `${settingsDraft.uiFontSize}px`,
  );

  const saveBtn = document.getElementById('settingsSaveBtn');
  if (saveBtn) {
    saveBtn.textContent = settingsDraftDirty ? 'Save settings' : 'Saved';
    saveBtn.disabled = !settingsDraftDirty && !backendHealth.error;
  }

  const refreshBtn = document.getElementById('settingsRefreshBtn');
  if (refreshBtn) {
    refreshBtn.disabled = backendHealth.checking || settingsDraftDirty;
  }

  document.getElementById('settingsDirtyNote')?.classList.toggle('hidden', !settingsDraftDirty);
}

function handleSettingsFieldChange(field, value) {
  settingsDraft = {
    ...settingsDraft,
    [field]: value,
  };
  settingsDraftDirty = !settingsAreEqual(settingsDraft, currentSettings);

  if (field === 'uiFontSize') {
    applyFontSize(settingsDraft.uiFontSize);
  }

  updateSettingsFormUi();
}

async function handleSaveSettings() {
  settingsDraft = normalizeSettings(settingsDraft);
  settingsDraftDirty = false;
  renderSettingsTab();

  try {
    const savedSettings = normalizeSettings(await sendMessage('SAVE_SETTINGS', settingsDraft));
    currentSettings = savedSettings;
    settingsDraft = { ...savedSettings };
    applyFontSize(savedSettings.uiFontSize);
    await refreshBackendHealth({ rerender: false });
  } catch (error) {
    settingsDraftDirty = true;
    backendHealth = {
      healthy: false,
      error: error.message || 'Failed to save settings.',
      checking: false,
    };
  }

  renderOverviewTab(currentSession);
  renderSettingsTab();
}

function getClarifyBackendUrl() {
  return currentSettings.backendUrl || DEFAULT_SETTINGS.backendUrl;
}

function setOverviewMode(mode) {
  overviewMode = mode;
  renderOverviewTab(currentSession);
}

function getClarifyProgressLabel() {
  const questionCount = getClarificationQuestionCount();
  return questionCount > 0 ? `Question ${questionCount} of ~4` : '';
}

function isClarificationRelevantForCurrentContext() {
  return clarificationState.contextKey === getOverviewContextKey(currentSession);
}

function maybeInvalidateClarificationFromGoalEdit(nextValue) {
  if (!isClarificationRelevantForCurrentContext() || !clarificationState.isGoalConfirmed) {
    return false;
  }

  if (nextValue.trim() === clarificationState.clarifiedGoal) {
    return false;
  }

  resetClarificationState({ contextKey: getOverviewContextKey(currentSession) });
  void clearClarificationDraftStorage();
  return true;
}

function updateOverviewGoalEditorUi() {
  const saveBtn = document.getElementById('overviewSaveGoalBtn');
  if (saveBtn) {
    saveBtn.disabled = !goalEditorState.dirty || overviewActionPending || clarificationPending;
  }

  document.getElementById('overviewGoalHint')?.classList.toggle('hidden', !goalEditorState.dirty);
}

function handleOverviewGoalInput(value) {
  const hadOverviewError = Boolean(overviewError);
  clearOverviewError();
  const invalidatedClarification = maybeInvalidateClarificationFromGoalEdit(value);

  if (isOverviewDraftMode(currentSession)) {
    updateGoalEditorValue(value, { dirty: true });
    if (hadOverviewError || invalidatedClarification) {
      renderOverviewTab(currentSession);
    }
    return;
  }

  const nextDirty = value.trim() !== String(currentSession?.goal || '').trim();
  updateGoalEditorValue(value, { dirty: nextDirty });

  if (hadOverviewError || invalidatedClarification) {
    renderOverviewTab(currentSession);
    return;
  }

  updateOverviewGoalEditorUi();
}

function handleClarificationResponse(data) {
  clarificationChatError = '';

  if (data.status === 'complete') {
    clarificationState.clarifiedGoal = data.clarifiedGoal;
    clarificationState.rationale = data.rationale || null;
    overviewMode = 'confirm';
    return saveClarificationDraft();
  }

  if (data.status === 'needs_clarification' && data.message) {
    clarificationState.chatHistory.push(data.message);
    overviewMode = 'clarifying';
    return saveClarificationDraft();
  }

  return Promise.resolve();
}

async function requestNextClarificationStep() {
  clarificationPending = true;
  clarificationChatError = '';
  renderOverviewTab(currentSession);

  try {
    const response = await fetch(`${getClarifyBackendUrl()}/api/clarify-goal/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roughGoal: clarificationState.roughGoal,
        chatHistory: clarificationState.chatHistory,
        answers: clarificationState.answers,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    await handleClarificationResponse(data);
  } catch (error) {
    clarificationChatError = 'Failed to get the next step. You can type a custom answer below to continue.';
  } finally {
    clarificationPending = false;
    renderOverviewTab(currentSession);
  }
}

async function handleClarificationAnswer(answer) {
  const value = String(answer || '').trim();
  if (!value) return;

  clarificationChatError = '';
  clarificationAnswerDraft = '';
  clarificationState.chatHistory.push({ role: 'user', text: value });
  clarificationState.answers.push(value);
  await saveClarificationDraft();
  await requestNextClarificationStep();
}

async function handleClarifyGoalClick() {
  const roughGoal = String(goalEditorState.value || '').trim();
  if (!roughGoal) {
    setOverviewError('Please enter a research goal before clarifying.');
    renderOverviewTab(currentSession);
    return;
  }

  clearOverviewError();
  const contextKey = getOverviewContextKey(currentSession);

  if (
    clarificationState.contextKey === contextKey
    && clarificationState.roughGoal
    && clarificationState.roughGoal !== roughGoal
    && clarificationState.chatHistory.length > 0
  ) {
    const shouldContinue = window.confirm(
      'Your goal changed. This will discard the previous clarification draft. Continue?',
    );
    if (!shouldContinue) {
      return;
    }

    resetClarificationState({ contextKey });
    await clearClarificationDraftStorage();
  }

  clarificationState.contextKey = contextKey;
  clarificationState.roughGoal = roughGoal;
  overviewMode = 'clarifying';
  clarificationChatError = '';
  renderOverviewTab(currentSession);

  if (clarificationState.chatHistory.length > 0) {
    await saveClarificationDraft();
    return;
  }

  clarificationPending = true;
  renderOverviewTab(currentSession);

  try {
    const response = await fetch(`${getClarifyBackendUrl()}/api/clarify-goal/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roughGoal }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    await handleClarificationResponse(data);
  } catch (error) {
    clarificationChatError = 'Could not reach the backend. Check your Backend URL setting and try again.';
  } finally {
    clarificationPending = false;
    renderOverviewTab(currentSession);
  }
}

async function handleRefineAgain() {
  overviewMode = 'clarifying';
  clarificationPending = true;
  clarificationChatError = '';
  renderOverviewTab(currentSession);

  try {
    const response = await fetch(`${getClarifyBackendUrl()}/api/clarify-goal/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roughGoal: clarificationState.roughGoal,
        chatHistory: clarificationState.chatHistory,
        answers: clarificationState.answers,
        currentClarifiedGoal: clarificationState.clarifiedGoal,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    await handleClarificationResponse(data);
  } catch (error) {
    clarificationChatError = 'Failed to refine. Type an additional answer below to guide the refinement.';
  } finally {
    clarificationPending = false;
    renderOverviewTab(currentSession);
  }
}

async function handleConfirmClarifiedGoal() {
  clarificationState.isGoalConfirmed = true;
  await chrome.storage.local.set({
    activeResearchGoal: clarificationState.clarifiedGoal,
    originalResearchGoal: clarificationState.roughGoal,
  });
  await saveClarificationDraft();

  const contextKey = getOverviewContextKey(currentSession);
  const shouldMarkDirty = !isOverviewDraftMode(currentSession)
    && clarificationState.clarifiedGoal !== String(currentSession?.goal || '').trim();

  setGoalEditorState(contextKey, clarificationState.clarifiedGoal || '', shouldMarkDirty);
  overviewMode = 'default';
  renderOverviewTab(currentSession);
}

async function handleResetClarifiedGoal() {
  const shouldReset = window.confirm(
    'Reset to the original rough goal? This will discard your clarified goal.',
  );
  if (!shouldReset) {
    return;
  }

  const nextValue = clarificationState.roughGoal;
  const contextKey = getOverviewContextKey(currentSession);
  const shouldMarkDirty = !isOverviewDraftMode(currentSession)
    && nextValue !== String(currentSession?.goal || '').trim();

  resetClarificationState({ contextKey });
  await clearClarificationDraftStorage();
  setGoalEditorState(contextKey, nextValue, shouldMarkDirty);
  renderOverviewTab(currentSession);
}

function createSessionMenuRow(session, activeId) {
  const row = document.createElement('div');
  row.className = 'session-menu-row';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'session-menu-option';
  button.setAttribute('role', 'menuitem');
  if (session?.id === activeId) {
    button.classList.add('active');
  }

  const titleRow = document.createElement('div');
  titleRow.className = 'session-menu-title-row';

  const title = document.createElement('strong');
  title.textContent = getSessionDisplayTitle(session);
  titleRow.appendChild(title);

  if (session?.id === activeId) {
    titleRow.appendChild(createMetaChip('Current'));
  }

  button.appendChild(titleRow);

  const updated = document.createElement('div');
  updated.className = 'muted small';
  updated.textContent = formatSessionTimestamp(session?.updatedAt)
    || formatSessionTimestamp(session?.createdAt, 'Created');
  button.appendChild(updated);

  const summary = document.createElement('div');
  summary.className = 'muted small';
  summary.textContent = buildSessionCountSummary(session);
  button.appendChild(summary);

  button.addEventListener('click', async () => {
    setSessionMenuOpen(false);
    if (!session?.id) return;

    if (session.id === activeId) {
      if (newSessionComposerOpen) {
        await setNewSessionComposerOpen(false);
      }
      return;
    }

    try {
      newSessionComposerOpen = false;
      await sendMessage('OPEN_SESSION', { sessionId: session.id });
      await refreshState(false);
    } catch (error) {
      window.alert(error.message || 'Failed to open session');
    }
  });

  row.appendChild(button);

  if (session?.id && session.id !== activeId) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'text-btn session-menu-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.setAttribute('aria-label', `Delete ${getSessionDisplayTitle(session)}`);
    deleteBtn.addEventListener('click', async (event) => {
      event.stopPropagation();

      try {
        setSessionMenuOpen(false);
        await handleDeleteSession(session.id);
        await refreshState(false);
      } catch (error) {
        window.alert(error.message || 'Failed to delete session');
      }
    });
    row.appendChild(deleteBtn);
  }

  return row;
}

function appendSessionMenuSection(container, title, sessions, activeId) {
  const label = document.createElement('div');
  label.className = 'session-menu-section-label';
  label.textContent = title;
  container.appendChild(label);

  for (const session of sessions) {
    container.appendChild(createSessionMenuRow(session, activeId));
  }
}

function renderSessionSwitcher(allSessions, activeId) {
  const sessions = Array.isArray(allSessions) ? allSessions.filter(Boolean) : [];
  const activeSession = sessions.find((session) => session?.id === activeId) || null;
  const metaParts = [];

  setTextContent(
    sessionSwitcherLabelEl,
    activeSession?.id
    ? getSessionDisplayTitle(activeSession)
    : 'No session selected',
  );

  if (activeSession?.id) {
    const updatedLabel = formatSessionTimestamp(activeSession.updatedAt)
      || formatSessionTimestamp(activeSession.createdAt, 'Created');
    if (updatedLabel) metaParts.push(updatedLabel);
    metaParts.push(buildSessionCountSummary(activeSession));
  }

  setTextContent(
    sessionSwitcherMetaEl,
    metaParts.length
      ? metaParts.join(' • ')
      : 'Start a new session or reopen a past workspace.',
  );

  sessionDropdownMenuEl.innerHTML = '';

  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'session-menu-empty muted small';
    empty.textContent = 'No saved sessions yet.';
    sessionDropdownMenuEl.appendChild(empty);
  } else {
    if (activeSession?.id) {
      appendSessionMenuSection(sessionDropdownMenuEl, 'Current session', [activeSession], activeId);
    }

    const pastSessions = sessions.filter((session) => session?.id && session.id !== activeId);
    if (pastSessions.length) {
      appendSessionMenuSection(sessionDropdownMenuEl, 'Past sessions', pastSessions, activeId);
    }
  }

  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'session-menu-create';
  createBtn.setAttribute('role', 'menuitem');
  createBtn.textContent = '+ New Session';
  createBtn.addEventListener('click', () => {
    void setNewSessionComposerOpen(true);
  });
  sessionDropdownMenuEl.appendChild(createBtn);
}

function renderTabBar() {
  for (const button of tabButtons) {
    const isActive = button.dataset.tab === selectedTab;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  }

  for (const [tabId, panel] of Object.entries(tabPanels)) {
    const isActive = tabId === selectedTab;
    panel.classList.toggle('hidden', !isActive);
    panel.hidden = !isActive;
  }
}

function renderActiveTabContent(session, highlightNew = false) {
  switch (selectedTab) {
    case 'insights':
      renderInsightsTab(session, highlightNew);
      break;
    case 'questions':
      renderQuestionsTab(session);
      break;
    case 'sources':
      renderSourcesTab(session);
      break;
    case 'settings':
      renderSettingsTab();
      break;
    case 'overview':
    default:
      renderOverviewTab(session);
      break;
  }
}

function setActiveTab(tabId, { persist = true } = {}) {
  if (!VALID_TABS.has(tabId)) {
    selectedTab = DEFAULT_TAB;
  } else {
    selectedTab = tabId;
  }

  renderTabBar();
  renderActiveTabContent(currentSession, false);

  if (persist && currentSession?.id) {
    syncCurrentSessionUiState({ selectedTab });
  }
}

function createOverviewStatusRow(session) {
  const row = document.createElement('div');
  row.className = 'overview-status-row';

  if (session?.id) {
    row.appendChild(createStatusPill(getSessionStatusLabel(session), getSessionStatusClass(session)));
  } else {
    row.appendChild(createStatusPill('Not started', 'muted'));
  }

  if (backendHealth.checking) {
    row.appendChild(createStatusPill('Checking backend', 'muted'));
  } else if (backendHealth.healthy === false) {
    row.appendChild(createStatusPill('Backend offline', 'danger'));
  }

  return row;
}

function createGoalStatusRow(session) {
  const row = document.createElement('div');
  row.className = 'goal-status-row';

  if (clarificationState.contextKey === getOverviewContextKey(session)) {
    if (clarificationState.isGoalConfirmed && clarificationState.clarifiedGoal) {
      row.appendChild(createStatusPill('Clarified ✓', 'success'));

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'text-btn small';
      resetBtn.textContent = 'Reset';
      resetBtn.addEventListener('click', () => {
        void handleResetClarifiedGoal();
      });
      row.appendChild(resetBtn);
    } else if (clarificationState.chatHistory.length > 0) {
      row.appendChild(createStatusPill('Clarifying…', 'warning'));
    }
  }

  return row;
}

function createClarificationCard() {
  const card = document.createElement('article');
  card.className = 'card clarification-card';

  const header = document.createElement('div');
  header.className = 'section-header-row';

  const title = document.createElement('span');
  title.className = 'section-title';
  title.textContent = 'Clarify your goal';
  header.appendChild(title);

  const progress = document.createElement('span');
  progress.className = 'muted small';
  progress.textContent = getClarifyProgressLabel();
  header.appendChild(progress);

  card.appendChild(header);

  const chatContainer = document.createElement('div');
  chatContainer.className = 'chat-container';

  for (const message of clarificationState.chatHistory) {
    const item = document.createElement('div');
    item.className = `chat-message ${message.role === 'assistant' ? 'msg-assistant' : 'msg-user'}`;
    item.textContent = message.text;
    chatContainer.appendChild(item);
  }

  if (clarificationPending) {
    const typing = document.createElement('div');
    typing.className = 'chat-message msg-assistant typing-indicator';
    typing.innerHTML = '<span></span><span></span><span></span>';
    chatContainer.appendChild(typing);
  }

  if (clarificationChatError) {
    const error = document.createElement('div');
    error.className = 'chat-error';
    error.textContent = clarificationChatError;
    chatContainer.appendChild(error);
  }

  card.appendChild(chatContainer);

  const lastMessage = clarificationState.chatHistory[clarificationState.chatHistory.length - 1];
  const options = lastMessage?.role === 'assistant' && Array.isArray(lastMessage.options)
    ? lastMessage.options
    : [];

  const optionsContainer = document.createElement('div');
  optionsContainer.className = 'options-container';
  for (const option of options) {
    const optionBtn = document.createElement('button');
    optionBtn.type = 'button';
    optionBtn.className = 'option-chip';
    optionBtn.textContent = option;
    optionBtn.disabled = clarificationPending;
    optionBtn.addEventListener('click', () => {
      void handleClarificationAnswer(option);
    });
    optionsContainer.appendChild(optionBtn);
  }
  card.appendChild(optionsContainer);

  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Or type a custom answer…';
  input.value = clarificationAnswerDraft;
  input.disabled = clarificationPending;
  input.addEventListener('input', (event) => {
    clarificationAnswerDraft = event.target.value;
    sendBtn.disabled = clarificationPending || !clarificationAnswerDraft.trim();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void handleClarificationAnswer(clarificationAnswerDraft);
    }
  });
  inputRow.appendChild(input);

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'send-btn';
  sendBtn.textContent = 'Send';
  sendBtn.disabled = clarificationPending || !clarificationAnswerDraft.trim();
  sendBtn.addEventListener('click', () => {
    void handleClarificationAnswer(clarificationAnswerDraft);
  });
  inputRow.appendChild(sendBtn);

  card.appendChild(inputRow);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'secondary full-width-btn';
  cancelBtn.textContent = 'Close';
  cancelBtn.disabled = clarificationPending;
  cancelBtn.addEventListener('click', () => {
    setOverviewMode('default');
  });
  card.appendChild(cancelBtn);

  return card;
}

function createClarificationConfirmationCard() {
  const card = document.createElement('article');
  card.className = 'card clarification-card';

  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = 'Goal clarified';
  card.appendChild(title);

  const comparison = document.createElement('div');
  comparison.className = 'goal-comparison';

  const originalField = document.createElement('div');
  originalField.className = 'goal-field';
  const originalLabel = document.createElement('div');
  originalLabel.className = 'goal-field-label muted';
  originalLabel.textContent = 'Original';
  const originalText = document.createElement('div');
  originalText.className = 'goal-field-text muted';
  originalText.textContent = clarificationState.roughGoal || 'No original goal saved.';
  originalField.appendChild(originalLabel);
  originalField.appendChild(originalText);
  comparison.appendChild(originalField);

  const clarifiedField = document.createElement('div');
  clarifiedField.className = 'goal-field';
  const clarifiedLabel = document.createElement('div');
  clarifiedLabel.className = 'goal-field-label';
  clarifiedLabel.textContent = 'Clarified';
  const clarifiedText = document.createElement('div');
  clarifiedText.className = 'goal-field-text clarified-text';
  clarifiedText.textContent = clarificationState.clarifiedGoal || 'No clarified goal returned.';
  clarifiedField.appendChild(clarifiedLabel);
  clarifiedField.appendChild(clarifiedText);
  comparison.appendChild(clarifiedField);

  if (clarificationState.rationale) {
    const rationale = document.createElement('div');
    rationale.className = 'rationale-text muted';
    rationale.textContent = clarificationState.rationale;
    comparison.appendChild(rationale);
  }

  card.appendChild(comparison);

  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = 'Use This Goal';
  confirmBtn.addEventListener('click', () => {
    void handleConfirmClarifiedGoal();
  });
  actions.appendChild(confirmBtn);

  const refineBtn = document.createElement('button');
  refineBtn.type = 'button';
  refineBtn.className = 'secondary';
  refineBtn.textContent = 'Refine Again';
  refineBtn.addEventListener('click', () => {
    void handleRefineAgain();
  });
  actions.appendChild(refineBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    setOverviewMode('default');
  });
  actions.appendChild(cancelBtn);

  card.appendChild(actions);
  return card;
}

function renderOverviewTab(session) {
  overviewTabContentEl.innerHTML = '';

  const stack = document.createElement('div');
  stack.className = 'panel-stack';

  const draftMode = isOverviewDraftMode(session);
  const card = document.createElement('article');
  card.className = `card overview-card ${draftMode ? 'overview-entry-card' : ''}`.trim();

  const header = document.createElement('div');
  header.className = 'overview-header';

  const titleBlock = document.createElement('div');
  titleBlock.className = 'overview-title-block';

  const title = document.createElement('h2');
  title.textContent = draftMode
    ? session?.id
      ? 'Start a new research session'
      : 'Start your first research session'
    : getSessionDisplayTitle(session);
  titleBlock.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.className = 'muted small';
  subtitle.textContent = draftMode
    ? session?.id
      ? 'The current session stays active until you start this new one.'
      : 'Set a goal, clarify it, and launch your workspace here.'
    : formatSessionTimestamp(session.updatedAt, 'Last updated')
      || formatSessionTimestamp(session.createdAt, 'Created');
  titleBlock.appendChild(subtitle);

  header.appendChild(titleBlock);
  header.appendChild(createOverviewStatusRow(draftMode ? null : session));
  card.appendChild(header);

  const goalBlock = document.createElement('div');
  goalBlock.className = 'overview-goal-block';

  const goalLabelRow = document.createElement('div');
  goalLabelRow.className = 'label-row';

  const goalLabel = document.createElement('div');
  goalLabel.className = 'overview-section-label';
  goalLabel.textContent = 'Research goal';
  goalLabelRow.appendChild(goalLabel);
  goalBlock.appendChild(goalLabelRow);

  const goalStatusRow = createGoalStatusRow(session);
  if (goalStatusRow.childNodes.length > 0) {
    goalBlock.appendChild(goalStatusRow);
  }

  const goalInput = document.createElement('textarea');
  goalInput.id = 'overviewGoalInput';
  goalInput.rows = draftMode ? 4 : 5;
  goalInput.value = goalEditorState.value;
  goalInput.placeholder = 'Example: Understand poverty in Japan';
  goalInput.disabled = clarificationPending || overviewActionPending;
  goalInput.addEventListener('input', (event) => {
    handleOverviewGoalInput(event.target.value);
  });
  goalBlock.appendChild(goalInput);

  if (overviewError) {
    const error = document.createElement('div');
    error.className = 'inline-error';
    error.textContent = overviewError;
    goalBlock.appendChild(error);
  }

  if (!draftMode && goalEditorState.dirty) {
    const note = document.createElement('div');
    note.id = 'overviewGoalHint';
    note.className = 'muted small';
    note.textContent = 'Saving the goal updates the session title and future analysis, but it does not regenerate existing research questions.';
    goalBlock.appendChild(note);
  } else if (!draftMode) {
    const note = document.createElement('div');
    note.id = 'overviewGoalHint';
    note.className = 'muted small hidden';
    note.textContent = 'Saving the goal updates the session title and future analysis, but it does not regenerate existing research questions.';
    goalBlock.appendChild(note);
  }

  card.appendChild(goalBlock);

  if (!draftMode && session?.id) {
    card.appendChild(createSessionStats(session, 'session-stats overview-stats'));
  }

  const actions = document.createElement('div');
  actions.className = 'session-actions overview-actions';

  if (draftMode) {
    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.textContent = overviewActionPending ? 'Starting…' : 'Start session';
    startBtn.disabled = overviewActionPending || clarificationPending;
    startBtn.addEventListener('click', () => {
      void handleStartNewSession();
    });
    actions.appendChild(startBtn);

    const clarifyBtn = document.createElement('button');
    clarifyBtn.type = 'button';
    clarifyBtn.className = 'secondary';
    clarifyBtn.textContent = isClarificationRelevantForCurrentContext() && clarificationState.isGoalConfirmed
      ? 'Re-clarify goal'
      : 'Clarify Goal';
    clarifyBtn.disabled = overviewActionPending || clarificationPending;
    clarifyBtn.addEventListener('click', () => {
      void handleClarifyGoalClick();
    });
    actions.appendChild(clarifyBtn);

    if (session?.id) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'secondary';
      cancelBtn.textContent = 'Back to current session';
      cancelBtn.disabled = overviewActionPending || clarificationPending;
      cancelBtn.addEventListener('click', () => {
        void setNewSessionComposerOpen(false);
      });
      actions.appendChild(cancelBtn);
    }
  } else {
    const primaryBtn = document.createElement('button');
    primaryBtn.type = 'button';
    primaryBtn.textContent = session.status === 'active' ? 'Pause session' : 'Resume session';
    primaryBtn.className = session.status === 'active' ? 'secondary' : '';
    primaryBtn.disabled = overviewActionPending || clarificationPending;
    primaryBtn.addEventListener('click', async () => {
      if (goalEditorState.dirty) {
        window.alert('Save the edited goal before changing the session state.');
        return;
      }

      try {
        await handleCurrentSessionAction(session);
        await refreshState(false);
      } catch (error) {
        window.alert(error.message || 'Failed to update session');
      }
    });
    actions.appendChild(primaryBtn);

    const clarifyBtn = document.createElement('button');
    clarifyBtn.type = 'button';
    clarifyBtn.className = 'secondary';
    clarifyBtn.textContent = isClarificationRelevantForCurrentContext() && clarificationState.isGoalConfirmed
      ? 'Re-clarify goal'
      : 'Clarify Goal';
    clarifyBtn.disabled = overviewActionPending || clarificationPending;
    clarifyBtn.addEventListener('click', () => {
      void handleClarifyGoalClick();
    });
    actions.appendChild(clarifyBtn);

    const saveBtn = document.createElement('button');
    saveBtn.id = 'overviewSaveGoalBtn';
    saveBtn.type = 'button';
    saveBtn.textContent = overviewActionPending ? 'Saving…' : 'Save goal';
    saveBtn.disabled = !goalEditorState.dirty || overviewActionPending || clarificationPending;
    saveBtn.addEventListener('click', () => {
      void handleSaveSessionGoal(session);
    });
    actions.appendChild(saveBtn);
  }

  card.appendChild(actions);

  if (!draftMode && session?.id) {
    const dangerRow = document.createElement('div');
    dangerRow.className = 'overview-danger-row';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete session';
    deleteBtn.disabled = overviewActionPending || clarificationPending;
    deleteBtn.addEventListener('click', async () => {
      try {
        await handleDeleteSession(session.id);
        await refreshState(false);
      } catch (error) {
        window.alert(error.message || 'Failed to delete session');
      }
    });
    dangerRow.appendChild(deleteBtn);
    card.appendChild(dangerRow);
  }

  stack.appendChild(card);

  if (overviewMode === 'clarifying') {
    stack.appendChild(createClarificationCard());
  } else if (overviewMode === 'confirm') {
    stack.appendChild(createClarificationConfirmationCard());
  }

  overviewTabContentEl.appendChild(stack);
}

function renderSettingsTab() {
  settingsTabContentEl.innerHTML = '';

  const stack = document.createElement('div');
  stack.className = 'panel-stack';

  const card = document.createElement('article');
  card.className = 'card settings-card';

  const header = document.createElement('div');
  header.className = 'overview-header';

  const titleBlock = document.createElement('div');
  titleBlock.className = 'overview-title-block';

  const title = document.createElement('h2');
  title.textContent = 'Settings';
  titleBlock.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.className = 'muted small';
  subtitle.textContent = 'Control backend connectivity and panel behavior for research sessions.';
  titleBlock.appendChild(subtitle);

  header.appendChild(titleBlock);

  const statusBadge = createStatusPill(
    backendHealth.checking
      ? 'Checking backend'
      : backendHealth.healthy == null
        ? 'Backend status'
        : backendHealth.healthy
        ? 'Backend online'
        : 'Backend offline',
    backendHealth.checking
      ? 'muted'
      : backendHealth.healthy == null
        ? 'muted'
        : backendHealth.healthy
        ? 'success'
        : 'danger',
  );
  header.appendChild(statusBadge);
  card.appendChild(header);

  const form = document.createElement('div');
  form.className = 'settings-form';

  const backendLabel = document.createElement('label');
  backendLabel.textContent = 'Backend URL';
  form.appendChild(backendLabel);

  const backendInput = document.createElement('input');
  backendInput.type = 'text';
  backendInput.value = settingsDraft.backendUrl;
  backendInput.placeholder = 'http://localhost:8000';
  backendInput.addEventListener('input', (event) => {
    handleSettingsFieldChange('backendUrl', event.target.value);
  });
  form.appendChild(backendInput);

  const statusText = document.createElement('div');
  statusText.className = 'muted small';
  statusText.textContent = backendHealth.healthy
    ? 'AI analysis is available.'
    : backendHealth.error
      ? `Cannot reach backend. ${backendHealth.error}`.trim()
      : 'Save settings to verify the current backend URL.';
  form.appendChild(statusText);

  const fontLabel = document.createElement('label');
  fontLabel.className = 'section-label';
  fontLabel.textContent = 'Font size';
  form.appendChild(fontLabel);

  const fontRow = document.createElement('div');
  fontRow.className = 'row gap-sm settings-range-row';

  const fontInput = document.createElement('input');
  fontInput.type = 'range';
  fontInput.min = '12';
  fontInput.max = '20';
  fontInput.step = '1';
  fontInput.value = String(settingsDraft.uiFontSize);
  fontInput.addEventListener('input', (event) => {
    handleSettingsFieldChange('uiFontSize', normalizeFontSize(event.target.value));
  });
  fontRow.appendChild(fontInput);

  const fontValue = document.createElement('span');
  fontValue.id = 'settingsFontValue';
  fontValue.className = 'small muted';
  fontValue.textContent = `${settingsDraft.uiFontSize}px`;
  fontRow.appendChild(fontValue);

  form.appendChild(fontRow);

  const checkboxLabel = document.createElement('label');
  checkboxLabel.className = 'checkbox-row';

  const autoAnalyzeCheckbox = document.createElement('input');
  autoAnalyzeCheckbox.type = 'checkbox';
  autoAnalyzeCheckbox.checked = Boolean(settingsDraft.autoAnalyze);
  autoAnalyzeCheckbox.addEventListener('change', (event) => {
    handleSettingsFieldChange('autoAnalyze', event.target.checked);
  });
  checkboxLabel.appendChild(autoAnalyzeCheckbox);
  checkboxLabel.appendChild(document.createTextNode('Auto-analyze pages during research sessions'));
  form.appendChild(checkboxLabel);

  const dirtyNote = document.createElement('div');
  dirtyNote.id = 'settingsDirtyNote';
  dirtyNote.className = `muted small ${settingsDraftDirty ? '' : 'hidden'}`.trim();
  dirtyNote.textContent = 'Save settings to apply the updated backend URL and defaults.';
  form.appendChild(dirtyNote);

  const actions = document.createElement('div');
  actions.className = 'session-actions overview-actions';

  const saveBtn = document.createElement('button');
  saveBtn.id = 'settingsSaveBtn';
  saveBtn.type = 'button';
  saveBtn.textContent = settingsDraftDirty ? 'Save settings' : 'Saved';
  saveBtn.disabled = !settingsDraftDirty && !backendHealth.error;
  saveBtn.addEventListener('click', () => {
    void handleSaveSettings();
  });
  actions.appendChild(saveBtn);

  const refreshBtn = document.createElement('button');
  refreshBtn.id = 'settingsRefreshBtn';
  refreshBtn.type = 'button';
  refreshBtn.className = 'secondary';
  refreshBtn.textContent = 'Check connection';
  refreshBtn.disabled = backendHealth.checking || settingsDraftDirty;
  refreshBtn.addEventListener('click', () => {
    void refreshBackendHealth();
  });
  actions.appendChild(refreshBtn);

  form.appendChild(actions);
  card.appendChild(form);
  stack.appendChild(card);
  settingsTabContentEl.appendChild(stack);
}

function syncInsightsToolbar(hasInsights) {
  groupedInsightsBtn.classList.toggle('active', insightsViewMode === 'grouped');
  timelineInsightsBtn.classList.toggle('active', insightsViewMode === 'timeline');
  groupedInsightsBtn.setAttribute('aria-selected', String(insightsViewMode === 'grouped'));
  timelineInsightsBtn.setAttribute('aria-selected', String(insightsViewMode === 'timeline'));
  groupedInsightsBtn.disabled = hasInsights && !groupedViewAvailable;
}

function setInsightsNotice(message) {
  insightsNoticeEl.textContent = message || '';
  insightsNoticeEl.classList.toggle('hidden', !message);
}

function insightKey(insight) {
  return `${insight.topic || ''}::${insight.summary || ''}`;
}

function buildFallbackTimeline(insights) {
  return orderTimelineNewestFirst(
    [...(Array.isArray(insights) ? insights : [])]
    .map((insight, index) => {
      const addedAt = insight?.addedAt || insight?.sources?.[0]?.analyzedAt || '';
      const addedAtMs = Date.parse(addedAt);
      return {
        original: insight,
        key: insightKey(insight),
        index,
        addedAt,
        addedAtMs: Number.isFinite(addedAtMs) ? addedAtMs : null,
        tags: insight?.topic ? [insight.topic] : [],
      };
    }),
  );
}

function orderTimelineNewestFirst(items) {
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    if (left?.addedAtMs != null && right?.addedAtMs != null) {
      return right.addedAtMs - left.addedAtMs || (right.index || 0) - (left.index || 0);
    }
    if (left?.addedAtMs != null) return -1;
    if (right?.addedAtMs != null) return 1;
    return (right?.index || 0) - (left?.index || 0);
  });
}

function createTag(text, className = '') {
  const tag = document.createElement('span');
  tag.className = `topic-tag ${className}`.trim();
  tag.textContent = text;
  return tag;
}

function renderInsightSourceLine(card, insight) {
  const insightSources = Array.isArray(insight?.sources) ? insight.sources : [];
  if (!insightSources.length) return;

  const sourceRow = document.createElement('div');
  sourceRow.className = 'muted small source-line';
  sourceRow.appendChild(document.createTextNode(`Source${insightSources.length > 1 ? 's' : ''}: `));

  const firstSource = insightSources[0];
  const label = firstSource?.title || firstSource?.domain || firstSource?.url || 'Untitled source';

  if (firstSource?.url) {
    const link = document.createElement('a');
    link.href = firstSource.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = label;
    sourceRow.appendChild(link);
  } else {
    sourceRow.appendChild(document.createTextNode(label));
  }

  if (insightSources.length > 1) {
    sourceRow.appendChild(document.createTextNode(` +${insightSources.length - 1} more`));
  }

  card.appendChild(sourceRow);
}

function createInsightCard(item, highlightNew) {
  const insight = item.original || item;
  const key = item.key || insightKey(insight);
  const card = document.createElement('div');
  card.className = 'card insight-card';

  if (highlightedInsightKeys.has(key) || (highlightNew && !previousInsightKeys.has(key))) {
    card.classList.add('insight-new');
  }

  const header = document.createElement('div');
  header.className = 'insight-card-header';

  const meta = document.createElement('div');
  meta.className = 'insight-card-meta';

  const captured = document.createElement('span');
  captured.className = 'muted small';
  captured.textContent = formatCapturedAt(item.addedAt || insight.addedAt || insight.sources?.[0]?.analyzedAt);
  meta.appendChild(captured);

  if (insight.relevance) {
    const relevance = document.createElement('span');
    relevance.className = 'relevance-pill';
    relevance.textContent = insight.relevance;
    meta.appendChild(relevance);
  }

  header.appendChild(meta);
  card.appendChild(header);

  const summary = document.createElement('div');
  summary.className = 'insight-summary';
  summary.textContent = insight.summary || 'No summary available yet.';
  card.appendChild(summary);

  const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean) : [];
  if (tags.length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    for (const tag of tags) {
      tagRow.appendChild(createTag(tag));
    }
    card.appendChild(tagRow);
  }

  if (insight.evidence) {
    const evidence = document.createElement('div');
    evidence.className = 'muted small';
    evidence.textContent = `Evidence: ${insight.evidence}`;
    card.appendChild(evidence);
  }

  renderInsightSourceLine(card, insight);
  return card;
}

function syncOpenClustersState() {
  syncCurrentSessionUiState({ openClusterIds: [...openClusterIds] });
}

function ensureOpenClusters(clusters, highlightNew) {
  const validClusterIds = new Set(clusters.map((cluster) => cluster.id));
  const nextOpenClusterIds = new Set([...openClusterIds].filter((id) => validClusterIds.has(id)));

  if (highlightNew) {
    for (const cluster of clusters) {
      if (cluster.insights.some((item) => !previousInsightKeys.has(item.key))) {
        nextOpenClusterIds.add(cluster.id);
      }
    }
  }

  const changed = nextOpenClusterIds.size !== openClusterIds.size
    || [...nextOpenClusterIds].some((id) => !openClusterIds.has(id));

  openClusterIds = nextOpenClusterIds;

  if (changed) {
    syncOpenClustersState();
  }
}

function renderTimeline(timeline, highlightNew) {
  const list = document.createElement('div');
  list.className = 'timeline-list';

  for (const item of timeline) {
    list.appendChild(createInsightCard(item, highlightNew));
  }

  insightsListEl.appendChild(list);
}

function renderGroupedInsights(clusters, highlightNew) {
  const list = document.createElement('div');
  list.className = 'cluster-list';

  ensureOpenClusters(clusters, highlightNew);

  for (const cluster of clusters) {
    const article = document.createElement('article');
    article.className = 'card topic-cluster';

    const isOpen = openClusterIds.has(cluster.id);
    article.classList.toggle('cluster-open', isOpen);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'cluster-toggle';
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-controls', `${cluster.id}-panel`);

    const headerMain = document.createElement('div');
    headerMain.className = 'cluster-header-main';

    const titleRow = document.createElement('div');
    titleRow.className = 'cluster-title-row';

    const title = document.createElement('strong');
    title.textContent = cluster.title;
    titleRow.appendChild(title);

    const count = document.createElement('span');
    count.className = 'cluster-count';
    count.textContent = `${cluster.insightCount} insight${cluster.insightCount === 1 ? '' : 's'}`;
    titleRow.appendChild(count);

    headerMain.appendChild(titleRow);

    if (cluster.summary) {
      const preview = document.createElement('div');
      preview.className = 'muted small';
      preview.textContent = cluster.summary;
      headerMain.appendChild(preview);
    }

    toggle.appendChild(headerMain);

    const chevron = document.createElement('span');
    chevron.className = 'cluster-chevron';
    chevron.textContent = isOpen ? '▾' : '▸';
    toggle.appendChild(chevron);

    const panel = document.createElement('div');
    panel.id = `${cluster.id}-panel`;
    panel.className = 'cluster-panel';
    panel.classList.toggle('is-open', isOpen);

    const panelInner = document.createElement('div');
    panelInner.className = 'cluster-panel-inner';

    const body = document.createElement('div');
    body.className = 'cluster-body';

    const reason = document.createElement('div');
    reason.className = 'cluster-reason muted small';
    reason.textContent = cluster.reasonText;
    body.appendChild(reason);

    if (cluster.sharedTags.length) {
      const sharedTagRow = document.createElement('div');
      sharedTagRow.className = 'tag-row';
      for (const tag of cluster.sharedTags) {
        sharedTagRow.appendChild(createTag(tag, 'shared'));
      }
      body.appendChild(sharedTagRow);
    }

    const insightList = document.createElement('div');
    insightList.className = 'cluster-insights';
    for (const item of cluster.insights) {
      insightList.appendChild(createInsightCard(item, highlightNew));
    }
    body.appendChild(insightList);

    panelInner.appendChild(body);
    panel.appendChild(panelInner);

    toggle.addEventListener('click', () => {
      const nextOpen = !panel.classList.contains('is-open');
      panel.classList.toggle('is-open', nextOpen);
      article.classList.toggle('cluster-open', nextOpen);
      toggle.setAttribute('aria-expanded', String(nextOpen));
      chevron.textContent = nextOpen ? '▾' : '▸';

      if (nextOpen) {
        openClusterIds.add(cluster.id);
      } else {
        openClusterIds.delete(cluster.id);
      }

      syncOpenClustersState();
    });

    article.appendChild(toggle);
    article.appendChild(panel);
    list.appendChild(article);
  }

  insightsListEl.appendChild(list);
}

function renderEmptyInsightsState() {
  insightsListEl.innerHTML = '';

  const empty = document.createElement('div');
  empty.className = 'card insights-empty muted';
  empty.textContent = 'No insights captured yet. Analyze relevant pages and they will appear here as topic clusters or a timeline.';
  insightsListEl.appendChild(empty);
}

function renderInsights(insights, highlightNew) {
  insightsListEl.innerHTML = '';

  const hasInsights = Array.isArray(insights) && insights.length > 0;
  let notice = '';
  let presentation = { clusters: [], timeline: buildFallbackTimeline(insights) };
  let isFallback = false;

  if (hasInsights && insightGroupingApi?.prepareInsightViewModel) {
    try {
      presentation = insightGroupingApi.prepareInsightViewModel(insights);
      presentation.timeline = orderTimelineNewestFirst(presentation.timeline);
      groupedViewAvailable = presentation.clusters.length > 0;
      if (!groupedViewAvailable) {
        notice = 'Showing timeline because topic grouping did not produce any usable clusters for these insights.';
        isFallback = true;
      }
    } catch (error) {
      groupedViewAvailable = false;
      notice = 'Showing timeline because topic grouping could not be built for these insights.';
      isFallback = true;
      console.error('Failed to build grouped insights view', error);
    }
  } else {
    groupedViewAvailable = !hasInsights || Boolean(insightGroupingApi?.prepareInsightViewModel);
    if (hasInsights && !insightGroupingApi?.prepareInsightViewModel) {
      notice = 'Showing timeline because the topic-grouping helper is unavailable.';
      isFallback = true;
    }
  }

  if (insightsViewMode === 'grouped' && !groupedViewAvailable && hasInsights) {
    insightsViewMode = 'timeline';
    forcedTimelineFallback = true;
  } else if (groupedViewAvailable && forcedTimelineFallback && insightsViewMode === 'timeline') {
    insightsViewMode = 'grouped';
    forcedTimelineFallback = false;
  }

  syncInsightsToolbar(hasInsights);
  setInsightsNotice(isFallback ? notice : '');

  if (!hasInsights) {
    insightsMetaEl.textContent = 'Topic clusters will appear here as you collect insights.';
    renderEmptyInsightsState();
    previousInsightKeys = new Set();
    return;
  }

  if (insightsViewMode === 'grouped' && groupedViewAvailable) {
    insightsMetaEl.textContent = `${presentation.clusters.length} topic cluster${presentation.clusters.length === 1 ? '' : 's'}`;
    renderGroupedInsights(presentation.clusters, highlightNew);
  } else {
    insightsMetaEl.textContent = `${presentation.timeline.length} insight${presentation.timeline.length === 1 ? '' : 's'}, newest first`;
    renderTimeline(presentation.timeline, highlightNew);
  }

  previousInsightKeys = new Set(insights.map(insightKey));

}

function renderInsightsTab(session, highlightNew) {
  renderInsights(session?.insights, highlightNew);
}

function renderQuestionsTab(session) {
  questionsTabContentEl.innerHTML = '';

  const stack = document.createElement('div');
  stack.className = 'panel-stack';

  if (!session?.id) {
    stack.appendChild(
      createEmptyStateCard(
        'Questions and missing topics will appear here once you start or reopen a research session.',
        {
          actionLabel: 'New session',
          onAction: () => {
            void setNewSessionComposerOpen(true);
          },
        },
      ),
    );
    questionsTabContentEl.appendChild(stack);
    return;
  }

  const questions = getResearchQuestions(session);
  const questionsSection = createSectionBlock('Research Questions', pluralize(questions.length, 'question'));
  const questionsList = document.createElement('div');
  questionsList.className = 'compact-list';

  if (!questions.length) {
    questionsList.appendChild(createEmptyStateCard('No research questions saved for this session.'));
  } else {
    for (const question of questions) {
      questionsList.appendChild(createQuestionCard(question, getQuestionCoverageState(question, session)));
    }
  }

  questionsSection.appendChild(questionsList);
  stack.appendChild(questionsSection);

  const standaloneMissingTopics = getStandaloneMissingTopics(session);
  const missingSection = createSectionBlock(
    'Missing Topics',
    pluralize(standaloneMissingTopics.length, 'topic'),
  );
  const missingList = document.createElement('div');
  missingList.className = 'compact-list';

  if (!standaloneMissingTopics.length) {
    missingList.appendChild(
      createEmptyStateCard('No additional uncovered topics are flagged beyond the tracked questions.'),
    );
  } else {
    for (const topic of standaloneMissingTopics) {
      missingList.appendChild(createMissingTopicCard(topic));
    }
  }

  missingSection.appendChild(missingList);
  stack.appendChild(missingSection);
  questionsTabContentEl.appendChild(stack);
}

function renderSourcesTab(session) {
  sourcesTabContentEl.innerHTML = '';

  const stack = document.createElement('div');
  stack.className = 'panel-stack';

  if (!session?.id) {
    stack.appendChild(
      createEmptyStateCard(
        'Sources will appear here once you start or reopen a research session.',
        {
          actionLabel: 'New session',
          onAction: () => {
            void setNewSessionComposerOpen(true);
          },
        },
      ),
    );
    sourcesTabContentEl.appendChild(stack);
    return;
  }

  const sources = Array.isArray(session?.sources) ? session.sources : [];
  const sourcesSection = createSectionBlock('Sources', pluralize(sources.length, 'source'));
  const sourceList = document.createElement('div');
  sourceList.className = 'compact-list';

  if (!sources.length) {
    sourceList.appendChild(createEmptyStateCard('No sources analyzed yet.'));
  } else {
    for (const source of sources) {
      sourceList.appendChild(createSourceCard(source));
    }
  }

  sourcesSection.appendChild(sourceList);
  stack.appendChild(sourcesSection);
  sourcesTabContentEl.appendChild(stack);
}

function renderSession(session, highlightNew = true) {
  const previousSessionId = currentSession?.id || null;
  const shouldHoldOverview = selectedTab === 'overview'
    && goalEditorState.dirty
    && previousSessionId
    && session?.id
    && previousSessionId === session.id;
  const shouldHoldSettings = selectedTab === 'settings' && settingsDraftDirty;

  currentSession = session || null;

  renderTabBar();
  if (!shouldHoldOverview) {
    renderOverviewTab(session);
  }
  renderInsightsTab(session, highlightNew);
  renderQuestionsTab(session);
  renderSourcesTab(session);
  if (!shouldHoldSettings) {
    renderSettingsTab();
  }
}

async function syncSidebarState(state) {
  const normalizedSettings = normalizeSettings(state?.settings);
  currentSettings = normalizedSettings;

  if (!settingsDraftDirty || settingsAreEqual(settingsDraft, normalizedSettings)) {
    settingsDraft = { ...normalizedSettings };
    settingsDraftDirty = false;
  }

  if (!state?.session?.id) {
    newSessionComposerOpen = true;
  }

  await queueContextSync(state?.session || null);
}

function applySessionState(state, highlightNew = true) {
  const nextSession = state?.session || null;
  const nextCurrentSessionId = state?.currentSessionId || nextSession?.id || null;
  const isSameSession = Boolean(currentSession?.id && nextSession?.id && currentSession.id === nextSession.id);

  if (!isSameSession) {
    previousInsightKeys = new Set((nextSession?.insights || []).map(insightKey));
    const nextUiState = getStoredSessionUiState(nextCurrentSessionId);
    selectedTab = nextCurrentSessionId ? nextUiState.selectedTab : DEFAULT_TAB;
    insightsViewMode = nextCurrentSessionId ? nextUiState.insightsViewMode : DEFAULT_INSIGHTS_VIEW;
    openClusterIds = new Set(nextCurrentSessionId ? nextUiState.openClusterIds : []);
    highlightedInsightKeys = new Set();
    forcedTimelineFallback = false;
  } else {
    const nextInsightKeys = new Set((nextSession?.insights || []).map(insightKey));
    const addedKeys = [...nextInsightKeys].filter((key) => !previousInsightKeys.has(key));
    if (addedKeys.length) {
      highlightedInsightKeys = new Set(addedKeys);
    }
  }

  allSessions = Array.isArray(state?.allSessions) ? state.allSessions.filter(Boolean) : [];
  currentSessionId = nextCurrentSessionId;
  renderSessionSwitcher(allSessions, nextCurrentSessionId);
  renderSession(nextSession, highlightNew && isSameSession);
}

async function refreshState(highlightNew = true) {
  const state = await getBestAvailableState();
  await syncSidebarState(state);
  applySessionState(state, highlightNew);
}

function scheduleRefreshState(highlightNew = false) {
  if (scheduledRefreshHandle != null) {
    return;
  }

  scheduledRefreshHandle = setTimeout(async () => {
    scheduledRefreshHandle = null;
    try {
      await refreshState(highlightNew);
    } catch (error) {
      console.error('Failed to refresh sidebar state', error);
    }
  }, 0);
}

for (const button of tabButtons) {
  button.addEventListener('click', () => {
    setActiveTab(button.dataset.tab);
  });
}

sessionSwitcherBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  setSessionMenuOpen(!sessionMenuOpen);
});

document.addEventListener('click', (event) => {
  if (!sessionMenuOpen) return;
  if (sessionSwitcherSectionEl?.contains(event.target)) return;
  setSessionMenuOpen(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (sessionMenuOpen) {
    setSessionMenuOpen(false);
  }
  if (newSessionComposerOpen && currentSession?.id) {
    void setNewSessionComposerOpen(false);
  }
});

groupedInsightsBtn.addEventListener('click', () => {
  if (!groupedViewAvailable) return;
  forcedTimelineFallback = false;
  insightsViewMode = 'grouped';
  syncCurrentSessionUiState({ insightsViewMode, openClusterIds: [...openClusterIds] });
  renderInsights(currentSession?.insights, false);
});

timelineInsightsBtn.addEventListener('click', () => {
  forcedTimelineFallback = false;
  insightsViewMode = 'timeline';
  syncCurrentSessionUiState({ insightsViewMode, openClusterIds: [...openClusterIds] });
  renderInsights(currentSession?.insights, false);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SESSION_UPDATED') {
    void (async () => {
      await syncSidebarState(message.payload);
      applySessionState(message.payload, true);
    })();
    return;
  }

  if (message.type === 'SETTINGS_UPDATED') {
    const nextSettings = normalizeSettings(message.payload);
    currentSettings = nextSettings;
    if (!settingsDraftDirty || settingsAreEqual(settingsDraft, nextSettings)) {
      settingsDraft = { ...nextSettings };
      settingsDraftDirty = false;
    }
    applyFontSize(nextSettings.uiFontSize);
    renderOverviewTab(currentSession);
    renderSettingsTab();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  const shouldRefresh = Object.keys(changes).some((key) => RELEVANT_STORAGE_KEYS.has(key));
  if (!shouldRefresh) return;

  scheduleRefreshState(false);
});

window.addEventListener('focus', () => {
  scheduleRefreshState(false);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    scheduleRefreshState(false);
  }
});

async function initializeSidebar() {
  await loadSidebarUiState();
  const state = await getBestAvailableState();
  const { session, settings } = state;
  applyFontSize(normalizeFontSize(settings?.uiFontSize));
  previousInsightKeys = new Set((session?.insights || []).map(insightKey));
  await syncSidebarState(state);
  applySessionState(state, false);
  void refreshBackendHealth();

  if (session?.insights?.length) {
    requestAnimationFrame(() => {
      renderInsightsTab(currentSession, false);
    });
  }
}

initializeSidebar().catch((error) => {
  console.error('Failed to initialize sidebar', error);
});
