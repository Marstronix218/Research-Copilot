function countConsecutiveOffTopic(history) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    const offTopic = item.isDistraction || item.relevanceLabel === 'unrelated' || item.relevanceLabel === 'low';
    if (!offTopic) break;
    count += 1;
  }
  return count;
}

export function evaluateDrift({
  activeSession,
  browsingState,
  idleState,
  driftSettings,
  now,
  currentPage,
}) {
  const reasons = [];
  let status = 'focused';
  let score = 8;
  let shouldNotify = false;
  let notificationType = null;

  if (!activeSession?.isActive || !activeSession.goal) {
    return { status: 'focused', score: 0, reasons: ['no active research session'], shouldNotify: false, notificationType: null };
  }

  const lastActivityAt = browsingState.lastUserActivityAt || now;
  const inactivityMs = now - lastActivityAt;
  if (idleState !== 'active' && inactivityMs >= driftSettings.inactivityThresholdMs) {
    status = 'inactive';
    score = 82;
    reasons.push(`inactive for ${(inactivityMs / 60000).toFixed(1)} minutes`);
    shouldNotify = true;
    notificationType = 'inactive';
    return { status, score, reasons, shouldNotify, notificationType };
  }

  if (!currentPage?.url || !browsingState.currentTabStartedAt) {
    return { status, score, reasons: ['not enough page context yet'], shouldNotify: false, notificationType: null };
  }

  const dwellMs = now - browsingState.currentTabStartedAt;
  const isLowOrUnrelated = currentPage.relevanceLabel === 'low' || currentPage.relevanceLabel === 'unrelated';

  if (isLowOrUnrelated && dwellMs >= driftSettings.unrelatedSoftThresholdMs) {
    status = 'slipping';
    score = 45;
    reasons.push(`spent ${(dwellMs / 60000).toFixed(1)} minutes on a low-relevance page`);
  }

  if (
    isLowOrUnrelated &&
    dwellMs >= driftSettings.unrelatedNotifyThresholdMs
  ) {
    status = 'drifting';
    score = 68;
    shouldNotify = true;
    notificationType = 'unrelated_page';
    reasons.push(`long dwell on low-relevance content (${(dwellMs / 60000).toFixed(1)} min)`);
  }

  if (
    currentPage.isDistraction &&
    dwellMs >= driftSettings.distractionNotifyThresholdMs &&
    currentPage.relevanceScore < 0.5
  ) {
    status = 'drifting';
    score = Math.max(score, 72);
    shouldNotify = true;
    notificationType = 'distraction_pattern';
    reasons.push(`distraction-category page dwell ${(dwellMs / 60000).toFixed(1)} min (${currentPage.distractionCategory || 'general'})`);
  }

  const history = browsingState.recentHistory || [];
  const consecutiveOffTopic = countConsecutiveOffTopic(history);
  if (consecutiveOffTopic >= 3) {
    status = 'drifting';
    score = Math.max(score, 70);
    shouldNotify = true;
    notificationType = notificationType || 'distraction_pattern';
    reasons.push(`${consecutiveOffTopic} consecutive low-relevance/distraction page switches`);
  }

  if (!reasons.length) {
    reasons.push('current page appears relevant or too early to judge');
  }

  return { status, score, reasons, shouldNotify, notificationType };
}
