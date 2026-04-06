const insightGroupingApi = globalThis.ResearchCopilotInsightGrouping;

const SIDEBAR_UI_STATE_KEY = 'sidebarUiState';
const DEFAULT_TAB = 'overview';
const DEFAULT_INSIGHTS_VIEW = 'grouped';
const VALID_TABS = new Set(['overview', 'insights', 'questions', 'sources']);
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

const updatedAtEl = document.getElementById('updatedAt');
const sessionSwitcherSectionEl = document.querySelector('.session-switcher-section');
const sessionSwitcherBtn = document.getElementById('sessionSwitcherBtn');
const sessionSwitcherLabelEl = document.getElementById('sessionSwitcherLabel');
const sessionSwitcherMetaEl = document.getElementById('sessionSwitcherMeta');
const sessionDropdownMenuEl = document.getElementById('sessionDropdownMenu');
const newSessionComposerEl = document.getElementById('newSessionComposer');
const newSessionGoalInputEl = document.getElementById('newSessionGoalInput');
const newSessionErrorEl = document.getElementById('newSessionError');
const startNewSessionBtn = document.getElementById('startNewSessionBtn');
const cancelNewSessionBtn = document.getElementById('cancelNewSessionBtn');
const overviewTabContentEl = document.getElementById('overviewTabContent');
const questionsTabContentEl = document.getElementById('questionsTabContent');
const sourcesTabContentEl = document.getElementById('sourcesTabContent');
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
};

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

function clearNewSessionError() {
  setTextContent(newSessionErrorEl, '');
  newSessionErrorEl.classList.add('hidden');
}

function setNewSessionError(message) {
  setTextContent(newSessionErrorEl, message);
  newSessionErrorEl.classList.toggle('hidden', !message);
}

function setNewSessionComposerOpen(isOpen) {
  newSessionComposerEl.classList.toggle('hidden', !isOpen);
  if (!isOpen) {
    newSessionGoalInputEl.value = '';
    clearNewSessionError();
    setNewSessionSubmitting(false);
    return;
  }

  setSessionMenuOpen(false);
  queueMicrotask(() => {
    newSessionGoalInputEl.focus();
  });
}

function setNewSessionSubmitting(isSubmitting) {
  startNewSessionBtn.disabled = isSubmitting;
  cancelNewSessionBtn.disabled = isSubmitting;
  newSessionGoalInputEl.disabled = isSubmitting;
  setTextContent(startNewSessionBtn, isSubmitting ? 'Starting…' : 'Start session');
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
  await sendMessage('DELETE_SESSION', { sessionId });
}

