const insightGroupingApi = globalThis.ResearchCopilotInsightGrouping;

let previousInsightKeys = new Set();
let currentSession = null;
let currentSessionId = null;
let insightsViewMode = 'grouped';
let groupedViewAvailable = Boolean(insightGroupingApi?.prepareInsightViewModel);
let openClusterIds = new Set();
let forcedTimelineFallback = false;

const currentSessionSummaryEl = document.getElementById('currentSessionSummary');
const pastSessionsListEl = document.getElementById('pastSessionsList');
const pastSessionsMetaEl = document.getElementById('pastSessionsMeta');
const groupedInsightsBtn = document.getElementById('groupedInsightsBtn');
const timelineInsightsBtn = document.getElementById('timelineInsightsBtn');
const insightsMetaEl = document.getElementById('insightsMeta');
const insightsNoticeEl = document.getElementById('insightsNotice');

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

function renderList(id, items, emptyText) {
  const el = document.getElementById(id);
  el.innerHTML = '';

  if (!items?.length) {
    el.innerHTML = `<li class="muted">${emptyText}</li>`;
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = typeof item === 'string' ? item : JSON.stringify(item);
    el.appendChild(li);
  }
}

function insightKey(insight) {
  return `${insight.topic || ''}::${insight.summary || ''}`;
}

function normalizeFontSize(value) {
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num)) return 14;
  return Math.min(20, Math.max(12, num));
}

function applyFontSize(sizePx) {
  document.documentElement.style.setProperty('--ui-font-size', `${sizePx}px`);
}

function getResearchQuestions(session) {
  if (Array.isArray(session?.researchQuestions)) return session.researchQuestions;
  if (Array.isArray(session?.questions)) return session.questions;
  return [];
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

function buildFallbackTimeline(insights) {
  return [...(Array.isArray(insights) ? insights : [])]
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
    })
    .sort((a, b) => {
      if (a.addedAtMs != null && b.addedAtMs != null) {
        return a.addedAtMs - b.addedAtMs || a.index - b.index;
      }
      if (a.addedAtMs != null) return -1;
      if (b.addedAtMs != null) return 1;
      return a.index - b.index;
    });
}

function createTag(text, className = '') {
  const tag = document.createElement('span');
  tag.className = `topic-tag ${className}`.trim();
  tag.textContent = text;
  return tag;
}

function renderInsightSourceLine(card, insight) {
  const insightSources = Array.isArray(insight.sources) ? insight.sources : [];
  if (!insightSources.length) return;

  const sourceRow = document.createElement('div');
  sourceRow.className = 'muted small source-line';
  sourceRow.appendChild(document.createTextNode(`Source${insightSources.length > 1 ? 's' : ''}: `));

  const firstSource = insightSources[0];
  const link = document.createElement('a');
  link.href = firstSource.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = firstSource.title || firstSource.domain || firstSource.url;
  sourceRow.appendChild(link);

  if (insightSources.length > 1) {
    sourceRow.appendChild(document.createTextNode(` +${insightSources.length - 1} more`));
  }

  card.appendChild(sourceRow);
}

function createInsightCard(item, highlightNew) {
  const insight = item.original || item;
  const card = document.createElement('div');
  card.className = 'card insight-card';

  if (highlightNew && !previousInsightKeys.has(item.key || insightKey(insight))) {
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

function ensureOpenClusters(clusters, highlightNew) {
  const validClusterIds = new Set(clusters.map((cluster) => cluster.id));
  openClusterIds = new Set([...openClusterIds].filter((id) => validClusterIds.has(id)));

  if (highlightNew) {
    for (const cluster of clusters) {
      if (cluster.insights.some((item) => !previousInsightKeys.has(item.key))) {
        openClusterIds.add(cluster.id);
      }
    }
  }

  if (!openClusterIds.size && clusters.length) {
    openClusterIds.add(clusters[0].id);
  }
}

function renderTimeline(timeline, highlightNew) {
  const el = document.getElementById('insightsList');
  const list = document.createElement('div');
  list.className = 'timeline-list';

  for (const item of timeline) {
    list.appendChild(createInsightCard(item, highlightNew));
  }

  el.appendChild(list);
}

function renderGroupedInsights(clusters, highlightNew) {
  const el = document.getElementById('insightsList');
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

    const preview = document.createElement('div');
    preview.className = 'muted small';
    preview.textContent = cluster.summary;
    headerMain.appendChild(preview);

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

    const summary = document.createElement('p');
    summary.className = 'cluster-summary';
    summary.textContent = cluster.summary;
    body.appendChild(summary);

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
    });

    article.appendChild(toggle);
    article.appendChild(panel);
    list.appendChild(article);
  }

  el.appendChild(list);
}

