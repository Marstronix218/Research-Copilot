import { describe, expect, it } from 'vitest';

import {
  collectTopicsFromInsights,
  finalizeCurrentHistoryItem,
  mergeInsights,
  mergeSources,
  safeDomain,
  updateBrowsingStateForActiveTab,
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

  it('finalizes the active history item with dwell time', () => {
    const finalized = finalizeCurrentHistoryItem([
      {
        url: 'https://example.org/a',
        startedAt: 1_000,
        endedAt: null,
        dwellMs: 0,
      },
    ], 2_500);

    expect(finalized).toEqual([
      expect.objectContaining({
        url: 'https://example.org/a',
        endedAt: 2_500,
        dwellMs: 1_500,
      }),
    ]);
  });

  it('treats a same-url completed load as a new browsing visit', () => {
    const updated = updateBrowsingStateForActiveTab({
      browsingState: {
        currentTabId: 12,
        currentUrl: 'https://www.youtube.com/watch?v=abc',
        currentDomain: 'www.youtube.com',
        currentTitle: 'Video',
        currentSnippet: 'Existing snippet',
        currentTabStartedAt: 1_000,
        lastUserActivityAt: 1_100,
        recentHistory: [
          {
            tabId: 12,
            url: 'https://www.youtube.com/watch?v=abc',
            domain: 'www.youtube.com',
            title: 'Video',
            startedAt: 1_000,
            endedAt: null,
            dwellMs: 0,
            relevanceScore: 0.2,
            relevanceLabel: 'low',
            isDistraction: true,
            distractionCategory: 'video',
          },
        ],
      },
      tabId: 12,
      url: 'https://www.youtube.com/watch?v=abc',
      title: 'Video',
      now: 2_000,
      maxRecentHistoryItems: 10,
      treatAsNewVisit: true,
      recordActivity: true,
    });

    expect(updated.currentTabStartedAt).toBe(2_000);
    expect(updated.currentSnippet).toBe('');
    expect(updated.lastUserActivityAt).toBe(2_000);
    expect(updated.recentHistory).toHaveLength(2);
    expect(updated.recentHistory[0]).toEqual(expect.objectContaining({
      endedAt: 2_000,
      dwellMs: 1_000,
      relevanceLabel: 'low',
    }));
    expect(updated.recentHistory[1]).toEqual(expect.objectContaining({
      startedAt: 2_000,
      endedAt: null,
      relevanceLabel: 'unknown',
    }));
  });

  it('does not refresh activity timestamp for passive drift ticks', () => {
    const updated = updateBrowsingStateForActiveTab({
      browsingState: {
        currentTabId: 12,
        currentUrl: 'https://example.org/page',
        currentDomain: 'example.org',
        currentTitle: 'Page',
        currentSnippet: 'Snippet',
        currentTabStartedAt: 1_000,
        lastUserActivityAt: 1_500,
        recentHistory: [],
      },
      tabId: 12,
      url: 'https://example.org/page',
      title: 'Page',
      now: 5_000,
      maxRecentHistoryItems: 10,
      treatAsNewVisit: false,
      recordActivity: false,
    });

    expect(updated.lastUserActivityAt).toBe(1_500);
    expect(updated.currentTabStartedAt).toBe(1_000);
    expect(updated.recentHistory).toEqual([]);
  });
});
