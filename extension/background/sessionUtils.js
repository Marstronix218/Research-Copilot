/**
 * Build a stable de-duplication key for insight records.
 *
 * Two insights are considered duplicates when their topic and summary match.
 */
function insightKey(item) {
  return `${item?.topic || ''}::${item?.summary || ''}`;
}

/**
 * Collect case-insensitive unique topic labels from an insight list.
 */
export function collectTopicsFromInsights(insights) {
  const seen = new Set();
  const topics = [];
  for (const insight of Array.isArray(insights) ? insights : []) {
    const topic = String(insight?.topic || '').trim();
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
  }
  return topics;
}

/**
 * Merge incoming insights into existing session insights.
 *
 * Existing items are matched by topic+summary. Source provenance is merged
 * without duplicates.
 */
export function mergeInsights(existing, incoming, source) {
  const normalized = [...(Array.isArray(existing) ? existing : [])];
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const key = insightKey(item);
    const index = normalized.findIndex((x) => insightKey(x) === key);
    if (index === -1) {
      normalized.push({
        ...item,
        addedAt: new Date().toISOString(),
        sources: [source],
      });
    } else {
      const existingSources = Array.isArray(normalized[index].sources)
        ? normalized[index].sources
        : [];
      const alreadyLinked = existingSources.some((x) => x.url === source.url);
      if (!alreadyLinked) {
        normalized[index] = {
          ...normalized[index],
          sources: [...existingSources, source],
        };
      }
    }
  }
  return normalized;
}

/**
 * Merge tracked source metadata by URL.
 */
export function mergeSources(existing, source) {
  const normalized = Array.isArray(existing) ? existing : [];
  const found = normalized.find((x) => x.url === source.url);
  if (found) {
    return normalized.map((x) => (x.url === source.url ? { ...x, ...source } : x));
  }
  return [source, ...normalized];
}

/**
 * Extract hostname safely from a URL-like string.
 */
export function safeDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Close the currently open browsing-history item, if one exists.
 */
export function finalizeCurrentHistoryItem(history, now) {
  if (!Array.isArray(history) || !history.length) return [];

  const clone = [...history];
  const index = clone.findLastIndex((item) => item?.endedAt == null);
  if (index === -1) return clone;

  const current = clone[index] || {};
  const startedAt = current.startedAt || now;
  clone[index] = {
    ...current,
    endedAt: now,
    dwellMs: Math.max(0, now - startedAt),
  };
  return clone;
}

// Quick distraction domain check so history items are tagged at creation time,
// even before a full drift tick can score them.  Keeps the list minimal and
// aligned with the patterns in relevanceScorer.js.
const DISTRACTION_DOMAINS = [
  'x.com', 'twitter.com', 'instagram.com', 'tiktok.com', 'reddit.com',
  'youtube.com', 'youtu.be',
  'amazon.com', 'ebay.com', 'walmart.com', 'aliexpress.com', 'etsy.com',
  'discord.com', 'slack.com', 'messenger.com', 'web.whatsapp.com', 'teams.microsoft.com',
];

const DISTRACTION_CATEGORIES = {
  'x.com': 'social', 'twitter.com': 'social', 'instagram.com': 'social',
  'tiktok.com': 'social', 'reddit.com': 'social',
  'youtube.com': 'video', 'youtu.be': 'video',
  'amazon.com': 'shopping', 'ebay.com': 'shopping', 'walmart.com': 'shopping',
  'aliexpress.com': 'shopping', 'etsy.com': 'shopping',
  'discord.com': 'messaging', 'slack.com': 'messaging', 'messenger.com': 'messaging',
  'web.whatsapp.com': 'messaging', 'teams.microsoft.com': 'messaging',
};

function quickDistractionCheck(domain) {
  const d = String(domain || '').toLowerCase();
  for (const pattern of DISTRACTION_DOMAINS) {
    if (d === pattern || d.endsWith('.' + pattern)) {
      return { isDistraction: true, category: DISTRACTION_CATEGORIES[pattern] || 'general' };
    }
  }
  return { isDistraction: false, category: null };
}

/**
 * Advance browsing-state tracking for the current active tab.
 *
 * `treatAsNewVisit` should be true for reload/completed-load events so a same-URL
 * refresh still counts as a distinct browsing event for drift history.
 */
export function updateBrowsingStateForActiveTab({
  browsingState,
  tabId,
  url,
  title,
  now,
  maxRecentHistoryItems,
  treatAsNewVisit = false,
  recordActivity = true,
}) {
  const currentState = browsingState && typeof browsingState === 'object' ? browsingState : {};
  const normalizedUrl = String(url || '');
  const normalizedTitle = String(title || '');
  const lastUserActivityAt = recordActivity
    ? now
    : currentState.lastUserActivityAt || now;
  const samePage =
    currentState.currentTabId === tabId &&
    currentState.currentUrl === normalizedUrl;

  if (samePage && !treatAsNewVisit) {
    return {
      ...currentState,
      currentTitle: normalizedTitle || currentState.currentTitle,
      currentDomain: safeDomain(normalizedUrl),
      lastUserActivityAt,
    };
  }

  const domain = safeDomain(normalizedUrl);
  const distraction = quickDistractionCheck(domain);
  const history = finalizeCurrentHistoryItem(currentState.recentHistory || [], now);
  history.push({
    tabId,
    url: normalizedUrl,
    domain,
    title: normalizedTitle,
    startedAt: now,
    endedAt: null,
    dwellMs: 0,
    relevanceScore: 0,
    relevanceLabel: 'unknown',
    isDistraction: distraction.isDistraction,
    distractionCategory: distraction.category,
  });

  return {
    ...currentState,
    currentTabId: tabId,
    currentUrl: normalizedUrl,
    currentDomain: domain,
    currentTitle: normalizedTitle,
    currentSnippet: '',
    currentTabStartedAt: now,
    lastUserActivityAt,
    recentHistory: history.slice(-Math.max(1, Number(maxRecentHistoryItems) || 1)),
  };
}
