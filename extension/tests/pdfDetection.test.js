import { describe, expect, it } from 'vitest';

import {
  resolvePdfResourceUrl,
  shouldProbePdfContentType,
  tabCouldBePdf,
  titleSuggestsPdf,
  urlClearlyIndicatesPdf,
} from '../pdf/pdfDetection.js';

describe('pdfDetection helpers', () => {
  it('extracts embedded PDF resource URL from viewer query params', () => {
    const resolved = resolvePdfResourceUrl(
      'https://example.com/viewer?file=https%3A%2F%2Fcdn.example.com%2Freport.pdf',
    );

    expect(resolved).toBe('https://cdn.example.com/report.pdf');
  });

  it('detects explicit PDF URLs', () => {
    expect(urlClearlyIndicatesPdf('https://example.com/files/report.pdf')).toBe(true);
    expect(urlClearlyIndicatesPdf('https://example.com/download?format=pdf')).toBe(true);
  });

  it('probes uncertain URLs when title suggests PDF', () => {
    const shouldProbe = shouldProbePdfContentType({
      url: 'https://example.com/download?id=123',
      title: 'Midterm_Report.pdf',
    });

    expect(shouldProbe).toBe(true);
  });

  it('returns PDF hint reasons from tab context', () => {
    const result = tabCouldBePdf({
      url: 'https://example.com/viewer?file=https%3A%2F%2Fcdn.example.com%2Fnotes.pdf',
      title: 'Course Notes.pdf',
    });

    expect(result.isPdfHint).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('detects PDF-like titles', () => {
    expect(titleSuggestsPdf('Chapter 5 slides.pdf')).toBe(true);
    expect(titleSuggestsPdf('Chapter 5 slides')).toBe(false);
  });
});
