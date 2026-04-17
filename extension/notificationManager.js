// Notification policy and message copy for drift-related nudges.

function buildNotificationCopy(type, goal) {
  const safeGoal = goal ? `Goal: ${goal.slice(0, 90)}` : '';

  if (type === 'inactive') {
    return {
      title: 'Research Copilot',
      message: `You've been inactive for a while. Resume whenever you're ready. ${safeGoal}`.trim(),
      toastMessage: "You've been inactive for a while. Resume your research when you're ready.",
      showRelevantButton: false,
    };
  }

  if (type === 'distraction_pattern') {
    return {
      title: 'Research Copilot',
      message: `You've switched to off-topic pages a few times. Want to return to your session? ${safeGoal}`.trim(),
      toastMessage: 'This looks a bit off-topic for your current research. Want to refocus?',
      showRelevantButton: true,
    };
  }

  return {
    title: 'Research Copilot',
    message: `This page may be drifting from your research topic. Want to get back to your session? ${safeGoal}`.trim(),
    toastMessage: 'This page may be drifting from your research goal.',
    showRelevantButton: true,
  };
}

export function shouldSendNotification({ driftState, evaluation, driftSettings, now }) {
  // Gate notifications by event intent and cooldown windows to avoid spam.
  if (!evaluation.shouldNotify || !evaluation.notificationType) return false;

  const lastAt = driftState.lastNotificationAt || 0;
  const withinCooldown = now - lastAt < driftSettings.notificationCooldownMs;
  if (withinCooldown) return false;

  const sameTypeRecently =
    driftState.lastNotificationType === evaluation.notificationType &&
    now - lastAt < driftSettings.notificationCooldownMs * 1.75;
  if (sameTypeRecently) return false;

  return true;
}

export async function notifyDrift({ evaluation, goal, currentTabId }) {
  // Send both a Chrome notification and an in-page toast when possible.
  const copy = buildNotificationCopy(evaluation.notificationType, goal);
  await chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/research-copilot-notify.svg',
    title: copy.title,
    message: copy.message,
    priority: 1,
  });

  if (currentTabId) {
    try {
      await chrome.tabs.sendMessage(currentTabId, {
        type: 'SHOW_DRIFT_TOAST',
        payload: {
          title: copy.title,
          message: copy.toastMessage,
          showRelevantButton: copy.showRelevantButton,
        },
      });
    } catch {
      // Ignore if no content script is available on the page.
    }
  }
}
