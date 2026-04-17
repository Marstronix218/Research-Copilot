// PDF detection helpers shared by capture and auto-analysis flows.
// These utilities intentionally combine URL/path/query/title heuristics.

const PDF_EXTENSION_PATTERN = /\.pdf(?:$|[/?#])/i;
const PDF_MIME_PATTERN = /\bapplication\/pdf\b/i;
const PDF_VIEWER_QUERY_KEYS = ['src', 'file', 'url'];
const PDF_FILENAME_QUERY_KEYS = new Set([
  'attachment',
  'download',
  'file',
  'filename',
  'name',
  'response-content-disposition',
]);
const PDF_FORMAT_QUERY_KEYS = new Set([
  'content-type',
  'format',
  'mime',
  'response-content-type',
  'type',
]);

function tryParseUrl(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pathnameLooksLikePdf(pathname) {
  return PDF_EXTENSION_PATTERN.test(decodePart(pathname || ''));
}

function valueLooksLikePdfFilename(value) {
  return PDF_EXTENSION_PATTERN.test(decodePart(value || ''));
}

function queryValueLooksLikePdf(key, value) {
  const normalizedKey = String(key || '').toLowerCase();
  const normalizedValue = decodePart(String(value || '')).toLowerCase();
  if (!normalizedValue) return false;

  if (PDF_MIME_PATTERN.test(normalizedValue)) {
    return true;
  }

  if (PDF_FORMAT_QUERY_KEYS.has(normalizedKey) && normalizedValue === 'pdf') {
    return true;
  }

  if (PDF_FILENAME_QUERY_KEYS.has(normalizedKey) && valueLooksLikePdfFilename(normalizedValue)) {
    return true;
  }

  return valueLooksLikePdfFilename(normalizedValue);
}

export function contentTypeSuggestsPdf(contentType) {
  // Accept common MIME variants as long as they include application/pdf.
  return PDF_MIME_PATTERN.test(String(contentType || ''));
}

export function resolvePdfResourceUrl(input) {
  // Some viewers embed the real PDF in query params such as ?file=... or ?src=...
  const rawUrl = typeof input === 'string' ? input : input?.url || '';
  const parsed = tryParseUrl(rawUrl);
  if (!parsed) {
    return rawUrl;
  }

  for (const key of PDF_VIEWER_QUERY_KEYS) {
    const value = parsed.searchParams.get(key);
    if (!value) continue;
    const decoded = decodePart(value);
    if (decoded) {
      return decoded;
    }
  }

  return rawUrl;
}

export function urlClearlyIndicatesPdf(rawUrl) {
  // Fast path for obvious *.pdf URLs; fallback to query/hash signal checks.
  const parsed = tryParseUrl(rawUrl);
  if (!parsed) {
    return valueLooksLikePdfFilename(rawUrl);
  }

  if (pathnameLooksLikePdf(parsed.pathname)) {
    return true;
  }

  if (contentTypeSuggestsPdf(parsed.search) || contentTypeSuggestsPdf(parsed.hash)) {
    return true;
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    if (queryValueLooksLikePdf(key, value)) {
      return true;
    }
  }

  return valueLooksLikePdfFilename(parsed.hash);
}

export function titleSuggestsPdf(title) {
  return /\.pdf(?:$|[\s)\]}])/i.test(String(title || '').trim());
}

export function shouldProbePdfContentType(tab, resolvedUrl = resolvePdfResourceUrl(tab)) {
  // HEAD probing is only for uncertain http(s) URLs to avoid unnecessary network churn.
  const parsed = tryParseUrl(resolvedUrl);
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    return false;
  }

  if (urlClearlyIndicatesPdf(resolvedUrl)) {
    return false;
  }

  if (titleSuggestsPdf(tab?.title)) {
    return true;
  }

  for (const key of parsed.searchParams.keys()) {
    const normalizedKey = String(key || '').toLowerCase();
    if (PDF_FILENAME_QUERY_KEYS.has(normalizedKey) || PDF_FORMAT_QUERY_KEYS.has(normalizedKey)) {
      return true;
    }
  }

  return false;
}

export function tabCouldBePdf(tab) {
  // Return both the decision and reasons so callers can debug detection behavior.
  const rawUrl = tab?.url || '';
  const resolvedUrl = resolvePdfResourceUrl(tab);
  const reasons = [];

  if (resolvedUrl && resolvedUrl !== rawUrl) {
    reasons.push('viewer-url');
  }

  if (urlClearlyIndicatesPdf(resolvedUrl)) {
    reasons.push('url');
  }

  if (titleSuggestsPdf(tab?.title)) {
    reasons.push('title');
  }

  return {
    isPdfHint: reasons.length > 0,
    reasons,
    resolvedUrl,
  };
}
