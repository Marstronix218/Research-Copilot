async function getSession() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_SESSION' });
  return response.data.session;
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

function renderInsights(insights) {
  const el = document.getElementById('insightsList');
  el.innerHTML = '';
  if (!insights?.length) {
    el.innerHTML = '<div class="muted">No insights captured yet.</div>';
    return;
  }

  for (const insight of insights) {
    const card = document.createElement('div');
    card.className = 'card insight-card';
    card.innerHTML = `
      <div class="label-row">
        <strong>${escapeHtml(insight.topic || 'General')}</strong>
        <span class="muted small">${escapeHtml(insight.relevance || '')}</span>
      </div>
      <div>${escapeHtml(insight.summary || '')}</div>
      ${insight.evidence ? `<div class="muted small">Evidence: ${escapeHtml(insight.evidence)}</div>` : ''}
    `;
    el.appendChild(card);
  }
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

function renderSession(session) {
  document.getElementById('goalText').textContent = session?.goal || 'No active session.';
  document.getElementById('updatedAt').textContent = session?.updatedAt
    ? `Updated ${new Date(session.updatedAt).toLocaleString()}`
    : '';

  renderList('questionsList', session?.questions, 'No research questions yet.');
  renderInsights(session?.insights);
  renderList('missingTopicsList', session?.missingTopics, 'No missing topics flagged.');
  renderSources(session?.sources);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SESSION_UPDATED') {
    renderSession(message.payload);
  }
});

getSession().then(renderSession);
