let previousInsightKeys = new Set();

async function getState() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_SESSION' });
  return response.data;
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

function renderInsights(insights, highlightNew) {
  const el = document.getElementById('insightsList');
  el.innerHTML = '';
  if (!insights?.length) {
    el.innerHTML = '<div class="muted">No insights captured yet.</div>';
    previousInsightKeys = new Set();
    return;
  }

  const currentInsightKeys = new Set();

  for (const insight of insights) {
    const key = insightKey(insight);
    currentInsightKeys.add(key);

    const card = document.createElement('div');
    card.className = 'card insight-card';

    if (highlightNew && !previousInsightKeys.has(key)) {
      card.classList.add('insight-new');
    }

    const header = document.createElement('div');
    header.className = 'label-row';

    const topic = document.createElement('strong');
    topic.textContent = insight.topic || 'General';
    header.appendChild(topic);

    const relevance = document.createElement('span');
    relevance.className = 'muted small';
    relevance.textContent = insight.relevance || '';
    header.appendChild(relevance);

    const summary = document.createElement('div');
    summary.textContent = insight.summary || '';

    card.appendChild(header);
    card.appendChild(summary);

    if (insight.evidence) {
      const evidence = document.createElement('div');
      evidence.className = 'muted small';
      evidence.textContent = `Evidence: ${insight.evidence}`;
      card.appendChild(evidence);
    }

    const insightSources = Array.isArray(insight.sources) ? insight.sources : [];
    if (insightSources.length) {
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

    el.appendChild(card);
  }

  previousInsightKeys = currentInsightKeys;
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

function escapeHtml(str) {
  return (str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderSession(session, highlightNew = true) {
  document.getElementById('goalText').textContent = session?.goal || 'No active session.';
  document.getElementById('updatedAt').textContent = session?.updatedAt
    ? `Updated ${new Date(session.updatedAt).toLocaleString()}`
    : '';

  renderList('questionsList', session?.questions, 'No research questions yet.');
  renderInsights(session?.insights, highlightNew);
  renderList('missingTopicsList', session?.missingTopics, 'No missing topics flagged.');
  renderSources(session?.sources);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SESSION_UPDATED') {
    if (message.payload?.updatedAt) {
      renderSession(message.payload);
    }
    return;
  }

  if (message.type === 'SETTINGS_UPDATED') {
    applyFontSize(normalizeFontSize(message.payload?.uiFontSize));
  }
});

getState().then(({ session, settings }) => {
  applyFontSize(normalizeFontSize(settings?.uiFontSize));
  previousInsightKeys = new Set((session?.insights || []).map(insightKey));
  renderSession(session, false);
});
