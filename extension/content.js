function extractMainText() {
  const article = document.querySelector('article');
  const main = document.querySelector('main');
  const target = article || main || document.body;
  const text = (target?.innerText || '').replace(/\s+/g, ' ').trim();
  return text;
}

function buildPayload() {
  return {
    url: window.location.href,
    title: document.title,
    content: extractMainText(),
    selection: window.getSelection()?.toString() || '',
    timestamp: new Date().toISOString()
  };
}

async function sendPageContent() {
  const payload = buildPayload();
  if (payload.content.length < 200) return;

  try {
    await chrome.runtime.sendMessage({
      type: 'PAGE_CONTENT',
      payload
    });
  } catch (error) {
    console.debug('Research Copilot message failed', error);
  }
}

let analysisToast;

function showAnalysisToast(result) {
  if (!result?.page_summary) return;

  if (analysisToast) analysisToast.remove();

  analysisToast = document.createElement('div');
  analysisToast.style.position = 'fixed';
  analysisToast.style.bottom = '20px';
  analysisToast.style.right = '20px';
  analysisToast.style.width = '320px';
  analysisToast.style.zIndex = '2147483647';
  analysisToast.style.background = '#111827';
  analysisToast.style.color = '#f9fafb';
  analysisToast.style.padding = '14px';
  analysisToast.style.borderRadius = '12px';
  analysisToast.style.boxShadow = '0 10px 20px rgba(0,0,0,0.25)';
  analysisToast.style.fontFamily = 'system-ui, sans-serif';
  analysisToast.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;">Research Copilot</div>
    <div style="font-size:13px;line-height:1.4;margin-bottom:6px;">${escapeHtml(result.page_summary)}</div>
    <div style="font-size:12px;color:#cbd5e1;">Topic: ${escapeHtml(result.primary_topic || 'General')}</div>
  `;

  document.body.appendChild(analysisToast);
  setTimeout(() => analysisToast?.remove(), 7000);
}

function escapeHtml(str) {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PAGE_ANALYSIS_RESULT') {
    showAnalysisToast(message.payload);
  }
});

window.addEventListener('load', () => {
  setTimeout(sendPageContent, 1500);
});