async function handleStartNewSession() {
  const goal = newSessionGoalInputEl.value.trim();
  if (!goal) {
    setNewSessionError('Please enter a research goal first.');
    return;
  }

  clearNewSessionError();
  setNewSessionSubmitting(true);

  try {
    const session = await sendMessage('START_SESSION', { goal });
    updateSessionUiState(session?.id, createDefaultSessionUiState());
    selectedTab = DEFAULT_TAB;
    insightsViewMode = DEFAULT_INSIGHTS_VIEW;
    openClusterIds = new Set();
    forcedTimelineFallback = false;
    setNewSessionComposerOpen(false);
    await refreshState(false);
  } catch (error) {
    setNewSessionSubmitting(false);
    setNewSessionError(error.message || 'Failed to start session.');
  }
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
    if (!session?.id || session.id === activeId) return;

    try {
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
    setNewSessionComposerOpen(true);
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

function renderOverviewTab(session) {
  overviewTabContentEl.innerHTML = '';

  const stack = document.createElement('div');
  stack.className = 'panel-stack';

  if (!session?.id) {
    stack.appendChild(
      createEmptyStateCard(
        'No research session is selected. Use the session menu to start one or reopen a past workspace.',
        {
          actionLabel: 'New session',
          onAction: () => setNewSessionComposerOpen(true),
        },
      ),
    );
    overviewTabContentEl.appendChild(stack);
    return;
  }

  const card = document.createElement('article');
  card.className = 'card overview-card';

  const header = document.createElement('div');
  header.className = 'overview-header';

  const titleBlock = document.createElement('div');
  titleBlock.className = 'overview-title-block';

  const title = document.createElement('h2');
  title.textContent = getSessionDisplayTitle(session);
  titleBlock.appendChild(title);

  const updated = document.createElement('div');
  updated.className = 'muted small';
  updated.textContent = formatSessionTimestamp(session.updatedAt, 'Last updated')
    || formatSessionTimestamp(session.createdAt, 'Created');
  titleBlock.appendChild(updated);

  header.appendChild(titleBlock);
  header.appendChild(createStatusPill(getSessionStatusLabel(session), getSessionStatusClass(session)));
  card.appendChild(header);

  const goalBlock = document.createElement('div');
  goalBlock.className = 'overview-goal-block';

  const goalLabel = document.createElement('div');
  goalLabel.className = 'overview-section-label';
  goalLabel.textContent = 'Goal';
  goalBlock.appendChild(goalLabel);

  const goalText = document.createElement('p');
  goalText.className = 'overview-goal';
  goalText.textContent = session.goal || 'No goal saved yet.';
  goalBlock.appendChild(goalText);

  card.appendChild(goalBlock);
  card.appendChild(createSessionStats(session, 'session-stats overview-stats'));

  const actions = document.createElement('div');
  actions.className = 'session-actions overview-actions';

  const primaryBtn = document.createElement('button');
  primaryBtn.type = 'button';
  primaryBtn.textContent = session.status === 'active' ? 'Pause session' : 'Resume session';
  if (session.status === 'active') {
    primaryBtn.className = 'secondary';
  }
  primaryBtn.addEventListener('click', async () => {
    try {
      await handleCurrentSessionAction(session);
      await refreshState(false);
    } catch (error) {
      window.alert(error.message || 'Failed to update session');
    }
  });
  actions.appendChild(primaryBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    try {
      await handleDeleteSession(session.id);
      await refreshState(false);
    } catch (error) {
      window.alert(error.message || 'Failed to delete session');
    }
  });
  actions.appendChild(deleteBtn);

  card.appendChild(actions);
  stack.appendChild(card);
  overviewTabContentEl.appendChild(stack);
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
          onAction: () => setNewSessionComposerOpen(true),
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
          onAction: () => setNewSessionComposerOpen(true),
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
  currentSession = session || null;
  setTextContent(
    updatedAtEl,
    session?.updatedAt
      ? formatSessionTimestamp(session.updatedAt, 'Last updated')
      : '',
  );

  renderTabBar();
  renderOverviewTab(session);
  renderInsightsTab(session, highlightNew);
  renderQuestionsTab(session);
  renderSourcesTab(session);
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

  currentSessionId = nextCurrentSessionId;
  renderSessionSwitcher(state?.allSessions, nextCurrentSessionId);
  renderSession(nextSession, highlightNew && isSameSession);
}

async function refreshState(highlightNew = true) {
  const state = await getBestAvailableState();
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

startNewSessionBtn.addEventListener('click', handleStartNewSession);
cancelNewSessionBtn.addEventListener('click', () => {
  setNewSessionComposerOpen(false);
});

newSessionGoalInputEl.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    handleStartNewSession();
  }
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
  if (!newSessionComposerEl.classList.contains('hidden')) {
    setNewSessionComposerOpen(false);
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
    applySessionState(message.payload, true);
    return;
  }

  if (message.type === 'SETTINGS_UPDATED') {
    applyFontSize(normalizeFontSize(message.payload?.uiFontSize));
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
  applySessionState(state, false);

  if (session?.insights?.length) {
    requestAnimationFrame(() => {
      renderInsightsTab(currentSession, false);
    });
  }
}

initializeSidebar().catch((error) => {
  console.error('Failed to initialize sidebar', error);
});
