function extractMainText() {
  const article = document.querySelector('article');
  const main = document.querySelector('main');
  const target = article || main || document.body;
  return (target?.innerText || '').replace(/\s+/g, ' ').trim();
}

function buildPayload() {
  return {
    url: window.location.href,
    title: document.title,
    content: extractMainText(),
    selection: window.getSelection()?.toString() || '',
    timestamp: new Date().toISOString(),
  };
}

async function sendPageContent() {
  const payload = buildPayload();
  if (payload.content.length < 200) return;

  try {
    await chrome.runtime.sendMessage({
      type: 'PAGE_CONTENT',
      payload,
    });
  } catch (error) {
    console.debug('Research Copilot message failed', error);
  }
}

let analysisToast;
let analysisToastTimeout;
let driftToast;
let driftToastTimeout;
let lastActivityHeartbeatAt = 0;

function createBaseToast() {
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.right = '20px';
  el.style.width = '320px';
  el.style.zIndex = '2147483647';
  el.style.background = '#111827';
  el.style.color = '#f9fafb';
  el.style.padding = '14px';
  el.style.borderRadius = '12px';
  el.style.boxShadow = '0 10px 20px rgba(0,0,0,0.25)';
  el.style.fontFamily = 'system-ui, sans-serif';
  return el;
}

function updateToastPositions() {
  if (analysisToast) analysisToast.style.bottom = '20px';
  if (driftToast) {
    driftToast.style.bottom = analysisToast
      ? `${analysisToast.offsetHeight + 32}px`
      : '20px';
  }
}

function dismissAnalysisToast(toastEl = analysisToast) {
  if (!toastEl) return;

  if (toastEl !== analysisToast) {
    toastEl.remove();
    return;
  }

  if (analysisToastTimeout) {
    clearTimeout(analysisToastTimeout);
    analysisToastTimeout = null;
  }

  analysisToast.remove();
  analysisToast = null;
  updateToastPositions();
}

async function persistAnalysisInsights(result, controls) {
  const { toastEl, saveButton, dismissButton, closeButton, statusEl } = controls;
  if (!saveButton || saveButton.dataset.state === 'saving' || saveButton.dataset.state === 'saved') {
    return;
  }

  saveButton.dataset.state = 'saving';
  saveButton.disabled = true;
  if (dismissButton) dismissButton.disabled = true;
  if (closeButton) closeButton.disabled = true;
  saveButton.textContent = 'Saving...';

  if (toastEl === analysisToast && analysisToastTimeout) {
    clearTimeout(analysisToastTimeout);
    analysisToastTimeout = null;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SAVE_ANALYSIS_INSIGHTS',
      payload: {
        insights: Array.isArray(result?.insights) ? result.insights : [],
        page: {
          url: window.location.href,
          title: document.title,
        },
      },
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Insight save failed');
    }

    if (toastEl !== analysisToast) return;

    const addedCount = Number(response.data?.addedCount || 0);
    saveButton.dataset.state = 'saved';
    saveButton.textContent = 'Added';
    statusEl.style.display = 'block';
    statusEl.style.color = '#86efac';
    statusEl.textContent = addedCount > 1
      ? `Added ${addedCount} insights to sidebar`
      : addedCount === 1
        ? 'Added to sidebar'
        : 'Already in sidebar';
    updateToastPositions();

    scheduleAnalysisToastDismiss(1400, toastEl);
  } catch (error) {
    if (toastEl !== analysisToast) return;

    saveButton.dataset.state = 'idle';
    saveButton.disabled = false;
    if (dismissButton) dismissButton.disabled = false;
    if (closeButton) closeButton.disabled = false;
    saveButton.textContent = 'Add to sidebar';
    statusEl.style.display = 'block';
    statusEl.style.color = '#fca5a5';
    statusEl.textContent = 'Could not save insight';
    updateToastPositions();
    console.debug('Could not save analysis insights', error);
  }
}

