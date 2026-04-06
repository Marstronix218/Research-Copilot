(function installInsightGroupingApi(global) {
  const SHORT_DISPLAY_TOKENS = new Map([
    ['ai', 'AI'],
    ['api', 'API'],
    ['apis', 'APIs'],
    ['llm', 'LLM'],
    ['ml', 'ML'],
    ['nlp', 'NLP'],
    ['rag', 'RAG'],
    ['sdk', 'SDK'],
    ['sql', 'SQL'],
    ['ui', 'UI'],
    ['ux', 'UX'],
  ]);

  const TOKEN_NORMALIZATION_MAP = new Map([
    ['apis', 'api'],
    ['llms', 'llm'],
  ]);

  const SHORT_KEYWORDS = new Set([...SHORT_DISPLAY_TOKENS.keys()]);
  const GENERIC_TOPIC_LABELS = new Set([
    '',
    'general',
    'generic',
    'insight',
    'insights',
    'misc',
    'miscellaneous',
    'note',
    'notes',
    'observation',
    'observations',
    'other',
    'overview',
    'research',
    'summary',
    'topic',
    'topics',
    'unknown',
  ]);

  const STOPWORDS = new Set([
    'across',
    'about',
    'after',
    'again',
    'against',
    'also',
    'and',
    'among',
    'around',
    'because',
    'based',
    'been',
    'before',
    'being',
    'between',
    'brief',
    'came',
    'could',
    'does',
    'done',
    'each',
    'even',
    'from',
    'goal',
    'have',
    'into',
    'just',
    'many',
    'more',
    'most',
    'much',
    'need',
    'only',
    'other',
    'over',
    'page',
    'pages',
    'same',
    'should',
    'since',
    'some',
    'such',
    'than',
    'that',
    'their',
    'them',
    'these',
    'they',
    'this',
    'those',
    'through',
    'under',
    'used',
    'using',
    'very',
    'via',
    'want',
    'what',
    'when',
    'where',
    'which',
    'while',
    'with',
    'within',
    'would',
    'your',
  ]);

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function safeString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeLabel(value) {
    return safeString(value).toLowerCase().replace(/\s+/g, ' ');
  }

  function dedupe(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function incrementMap(map, key, amount = 1) {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + amount);
  }

  function tokenize(value) {
    const text = Array.isArray(value) ? value.join(' ') : safeString(value);
    return text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => TOKEN_NORMALIZATION_MAP.get(token) || token)
      .filter((token) => {
        if (!token) return false;
        if (STOPWORDS.has(token)) return false;
        if (/^\d+$/.test(token)) return false;
        if (token.length >= 3) return true;
        return SHORT_KEYWORDS.has(token);
      });
  }

  function buildTokenCounts(chunks) {
    const counts = new Map();
    for (const chunk of chunks) {
      for (const token of tokenize(chunk)) {
        incrementMap(counts, token);
      }
    }
    return counts;
  }

  function mapKeysToSet(map) {
    return new Set(map.keys());
  }

  function mergeSet(target, source) {
    for (const item of source) {
      target.add(item);
    }
  }

  function extractTopicLabels(topic) {
    const normalized = safeString(topic);
    if (!normalized) return [];
    return dedupe(
      normalized
        .split(/[,/|;&]+/)
        .map((item) => normalizeLabel(item))
        .filter((item) => item && !GENERIC_TOPIC_LABELS.has(item))
    );
  }

  function normalizeDomain(value) {
    const domain = safeString(value)
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '');
    return domain;
  }

  function formatDomain(domain) {
    return normalizeDomain(domain);
  }

  function formatToken(token) {
    const normalized = normalizeLabel(token);
    return SHORT_DISPLAY_TOKENS.get(normalized) ||
      normalized
        .split(' ')
        .map((part) => SHORT_DISPLAY_TOKENS.get(part) || (part ? `${part[0].toUpperCase()}${part.slice(1)}` : ''))
        .join(' ');
  }

  function topEntries(map, limit, predicate) {
    return [...map.entries()]
      .filter(([key]) => (typeof predicate === 'function' ? predicate(key) : true))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit);
  }

  function setIntersectionCount(a, b) {
    let count = 0;
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
    for (const item of smaller) {
      if (larger.has(item)) count += 1;
    }
    return count;
  }

  function sharesAny(a, b) {
    return setIntersectionCount(a, b) > 0;
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    const overlap = setIntersectionCount(a, b);
    if (!overlap) return 0;
    return overlap / (a.size + b.size - overlap);
  }

  function parseTimestamp(value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function simpleHash(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function compareByAddedAtAscending(a, b) {
    if (a.addedAtMs != null && b.addedAtMs != null) {
      return a.addedAtMs - b.addedAtMs || a.index - b.index;
    }
    if (a.addedAtMs != null) return -1;
    if (b.addedAtMs != null) return 1;
    return a.index - b.index;
  }

  function scoreInsightRichness(insight) {
    return (
      insight.topicLabels.size * 4 +
      insight.keywords.size * 2 +
      insight.sourceDomains.size +
      (safeArray(insight.original.sources).length ? 1 : 0)
    );
  }

  function normalizeInsight(insight, index) {
    const original = insight || {};
    const sources = safeArray(original.sources).map((source) => ({
      url: safeString(source?.url),
      title: safeString(source?.title),
      domain: normalizeDomain(source?.domain || source?.url),
      analyzedAt: safeString(source?.analyzedAt),
    }));

    const topicLabels = new Set(extractTopicLabels(original.topic));
    const topicTokens = new Set(tokenize([...topicLabels]));
    const sourceDomains = new Set(sources.map((source) => source.domain).filter(Boolean));
    const sourceUrls = new Set(sources.map((source) => source.url).filter(Boolean));
    const sourceTokens = new Set(
      tokenize(sources.map((source) => `${source.title} ${source.domain}`))
    );
    const keywordCounts = buildTokenCounts([
      original.topic,
      original.summary,
      original.evidence,
      ...sources.map((source) => source.title),
    ]);
    const keywords = mapKeysToSet(keywordCounts);
    const addedAt = safeString(original.addedAt) || safeString(sources[0]?.analyzedAt);
    const addedAtMs = parseTimestamp(addedAt);
    const primaryTopic = [...topicLabels][0] || '';

    return {
      original,
      key: `${safeString(original.topic)}::${safeString(original.summary)}`,
      index,
      addedAt,
      addedAtMs,
      primaryTopic,
      sources,
      topicLabels,
      topicTokens,
      sourceDomains,
      sourceUrls,
      sourceTokens,
      keywordCounts,
      keywords,
    };
  }

  function createWorkingCluster(seed) {
    const cluster = {
      items: [seed],
      topicLabels: new Set(seed.topicLabels),
      topicTokens: new Set(seed.topicTokens),
      sourceDomains: new Set(seed.sourceDomains),
      sourceUrls: new Set(seed.sourceUrls),
      sourceTokens: new Set(seed.sourceTokens),
      topicLabelCounts: new Map(),
      keywordCounts: new Map(seed.keywordCounts),
      domainCounts: new Map(),
      latestAddedAtMs: seed.addedAtMs,
      earliestAddedAtMs: seed.addedAtMs,
    };

    for (const label of seed.topicLabels) {
      incrementMap(cluster.topicLabelCounts, label);
    }
    for (const domain of seed.sourceDomains) {
      incrementMap(cluster.domainCounts, domain);
    }

    return cluster;
  }

  function addInsightToCluster(cluster, insight) {
    cluster.items.push(insight);
    mergeSet(cluster.topicLabels, insight.topicLabels);
    mergeSet(cluster.topicTokens, insight.topicTokens);
    mergeSet(cluster.sourceDomains, insight.sourceDomains);
    mergeSet(cluster.sourceUrls, insight.sourceUrls);
    mergeSet(cluster.sourceTokens, insight.sourceTokens);

    for (const label of insight.topicLabels) {
      incrementMap(cluster.topicLabelCounts, label);
    }
    for (const [token, count] of insight.keywordCounts.entries()) {
      incrementMap(cluster.keywordCounts, token, count);
    }
    for (const domain of insight.sourceDomains) {
      incrementMap(cluster.domainCounts, domain);
    }

    if (insight.addedAtMs != null) {
      cluster.latestAddedAtMs = cluster.latestAddedAtMs == null
        ? insight.addedAtMs
        : Math.max(cluster.latestAddedAtMs, insight.addedAtMs);
      cluster.earliestAddedAtMs = cluster.earliestAddedAtMs == null
        ? insight.addedAtMs
        : Math.min(cluster.earliestAddedAtMs, insight.addedAtMs);
    }
  }

  function scoreClusterMatch(insight, cluster) {
    let score = 0;

    if (sharesAny(insight.topicLabels, cluster.topicLabels)) {
      score += 0.52;
    }

    score += jaccard(insight.topicTokens, cluster.topicTokens) * 0.2;
    score += jaccard(insight.keywords, mapKeysToSet(cluster.keywordCounts)) * 0.38;
    score += jaccard(insight.sourceTokens, cluster.sourceTokens) * 0.08;

    if (sharesAny(insight.sourceDomains, cluster.sourceDomains)) {
      score += 0.18;
    }

    if (sharesAny(insight.sourceUrls, cluster.sourceUrls)) {
      score += 0.16;
    }

    return score;
  }

  function clusterInsightsHeuristic(normalizedInsights, options = {}) {
    const threshold = Number.isFinite(options.similarityThreshold) ? options.similarityThreshold : 0.34;
    const ordered = [...normalizedInsights].sort((a, b) => {
      return scoreInsightRichness(b) - scoreInsightRichness(a) || compareByAddedAtAscending(a, b);
    });

    const clusters = [];

    for (const insight of ordered) {
      let bestCluster = null;
      let bestScore = 0;

      for (const cluster of clusters) {
        const score = scoreClusterMatch(insight, cluster);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = cluster;
        }
      }

      if (bestCluster && bestScore >= threshold) {
        addInsightToCluster(bestCluster, insight);
      } else {
        clusters.push(createWorkingCluster(insight));
      }
    }

    return clusters;
  }

  function chooseClusterTitle(cluster) {
    const dominantTopic = topEntries(cluster.topicLabelCounts, 1, (label) => !GENERIC_TOPIC_LABELS.has(label))[0]?.[0];
    if (dominantTopic) {
      return formatToken(dominantTopic);
    }

    const topKeywords = topEntries(cluster.keywordCounts, 2);
    if (topKeywords.length >= 2) {
      return `${formatToken(topKeywords[0][0])} and ${formatToken(topKeywords[1][0])}`;
    }
    if (topKeywords.length === 1) {
      return formatToken(topKeywords[0][0]);
    }

    const domain = topEntries(cluster.domainCounts, 1)[0]?.[0];
    if (domain) {
      return `Insights from ${formatDomain(domain)}`;
    }

    return cluster.items.length === 1 ? 'Captured Insight' : 'Related Insights';
  }

  function buildClusterSharedTags(cluster, title) {
    const titleTokens = new Set(tokenize(title));
    const shared = [];
    const dominantTopic = topEntries(cluster.topicLabelCounts, 1, (label) => !GENERIC_TOPIC_LABELS.has(label))[0]?.[0];
    if (dominantTopic) {
      shared.push(formatToken(dominantTopic));
    }

    for (const [token] of topEntries(cluster.keywordCounts, 4, (token) => !titleTokens.has(token))) {
      shared.push(formatToken(token));
    }

    for (const [domain] of topEntries(cluster.domainCounts, 2)) {
      shared.push(formatDomain(domain));
    }

    return dedupe(shared).slice(0, 3);
  }

  function formatList(items) {
    if (!items.length) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  }

  function buildClusterSummary(cluster, title, sharedTags) {
    const count = cluster.items.length;
    const lead = count === 1
      ? `This insight focuses on ${title.toLowerCase()}.`
      : `These ${count} insights focus on ${title.toLowerCase()}.`;

    const reasons = [];
    const topicLabel = topEntries(cluster.topicLabelCounts, 1, (label) => !GENERIC_TOPIC_LABELS.has(label))[0]?.[0];
    const domains = topEntries(cluster.domainCounts, 2).map(([domain]) => formatDomain(domain));
    const keywords = sharedTags.filter((tag) => !domains.includes(tag)).slice(0, 2);

    if (topicLabel && formatToken(topicLabel) !== title) {
      reasons.push(`a shared topic label around ${formatToken(topicLabel)}`);
    }
    if (keywords.length) {
      reasons.push(`overlapping terms like ${formatList(keywords)}`);
    }
    if (domains.length) {
      reasons.push(`source overlap from ${formatList(domains)}`);
    }

    if (!reasons.length) {
      return lead;
    }

    const grouped = count === 1
      ? `It was grouped from repeated topic signals, including ${formatList(reasons)}.`
      : `They were grouped together because they share ${formatList(reasons)}.`;

    return `${lead} ${grouped}`.trim();
  }

  function buildGroupingReason(sharedTags) {
    if (!sharedTags.length) {
      return 'Grouped by overlapping topic, keyword, and source signals.';
    }
    return `Grouped by shared signals: ${sharedTags.join(' • ')}`;
  }

  function buildInsightTags(insight, cluster, title) {
    const titleTokens = new Set(tokenize(title));
    const tags = [];

    if (insight.primaryTopic) {
      const formattedTopic = formatToken(insight.primaryTopic);
      if (formattedTopic !== title) {
        tags.push(formattedTopic);
      }
    }

    const rankedKeywords = [...insight.keywordCounts.entries()]
      .filter(([token]) => cluster.keywordCounts.has(token))
      .sort((a, b) => {
        const clusterWeight = (cluster.keywordCounts.get(b[0]) || 0) - (cluster.keywordCounts.get(a[0]) || 0);
        return clusterWeight || b[1] - a[1] || a[0].localeCompare(b[0]);
      })
      .map(([token]) => token);

    for (const token of rankedKeywords) {
      if (titleTokens.has(token)) continue;
      tags.push(formatToken(token));
    }

    if (!tags.length) {
      for (const [token] of topEntries(insight.keywordCounts, 3, (token) => !titleTokens.has(token))) {
        tags.push(formatToken(token));
      }
    }

    return dedupe(tags).slice(0, 3);
  }

  function finalizeCluster(cluster) {
    const title = chooseClusterTitle(cluster);
    const sharedTags = buildClusterSharedTags(cluster, title);
    const insights = [...cluster.items]
      .sort(compareByAddedAtAscending)
      .map((item) => ({
        ...item,
        tags: buildInsightTags(item, cluster, title),
      }));

    const idSource = insights.map((item) => item.key).sort().join('|');
    return {
      id: `cluster-${simpleHash(idSource || title)}`,
      title,
      summary: buildClusterSummary(cluster, title, sharedTags),
      reasonText: buildGroupingReason(sharedTags),
      sharedTags,
      insights,
      insightCount: insights.length,
      latestAddedAtMs: cluster.latestAddedAtMs,
    };
  }

  function compareClusters(a, b) {
    return (
      b.insightCount - a.insightCount ||
      (b.latestAddedAtMs || 0) - (a.latestAddedAtMs || 0) ||
      a.title.localeCompare(b.title)
    );
  }

  function prepareInsightViewModel(insights, options = {}) {
    const normalizedInsights = safeArray(insights).map(normalizeInsight);

    if (!normalizedInsights.length) {
      return { timeline: [], clusters: [] };
    }

    // Swap this hook for an embedding-backed clusterer later without changing the sidebar renderer.
    const clusterer = typeof options.clusterer === 'function'
      ? options.clusterer
      : clusterInsightsHeuristic;

    const clusters = clusterer(normalizedInsights, options)
      .map(finalizeCluster)
      .sort(compareClusters);

    const timeline = [...normalizedInsights]
      .sort(compareByAddedAtAscending)
      .map((item) => ({
        ...item,
        tags: buildInsightTags(item, { keywordCounts: item.keywordCounts }, item.primaryTopic || ''),
      }));

    return { timeline, clusters };
  }

  global.ResearchCopilotInsightGrouping = Object.freeze({
    prepareInsightViewModel,
    clusterInsightsHeuristic,
  });
})(globalThis);
