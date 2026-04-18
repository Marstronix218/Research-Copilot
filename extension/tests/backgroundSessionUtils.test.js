import { describe, expect, it } from 'vitest';

import {
  collectTopicsFromInsights,
  mergeInsights,
  mergeSources,
  safeDomain,
} from '../background/sessionUtils.js';

describe('background/sessionUtils', () => {
  it('collects unique topics case-insensitively', () => {
    const topics = collectTopicsFromInsights([
      { topic: 'AI Policy' },
      { topic: 'ai policy' },
      { topic: 'Climate' },
    ]);

    expect(topics).toEqual(['AI Policy', 'Climate']);
  });

  it('merges insights by topic+summary and appends new source only once', () => {
    const existing = [
      {
        topic: 'AI Policy',
        summary: 'Regulatory direction in OECD countries',
        sources: [{ url: 'https://a.example.com' }],
      },
    ];

    const incoming = [
      {
        topic: 'AI Policy',
        summary: 'Regulatory direction in OECD countries',
      },
      {
        topic: 'Climate',
        summary: 'Adaptation strategies in urban areas',
      },
    ];

    const source = { url: 'https://b.example.com', title: 'Source B' };
    const merged = mergeInsights(existing, incoming, source);

    expect(merged).toHaveLength(2);
    const aiInsight = merged.find((item) => item.topic === 'AI Policy');
    expect(aiInsight.sources).toHaveLength(2);

    const mergedAgain = mergeInsights(merged, incoming, source);
    const aiInsightAgain = mergedAgain.find((item) => item.topic === 'AI Policy');
    expect(aiInsightAgain.sources).toHaveLength(2);
  });

  it('merges sources by URL and updates metadata', () => {
    const existing = [{ url: 'https://a.example.com', title: 'Old title' }];
    const merged = mergeSources(existing, { url: 'https://a.example.com', title: 'New title' });

    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('New title');
  });

  it('extracts domain safely', () => {
    expect(safeDomain('https://example.org/path')).toBe('example.org');
    expect(safeDomain('not-a-url')).toBe('');
  });
});
