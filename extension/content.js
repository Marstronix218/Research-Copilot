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
  if (driftToast) driftToast.style.bottom = analysisToast ? '162px' : '20px';
}

function showAnalysisToast(result) {
  if (!result?.page_summary) return;

  if (analysisToast) analysisToast.remove();
  if (analysisToastTimeout) clearTimeout(analysisToastTimeout);

  analysisToast = createBaseToast();
  analysisToast.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;">Research Copilot</div>
    <div style="font-size:13px;line-height:1.4;margin-bottom:6px;">${escapeHtml(result.page_summary)}</div>
    <div style="font-size:12px;color:#cbd5e1;">Topic: ${escapeHtml(result.primary_topic || 'General')}</div>
  `;

  analysisToast.addEventListener('mouseenter', () => {
    if (analysisToastTimeout) {
      clearTimeout(analysisToastTimeout);
      analysisToastTimeout = null;
    }
  });

  analysisToast.addEventListener('mouseleave', () => {
    scheduleAnalysisToastDismiss(5000);
  });

  document.body.appendChild(analysisToast);
  updateToastPositions();
  scheduleAnalysisToastDismiss(15000);
}

function scheduleAnalysisToastDismiss(delayMs) {
  if (analysisToastTimeout) clearTimeout(analysisToastTimeout);
  analysisToastTimeout = setTimeout(() => {
    analysisToast?.remove();
    analysisToast = null;
    analysisToastTimeout = null;
    updateToastPositions();
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
    showAnalysisToast(message.payload);
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
