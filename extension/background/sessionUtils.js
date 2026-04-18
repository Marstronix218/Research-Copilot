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
