async function sendMessage(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return (str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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

function getBackendUrl() {
  return document.getElementById('backendUrl').value.trim() || 'http://localhost:8000';
}

// ── Clarification state ───────────────────────────────────────────────────────

const clarificationState = {
  roughGoal: '',
  chatHistory: [],      // { role, type?, text, options? }[]
  answers: [],          // flat list of user-provided answer strings
  clarifiedGoal: null,
  rationale: null,
  isGoalConfirmed: false,
};

let questionCount = 0;

async function saveClarificationDraft() {
  await chrome.storage.local.set({
    researchSessionDraft: {
      roughGoal: clarificationState.roughGoal,
      clarificationChat: clarificationState.chatHistory,
      clarifiedGoal: clarificationState.clarifiedGoal,
      isGoalConfirmed: clarificationState.isGoalConfirmed,
    },
  });
}

async function loadClarificationDraft() {
  const data = await chrome.storage.local.get(['researchSessionDraft']);
  const draft = data.researchSessionDraft;
  if (!draft) return;

  clarificationState.roughGoal = draft.roughGoal || '';
  clarificationState.chatHistory = Array.isArray(draft.clarificationChat) ? draft.clarificationChat : [];
  clarificationState.clarifiedGoal = draft.clarifiedGoal || null;
  clarificationState.isGoalConfirmed = Boolean(draft.isGoalConfirmed);
  clarificationState.answers = clarificationState.chatHistory
    .filter(m => m.role === 'user')
    .map(m => m.text);
  questionCount = clarificationState.chatHistory.filter(m => m.role === 'assistant').length;
}

function resetClarificationState() {
  clarificationState.roughGoal = '';
  clarificationState.chatHistory = [];
  clarificationState.answers = [];
  clarificationState.clarifiedGoal = null;
  clarificationState.rationale = null;
  clarificationState.isGoalConfirmed = false;
  questionCount = 0;
  chrome.storage.local.remove(['researchSessionDraft', 'activeResearchGoal', 'originalResearchGoal']);
}

/** Returns the goal to use when starting a session. */
function getEffectiveGoal() {
  if (clarificationState.isGoalConfirmed && clarificationState.clarifiedGoal) {
    return clarificationState.clarifiedGoal;
  }
  return document.getElementById('goal').value.trim();
}

// ── Section / UI state ────────────────────────────────────────────────────────

function showSection(sectionId) {
  const ids = ['goal-input-section', 'clarification-section', 'goal-confirmation-section'];
  ids.forEach(id => {
    document.getElementById(id).classList.toggle('hidden', id !== sectionId);
  });
  // Show bottom sections only in default state
  document.getElementById('main-bottom-sections').classList.toggle('hidden', sectionId !== 'goal-input-section');
}

function updateGoalBadge() {
  const row = document.getElementById('goalStatusBadgeRow');
  const badge = document.getElementById('goalStatusBadge');
  if (clarificationState.isGoalConfirmed && clarificationState.clarifiedGoal) {
    row.classList.remove('hidden');
    badge.textContent = 'Clarified ✓';
    badge.className = 'badge success';
  } else if (clarificationState.chatHistory.length > 0 && !clarificationState.isGoalConfirmed) {
    row.classList.remove('hidden');
    badge.textContent = 'Clarifying…';
    badge.className = 'badge warning';
  } else {
    row.classList.add('hidden');
  }
}

function showInlineError(msg) {
  const el = document.getElementById('goal-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearInlineError() {
  const el = document.getElementById('goal-error');
  el.textContent = '';
  el.classList.add('hidden');
}

// ── Chat UI helpers ───────────────────────────────────────────────────────────

function renderClarificationMessage(message) {
  const container = document.getElementById('chatContainer');
  const div = document.createElement('div');
  div.className = `chat-message ${message.role === 'assistant' ? 'msg-assistant' : 'msg-user'}`;
  div.textContent = message.text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function renderOptions(options) {
  const container = document.getElementById('optionsContainer');
  container.innerHTML = '';
  if (!options || options.length === 0) return;
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'option-chip';
    btn.textContent = opt;
    btn.addEventListener('click', () => handleOptionClick(opt));
    container.appendChild(btn);
  });
}

function clearOptions() {
  document.getElementById('optionsContainer').innerHTML = '';
}

function updateProgress() {
  const el = document.getElementById('clarifyProgress');
  el.textContent = questionCount > 0 ? `Question ${questionCount} of ~4` : '';
}

function showTypingIndicator() {
  const container = document.getElementById('chatContainer');
  const div = document.createElement('div');
  div.id = 'typing-indicator';
  div.className = 'chat-message msg-assistant typing-indicator';
  div.innerHTML = '<span></span><span></span><span></span>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function hideTypingIndicator() {
  document.getElementById('typing-indicator')?.remove();
}

function showChatError(msg) {
  const container = document.getElementById('chatContainer');
  const div = document.createElement('div');
  div.className = 'chat-error';
  div.textContent = msg;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ── Clarification flow ────────────────────────────────────────────────────────

async function handleClarifyGoalClick() {
  const roughGoal = document.getElementById('goal').value.trim();
  if (!roughGoal) {
    showInlineError('Please enter a research goal before clarifying.');
    return;
  }
  clearInlineError();

  // Warn if the user changed the goal after a draft was started
  if (
    clarificationState.roughGoal &&
    clarificationState.roughGoal !== roughGoal &&
    clarificationState.chatHistory.length > 0
  ) {
    if (!confirm('Your goal changed. This will discard the previous clarification draft. Continue?')) return;
    resetClarificationState();
  }

  clarificationState.roughGoal = roughGoal;
  showSection('clarification-section');
  document.getElementById('chatContainer').innerHTML = '';

  // Resume an existing chat if available
  if (clarificationState.chatHistory.length > 0) {
    clarificationState.chatHistory.forEach(msg => renderClarificationMessage(msg));
    // Re-render options if the last message was an unanswered assistant question
    const last = clarificationState.chatHistory[clarificationState.chatHistory.length - 1];
    if (last && last.role === 'assistant' && last.options?.length) {
      renderOptions(last.options);
    }
    updateProgress();
    return;
  }

  // Fresh start – call backend
  showTypingIndicator();
  try {
    const res = await fetch(`${getBackendUrl()}/api/clarify-goal/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roughGoal }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hideTypingIndicator();
    handleClarificationResponse(data);
  } catch (err) {
    hideTypingIndicator();
    showChatError('Could not reach the backend. Check your Backend URL setting and try again.');
  }
}

async function handleOptionClick(optionValue) {
  clearOptions();
  const userMsg = { role: 'user', text: optionValue };
  clarificationState.chatHistory.push(userMsg);
  clarificationState.answers.push(optionValue);
  renderClarificationMessage(userMsg);
  await requestNextClarificationStep();
}

async function handleCustomAnswerSubmit() {
  const input = document.getElementById('customAnswerInput');
  const value = input.value.trim();
  if (!value) return;
  input.value = '';
  clearOptions();
  const userMsg = { role: 'user', text: value };
  clarificationState.chatHistory.push(userMsg);
  clarificationState.answers.push(value);
  renderClarificationMessage(userMsg);
  await requestNextClarificationStep();
}

async function requestNextClarificationStep() {
  showTypingIndicator();
  try {
    const res = await fetch(`${getBackendUrl()}/api/clarify-goal/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roughGoal: clarificationState.roughGoal,
        chatHistory: clarificationState.chatHistory,
        answers: clarificationState.answers,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hideTypingIndicator();
    handleClarificationResponse(data);
  } catch (err) {
    hideTypingIndicator();
    showChatError('Failed to get the next step. You can type a custom answer below to continue.');
  }
}

function handleClarificationResponse(data) {
  if (data.status === 'complete') {
    clarificationState.clarifiedGoal = data.clarifiedGoal;
    clarificationState.rationale = data.rationale || null;
    saveClarificationDraft();
    renderGoalConfirmation(clarificationState.roughGoal, data.clarifiedGoal, data.rationale);
  } else if (data.status === 'needs_clarification' && data.message) {
    const msg = data.message;
    clarificationState.chatHistory.push(msg);
    questionCount++;
    renderClarificationMessage(msg);
    renderOptions(msg.options || []);
    updateProgress();
    saveClarificationDraft();
  }
}

function renderGoalConfirmation(roughGoal, clarifiedGoal, rationale) {
  document.getElementById('origGoalText').textContent = roughGoal;
  document.getElementById('clarifiedGoalText').textContent = clarifiedGoal;
  const rationaleEl = document.getElementById('rationaleText');
  if (rationale) {
    rationaleEl.textContent = rationale;
    rationaleEl.classList.remove('hidden');
  } else {
    rationaleEl.classList.add('hidden');
  }
  showSection('goal-confirmation-section');
}

async function handleConfirmClarifiedGoal() {
  clarificationState.isGoalConfirmed = true;
  await chrome.storage.local.set({
    activeResearchGoal: clarificationState.clarifiedGoal,
    originalResearchGoal: clarificationState.roughGoal,
  });
  await saveClarificationDraft();
  // Reflect clarified goal in the textarea
  document.getElementById('goal').value = clarificationState.clarifiedGoal;
  showSection('goal-input-section');
  updateGoalBadge();
}

async function handleRefineAgain() {
  showSection('clarification-section');
  showTypingIndicator();
  try {
    const res = await fetch(`${getBackendUrl()}/api/clarify-goal/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roughGoal: clarificationState.roughGoal,
        chatHistory: clarificationState.chatHistory,
        answers: clarificationState.answers,
        currentClarifiedGoal: clarificationState.clarifiedGoal,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hideTypingIndicator();
    handleClarificationResponse(data);
  } catch (err) {
    hideTypingIndicator();
    showChatError('Failed to refine. Type an additional answer below to guide the refinement.');
  }
}

// ── Existing session / settings state ────────────────────────────────────────

async function loadState() {
  const response = await sendMessage('GET_SESSION');
  const { session, settings } = response.data;
  const uiFontSize = normalizeFontSize(settings?.uiFontSize);

  document.getElementById('backendUrl').value = settings?.backendUrl || 'http://localhost:8000';
  document.getElementById('autoAnalyze').checked = Boolean(settings?.autoAnalyze);
  document.getElementById('fontSize').value = String(uiFontSize);
  document.getElementById('fontSizeValue').textContent = `${uiFontSize}px`;
  applyFontSize(uiFontSize);

  // Load clarification draft before populating the goal textarea
  await loadClarificationDraft();
  updateGoalBadge();

  // Show confirmed clarified goal in textarea if available; otherwise session goal
  if (clarificationState.isGoalConfirmed && clarificationState.clarifiedGoal) {
    document.getElementById('goal').value = clarificationState.clarifiedGoal;
  } else {
    document.getElementById('goal').value = session?.goal || '';
  }

  renderSession(session);
  await refreshHealth();
}

function renderSession(session) {
  const el = document.getElementById('sessionInfo');
  if (!session?.goal) {
    el.innerHTML = '<div class="muted">No active research session.</div>';
    return;
  }

  const questions = getResearchQuestions(session);
  const statusLabel = session.status === 'paused'
    ? 'Paused'
    : session.status === 'saved'
      ? 'Saved'
      : 'Active';
  const sessionActionLabel = session.status === 'active' ? 'Pause session' : 'Resume session';

  el.innerHTML = `
    <div class="label-row"><strong>Current session</strong><button id="clearBtn" class="danger">Delete</button></div>
    <div class="card">
      <div><strong>Goal:</strong> ${escapeHtml(session.goal)}</div>
      <div><strong>Status:</strong> ${statusLabel}</div>
      <div><strong>Questions:</strong> ${questions.length}</div>
      <div><strong>Insights:</strong> ${session.insights.length}</div>
      <div><strong>Sources:</strong> ${session.sources.length}</div>
      <div class="row gap-sm section-actions">
        <button id="pauseBtn" class="secondary">${sessionActionLabel}</button>
      </div>
    </div>
  `;

  document.getElementById('clearBtn')?.addEventListener('click', async () => {
    await sendMessage('CLEAR_SESSION');
    await loadState();
  });

  document.getElementById('pauseBtn')?.addEventListener('click', async () => {
    if (session.status === 'saved') {
      await sendMessage('OPEN_SESSION', { sessionId: session.id });
    } else {
      await sendMessage('TOGGLE_SESSION_PAUSE', { paused: !session.paused });
    }
    await loadState();
  });
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

// ── Event listeners ───────────────────────────────────────────────────────────

// Detect goal textarea edits that invalidate a confirmed/in-progress clarification
document.getElementById('goal').addEventListener('input', () => {
  if (!clarificationState.roughGoal) return;
  const current = document.getElementById('goal').value.trim();
  if (clarificationState.isGoalConfirmed && current !== clarificationState.clarifiedGoal) {
    resetClarificationState();
    updateGoalBadge();
  }
});

document.getElementById('startBtn').addEventListener('click', async () => {
  const goal = getEffectiveGoal();
  if (!goal) {
    showInlineError('Please enter a research goal first.');
    return;
  }
  clearInlineError();

  const response = await sendMessage('START_SESSION', { goal });
  if (!response.ok) {
    alert(response.error || 'Failed to start session');
    return;
  }
  await loadState();
});

document.getElementById('clarifyBtn').addEventListener('click', handleClarifyGoalClick);

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

// Clarification section buttons
document.getElementById('cancelClarifyBtn').addEventListener('click', () => showSection('goal-input-section'));

document.getElementById('sendAnswerBtn').addEventListener('click', handleCustomAnswerSubmit);

document.getElementById('customAnswerInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') handleCustomAnswerSubmit();
});

// Confirmation section buttons
document.getElementById('confirmGoalBtn').addEventListener('click', handleConfirmClarifiedGoal);
document.getElementById('refineAgainBtn').addEventListener('click', handleRefineAgain);
document.getElementById('cancelConfirmBtn').addEventListener('click', () => showSection('goal-input-section'));

// Reset badge button
document.getElementById('resetGoalBtn').addEventListener('click', () => {
  if (!confirm('Reset to original rough goal? This will discard your clarified goal.')) return;
  const roughGoal = clarificationState.roughGoal;
  resetClarificationState();
  document.getElementById('goal').value = roughGoal;
  updateGoalBadge();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SESSION_UPDATED') {
    renderSession(message.payload?.session);
  }
});

loadState();
