const DISTRACTION_PATTERNS = [
  { category: 'social', penalty: 0.22, patterns: ['x.com', 'twitter.com', 'instagram.com', 'tiktok.com', 'reddit.com'] },
  { category: 'video', penalty: 0.18, patterns: ['youtube.com', 'youtu.be'] },
  { category: 'shopping', penalty: 0.2, patterns: ['amazon.', 'ebay.', 'rakuten.', 'walmart.', 'aliexpress.', 'etsy.'] },
  { category: 'messaging', penalty: 0.2, patterns: ['discord.com', 'slack.com', 'messenger.com', 'web.whatsapp.com', 'teams.microsoft.com'] },
];

const RESEARCH_DOMAIN_HINTS = ['.gov', '.edu', '.ac.', 'who.int', 'oecd.org', 'imf.org', 'worldbank.org', 'wikipedia.org', 'nature.com', 'science.org', 'reuters.com', 'bbc.com'];
const GENTLE_GENERAL_DOMAINS = ['wikipedia.org', 'britannica.com', 'medium.com', 'substack.com', 'nytimes.com', 'theguardian.com'];

// TODO: Replace heuristic scoring with backend/LLM classifier when available.
// TODO: Expand domain-category map with locale-specific distraction/research sites.

function clip01(value) {
  return Math.max(0, Math.min(1, value));
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 3);
}

function unique(items) {
  return [...new Set(items)];
}

function includesDomain(domain, pattern) {
  if (!domain || !pattern) return false;
  return domain.includes(pattern);
}

function getDistractionMatch(domain) {
  for (const group of DISTRACTION_PATTERNS) {
    for (const pattern of group.patterns) {
      if (includesDomain(domain, pattern)) {
        return {
          isDistraction: true,
          distractionCategory: group.category,
          penalty: group.penalty,
          reason: `domain matches ${group.category} pattern: ${pattern}`,
        };
      }
    }
  }
  return {
    isDistraction: false,
    distractionCategory: null,
    penalty: 0,
    reason: null,
  };
}

export function scorePageRelevance({
  goal,
  keywords = [],
  researchQuestions = [],
  url,
  domain,
  title,
  snippet,
  manualOverride,
}) {
  const reasons = [];

  if (manualOverride) {
    return {
      score: 0.95,
      label: 'high',
      matchedKeywords: [],
      isDistraction: false,
      distractionCategory: null,
      reasons: ['manually marked relevant for this session'],
    };
  }

  const haystack = [title, domain, url, snippet].join(' ').toLowerCase();
  const baseKeywords = unique([...tokenize(goal), ...keywords, ...tokenize(researchQuestions.join(' '))]);
  const matchedKeywords = baseKeywords.filter((k) => haystack.includes(k));
  const overlapRatio = baseKeywords.length > 0 ? matchedKeywords.length / baseKeywords.length : 0;

  const distraction = getDistractionMatch(domain || '');

  let score = 0.34;
  if (overlapRatio > 0) {
    score += Math.min(0.45, overlapRatio * 0.85);
    reasons.push(`keyword overlap ${(overlapRatio * 100).toFixed(0)}%`);
  } else {
    reasons.push('no meaningful keyword overlap');
  }

  if (RESEARCH_DOMAIN_HINTS.some((d) => includesDomain(domain, d))) {
    score += 0.1;
    reasons.push('research-oriented domain boost');
  }

  if (GENTLE_GENERAL_DOMAINS.some((d) => includesDomain(domain, d))) {
    score += 0.05;
    reasons.push('general educational/news domain treated gently');
  }

  if (distraction.isDistraction) {
    score -= distraction.penalty;
    reasons.push(distraction.reason);
  }

  // Strong overlap can offset distraction penalties (e.g., educational video on YouTube).
  if (distraction.isDistraction && overlapRatio >= 0.35) {
    score += 0.12;
    reasons.push('strong overlap offsets distraction penalty');
  }

  score = clip01(score);

  let label = 'unrelated';
  if (score >= 0.75) label = 'high';
  else if (score >= 0.5) label = 'medium';
  else if (score >= 0.3) label = 'low';

  return {
    score,
    label,
    matchedKeywords: matchedKeywords.slice(0, 8),
    isDistraction: distraction.isDistraction,
    distractionCategory: distraction.distractionCategory,
    reasons,
  };
}
