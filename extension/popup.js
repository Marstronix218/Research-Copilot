async function sendMessage(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload });
}

async function loadState() {
  const response = await sendMessage('GET_SESSION');
  const { session, settings } = response.data;
  const uiFontSize = normalizeFontSize(settings?.uiFontSize);

  document.getElementById('goal').value = session?.goal || '';
  document.getElementById('backendUrl').value = settings?.backendUrl || 'http://localhost:8000';
  document.getElementById('autoAnalyze').checked = Boolean(settings?.autoAnalyze);
  document.getElementById('fontSize').value = String(uiFontSize);
  document.getElementById('fontSizeValue').textContent = `${uiFontSize}px`;

  applyFontSize(uiFontSize);

  renderSession(session);
  await refreshHealth();
}

function renderSession(session) {
  const el = document.getElementById('sessionInfo');
  if (!session?.goal) {
    el.innerHTML = '<div class="muted">No active research session.</div>';
    return;
  }

  el.innerHTML = `
    <div class="label-row"><strong>Active session</strong><button id="clearBtn" class="danger">Clear</button></div>
    <div class="card">
      <div><strong>Goal:</strong> ${escapeHtml(session.goal)}</div>
      <div><strong>Status:</strong> ${session.paused ? 'Paused' : 'Active'}</div>
      <div><strong>Questions:</strong> ${session.questions.length}</div>
      <div><strong>Insights:</strong> ${session.insights.length}</div>
      <div><strong>Sources:</strong> ${session.sources.length}</div>
      <div class="row gap-sm section-actions">
        <button id="pauseBtn" class="secondary">${session.paused ? 'Resume session' : 'Pause session'}</button>
      </div>
    </div>
  `;

  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      await sendMessage('CLEAR_SESSION');
      await loadState();
    });
  }

  const pauseBtn = document.getElementById('pauseBtn');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', async () => {
      await sendMessage('TOGGLE_SESSION_PAUSE', { paused: !session.paused });
      await loadState();
    });
  }
}

async function refreshHealth() {
  const result = await sendMessage('PING_BACKEND');
  const badge = document.getElementById('healthBadge');
  const statusText = document.getElementById('statusText');
  const healthy = result.data?.healthy;

  badge.textContent = healthy ? 'Backend online' : 'Backend offline';
  badge.className = `badge ${healthy ? 'success' : 'danger'}`;
  statusText.textContent = healthy
    ? 'AI analysis is available.'
    : `Cannot reach backend. ${result.data?.error || ''}`.trim();
}

function escapeHtml(str) {
  return (str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const goal = document.getElementById('goal').value.trim();
  if (!goal) return;

  const response = await sendMessage('START_SESSION', { goal });
  if (!response.ok) {
    alert(response.error || 'Failed to start session');
    return;
  }

  await loadState();
});

document.getElementById('openPanelBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const backendUrl = document.getElementById('backendUrl').value.trim();
  const autoAnalyze = document.getElementById('autoAnalyze').checked;
  const uiFontSize = normalizeFontSize(document.getElementById('fontSize').value);
  await sendMessage('SAVE_SETTINGS', { backendUrl, autoAnalyze, uiFontSize });
  applyFontSize(uiFontSize);
  await refreshHealth();
});

document.getElementById('fontSize').addEventListener('input', (event) => {
  const uiFontSize = normalizeFontSize(event.target.value);
  document.getElementById('fontSizeValue').textContent = `${uiFontSize}px`;
  applyFontSize(uiFontSize);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SESSION_UPDATED') {
    renderSession(message.payload);
  }
});

function normalizeFontSize(value) {
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num)) return 14;
  return Math.min(20, Math.max(12, num));
}

function applyFontSize(sizePx) {
  document.documentElement.style.setProperty('--ui-font-size', `${sizePx}px`);
}

loadState();
