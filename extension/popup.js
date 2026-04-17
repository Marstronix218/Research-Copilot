// Minimal launcher popup that opens the sidepanel workspace.

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) {
    throw new Error(response?.error || 'Unexpected extension error');
  }
  return response.data;
}

async function openSidepanel() {
  // Open sidepanel in the currently focused window.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
}

function getStatusText(session) {
  // Keep this summary short because popup vertical space is limited.
  if (!session?.id) {
    return 'No session selected. Start or reopen one from the sidepanel.';
  }

  const status = session.status === 'paused'
    ? 'Paused'
    : session.status === 'saved'
      ? 'Saved'
      : 'Active';

  return `${status}: ${session.title || session.goal || 'Untitled research session'}`;
}

document.getElementById('openPanelBtn').addEventListener('click', async () => {
  await openSidepanel();
  window.close();
});

async function initializePopup() {
  // Load current session status so the launcher reflects extension state.
  try {
    const state = await sendMessage('GET_SESSION');
    document.getElementById('popupStatusLine').textContent = getStatusText(state.session);
  } catch (error) {
    document.getElementById('popupStatusLine').textContent = error.message || 'Failed to load current session.';
  }
}

initializePopup();