function renderEmptyInsightsState() {
  const el = document.getElementById('insightsList');
  el.innerHTML = '';

  const empty = document.createElement('div');
  empty.className = 'card insights-empty muted';
  empty.textContent = 'No insights captured yet. Analyze relevant pages and they will appear here as topic clusters or a timeline.';
  el.appendChild(empty);
}

function renderInsights(insights, highlightNew) {
  const el = document.getElementById('insightsList');
  el.innerHTML = '';

  const hasInsights = Array.isArray(insights) && insights.length > 0;
  let notice = '';
  let presentation = { clusters: [], timeline: buildFallbackTimeline(insights) };
  let isFallback = false;

  if (hasInsights && insightGroupingApi?.prepareInsightViewModel) {
    try {
      presentation = insightGroupingApi.prepareInsightViewModel(insights);
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
    insightsMetaEl.textContent = `${presentation.timeline.length} insight${presentation.timeline.length === 1 ? '' : 's'} in collection order`;
    renderTimeline(presentation.timeline, highlightNew);
  }

  previousInsightKeys = new Set(insights.map(insightKey));
}

function renderSessionStats(container, session) {
  const stats = document.createElement('div');
  stats.className = 'session-stats';

  const items = [
    `${getResearchQuestions(session).length} question${getResearchQuestions(session).length === 1 ? '' : 's'}`,
    `${(session?.insights || []).length} insight${(session?.insights || []).length === 1 ? '' : 's'}`,
    `${(session?.sources || []).length} source${(session?.sources || []).length === 1 ? '' : 's'}`,
  ];

  for (const label of items) {
    const stat = document.createElement('span');
    stat.className = 'session-stat';
    stat.textContent = label;
    stats.appendChild(stat);
  }

  container.appendChild(stats);
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

function renderCurrentSessionSummary(session) {
  currentSessionSummaryEl.innerHTML = '';

  if (!session?.id) {
    currentSessionSummaryEl.innerHTML = `
      <div class="card muted">
        No current session selected. Start a new session from the popup or reopen one from Past Sessions.
      </div>
    `;
    return;
  }

  const card = document.createElement('article');
  card.className = 'card session-card current-session-card';

  const header = document.createElement('div');
  header.className = 'session-card-header';

  const titleBlock = document.createElement('div');

  const title = document.createElement('strong');
  title.textContent = session.title || session.goal || 'Untitled research session';
  titleBlock.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'muted small';
  meta.textContent = formatSessionTimestamp(session.updatedAt) || formatSessionTimestamp(session.createdAt, 'Created');
  titleBlock.appendChild(meta);

  header.appendChild(titleBlock);

  const status = document.createElement('span');
  status.className = `status-pill ${getSessionStatusClass(session)}`;
  status.textContent = getSessionStatusLabel(session);
  header.appendChild(status);

  card.appendChild(header);

  const goal = document.createElement('p');
  goal.className = 'session-goal muted';
  goal.textContent = session.goal || 'No goal saved yet.';
  card.appendChild(goal);

  renderSessionStats(card, session);

  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const primaryBtn = document.createElement('button');
  primaryBtn.type = 'button';
  primaryBtn.className = 'secondary session-action-btn';
  primaryBtn.textContent = session.status === 'active' ? 'Pause' : 'Resume';
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
  deleteBtn.className = 'danger session-action-btn';
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
  currentSessionSummaryEl.appendChild(card);
}

function renderPastSessions(allSessions, activeId) {
  const sessions = (Array.isArray(allSessions) ? allSessions : []).filter((session) => session?.id !== activeId);
  pastSessionsMetaEl.textContent = sessions.length
    ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}`
    : '';

  pastSessionsListEl.innerHTML = '';

  if (!sessions.length) {
    pastSessionsListEl.innerHTML = `
      <div class="card muted">
        Past sessions will appear here after you start a new research session.
      </div>
    `;
    return;
  }

  for (const session of sessions) {
    const item = document.createElement('article');
    item.className = 'card session-card past-session-card';

    const header = document.createElement('div');
    header.className = 'session-card-header';

    const titleBlock = document.createElement('div');

    const title = document.createElement('strong');
    title.textContent = session.title || session.goal || 'Untitled research session';
    titleBlock.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'muted small';
    meta.textContent = formatSessionTimestamp(session.updatedAt) || formatSessionTimestamp(session.createdAt, 'Created');
    titleBlock.appendChild(meta);

    header.appendChild(titleBlock);

    const status = document.createElement('span');
    status.className = `status-pill ${getSessionStatusClass(session)}`;
    status.textContent = getSessionStatusLabel(session);
    header.appendChild(status);

    item.appendChild(header);

    const goal = document.createElement('p');
    goal.className = 'session-goal muted';
    goal.textContent = session.goal || 'No goal saved yet.';
    item.appendChild(goal);

    renderSessionStats(item, session);

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'secondary session-action-btn';
    openBtn.textContent = session.status === 'paused' ? 'Resume' : 'Open';
    openBtn.addEventListener('click', async () => {
      try {
        await sendMessage('OPEN_SESSION', { sessionId: session.id });
        await refreshState(false);
      } catch (error) {
        window.alert(error.message || 'Failed to open session');
      }
    });
    actions.appendChild(openBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger session-action-btn';
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

    item.appendChild(actions);
    pastSessionsListEl.appendChild(item);
  }
}

function renderSession(session, highlightNew = true) {
  currentSession = session || null;
  document.getElementById('goalText').textContent = session?.goal || 'No active session.';
  document.getElementById('updatedAt').textContent = session?.updatedAt
    ? `Updated ${new Date(session.updatedAt).toLocaleString()}`
    : '';

  renderList('questionsList', getResearchQuestions(session), 'No research questions yet.');
  renderInsights(session?.insights, highlightNew);
  renderList('missingTopicsList', session?.missingTopics, 'No missing topics flagged.');
  renderSources(session?.sources);
}

function renderSources(sources) {
  const el = document.getElementById('sourcesList');
  el.innerHTML = '';

  if (!sources?.length) {
    el.innerHTML = '<li class="muted">No sources analyzed yet.</li>';
    return;
  }

  for (const src of sources) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = src.url;
    a.textContent = src.title || src.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    li.appendChild(a);
    if (src.domain) {
      const meta = document.createElement('div');
      meta.className = 'muted small';
      meta.textContent = src.domain;
      li.appendChild(meta);
    }
    el.appendChild(li);
  }
}

groupedInsightsBtn.addEventListener('click', () => {
  if (!groupedViewAvailable) return;
  forcedTimelineFallback = false;
  insightsViewMode = 'grouped';
  renderInsights(currentSession?.insights, false);
});

timelineInsightsBtn.addEventListener('click', () => {
  forcedTimelineFallback = false;
  insightsViewMode = 'timeline';
  renderInsights(currentSession?.insights, false);
});

function applySessionState(state, highlightNew = true) {
  const nextSession = state?.session || null;
  const nextCurrentSessionId = state?.currentSessionId || nextSession?.id || null;
  const isSameSession = Boolean(currentSession?.id && nextSession?.id && currentSession.id === nextSession.id);

  if (!isSameSession) {
    previousInsightKeys = new Set((nextSession?.insights || []).map(insightKey));
    openClusterIds = new Set();
  }

  currentSessionId = nextCurrentSessionId;
  renderCurrentSessionSummary(nextSession);
  renderPastSessions(state?.allSessions, nextCurrentSessionId);
  renderSession(nextSession, highlightNew && isSameSession);
}

async function refreshState(highlightNew = true) {
  const state = await getState();
  applySessionState(state, highlightNew);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SESSION_UPDATED') {
    applySessionState(message.payload, true);
    return;
  }

  if (message.type === 'SETTINGS_UPDATED') {
    applyFontSize(normalizeFontSize(message.payload?.uiFontSize));
  }
});

getState().then((state) => {
  const { session, settings } = state;
  applyFontSize(normalizeFontSize(settings?.uiFontSize));
  previousInsightKeys = new Set((session?.insights || []).map(insightKey));
  applySessionState(state, false);
});