function showInsightNotification(result) {
  const insights = Array.isArray(result?.insights) ? result.insights : [];
  const summaryText = result?.page_summary || insights[0]?.summary;
  if (!summaryText) return;

  if (analysisToast) {
    dismissAnalysisToast();
  }

  analysisToast = createBaseToast();
  const toastEl = analysisToast;

  const insightCount = insights.length;
  const insightCountText = insightCount
    ? `${insightCount} insight${insightCount === 1 ? '' : 's'} ready to save`
    : 'Insight ready to save';

  toastEl.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;">
      <div style="font-weight:600;">Research Copilot</div>
      <button
        type="button"
        id="rc-analysis-close-btn"
        aria-label="Dismiss insight"
        style="background:transparent;color:#cbd5e1;border:none;padding:0;cursor:pointer;font-size:18px;line-height:1;"
      >×</button>
    </div>
    <div style="font-size:13px;line-height:1.4;margin-bottom:6px;">${escapeHtml(summaryText)}</div>
    <div style="font-size:12px;color:#cbd5e1;margin-bottom:6px;">Topic: ${escapeHtml(result?.primary_topic || insights[0]?.topic || 'General')}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
      <div style="font-size:12px;color:#93c5fd;">${escapeHtml(insightCountText)}</div>
      <button
        type="button"
        id="rc-analysis-save-btn"
        style="background:#2563eb;color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:11px;font-weight:600;min-width:0;min-height:0;"
        ${insightCount ? '' : 'disabled'}
      >Add to sidebar</button>
    </div>
    <div
      id="rc-analysis-status"
      style="display:none;font-size:12px;margin-top:8px;"
      aria-live="polite"
    ></div>
  `;

  toastEl.addEventListener('mouseenter', () => {
    if (analysisToastTimeout) {
      clearTimeout(analysisToastTimeout);
      analysisToastTimeout = null;
    }
  });

  toastEl.addEventListener('mouseleave', () => {
    scheduleAnalysisToastDismiss(5000, toastEl);
  });

  document.body.appendChild(toastEl);
  updateToastPositions();

  const saveButton = toastEl.querySelector('#rc-analysis-save-btn');
  const closeButton = toastEl.querySelector('#rc-analysis-close-btn');
  const statusEl = toastEl.querySelector('#rc-analysis-status');

  closeButton?.addEventListener('click', () => {
    dismissAnalysisToast(toastEl);
  });

  saveButton?.addEventListener('click', async () => {
    await persistAnalysisInsights(result, {
      toastEl,
      saveButton,
      dismissButton: null,
      closeButton,
      statusEl,
    });
  });

  scheduleAnalysisToastDismiss(15000, toastEl);
}

function scheduleAnalysisToastDismiss(delayMs, toastEl = analysisToast) {
  if (toastEl !== analysisToast) return;
  if (analysisToastTimeout) clearTimeout(analysisToastTimeout);
  analysisToastTimeout = setTimeout(() => {
    if (analysisToast === toastEl) {
      dismissAnalysisToast(toastEl);
    }
  }, delayMs);
}

function showDriftToast({ title, message, showRelevantButton }) {
  if (!message) return;

  if (driftToast) driftToast.remove();
  if (driftToastTimeout) clearTimeout(driftToastTimeout);

  driftToast = createBaseToast();
  driftToast.style.background = '#1e293b';

  const buttonHtml = showRelevantButton
    ? '<button id="rc-mark-relevant-btn" style="margin-top:10px;background:#2563eb;color:#fff;border:none;border-radius:8px;padding:7px 10px;cursor:pointer;font-size:12px;">This page is relevant</button>'
    : '';

  driftToast.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;">${escapeHtml(title || 'Research Copilot')}</div>
    <div style="font-size:13px;line-height:1.4;color:#dbeafe;">${escapeHtml(message)}</div>
    ${buttonHtml}
  `;

  driftToast.addEventListener('mouseenter', () => {
    if (driftToastTimeout) {
      clearTimeout(driftToastTimeout);
      driftToastTimeout = null;
    }
  });

  driftToast.addEventListener('mouseleave', () => {
    scheduleDriftToastDismiss(5000);
  });

  document.body.appendChild(driftToast);
  updateToastPositions();

  const markBtn = document.getElementById('rc-mark-relevant-btn');
  if (markBtn) {
    markBtn.addEventListener('click', async () => {
      markBtn.disabled = true;
      markBtn.textContent = 'Marked as relevant';
      try {
        await chrome.runtime.sendMessage({
          type: 'MARK_PAGE_RELEVANT',
          payload: {
            url: window.location.href,
            title: document.title,
          },
        });
      } catch (error) {
        console.debug('Could not mark page relevant', error);
      }
      scheduleDriftToastDismiss(1200);
    });
  }

  scheduleDriftToastDismiss(12000);
}

function scheduleDriftToastDismiss(delayMs) {
  if (driftToastTimeout) clearTimeout(driftToastTimeout);
  driftToastTimeout = setTimeout(() => {
    driftToast?.remove();
    driftToast = null;
    driftToastTimeout = null;
    updateToastPositions();
  }, delayMs);
}

function escapeHtml(str) {
  return (str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function sendActivityHeartbeat(force = false) {
  const now = Date.now();
  if (!force && now - lastActivityHeartbeatAt < 25000) return;

  lastActivityHeartbeatAt = now;
  try {
    await chrome.runtime.sendMessage({
      type: 'USER_ACTIVITY_HEARTBEAT',
      payload: {
        url: window.location.href,
        title: document.title,
        snippet: extractMainText().slice(0, 700),
        timestamp: new Date(now).toISOString(),
      },
    });
  } catch {
    // Ignore; service worker may be asleep or reloading.
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PAGE_ANALYSIS_RESULT') {
    showInsightNotification(message.payload);
  }
  if (message.type === 'SHOW_DRIFT_TOAST') {
    showDriftToast(message.payload || {});
  }
});

['mousemove', 'keydown', 'click', 'scroll', 'focus'].forEach((evt) => {
  window.addEventListener(evt, () => {
    sendActivityHeartbeat(false);
  }, { passive: true });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    sendActivityHeartbeat(true);
  }
});

window.addEventListener('load', () => {
  setTimeout(sendPageContent, 1500);
  setTimeout(() => sendActivityHeartbeat(true), 2000);
  setInterval(() => {
    if (!document.hidden) {
      sendActivityHeartbeat(false);
    }
  }, 60000);
});
