import { describe, expect, it } from 'vitest';

import '../insightGrouping.js';

const groupingApi = globalThis.ResearchCopilotInsightGrouping;

describe('ResearchCopilotInsightGrouping', () => {
  it('exposes grouping API on globalThis', () => {
    expect(groupingApi).toBeDefined();
    expect(typeof groupingApi.prepareInsightViewModel).toBe('function');
  });

  it('returns empty timeline and clusters for empty input', () => {
    const result = groupingApi.prepareInsightViewModel([]);

    expect(result.timeline).toEqual([]);
    expect(result.clusters).toEqual([]);
  });

  it('groups related insights by shared lexical and source signals', () => {
    const insights = [
      {
        topic: 'AI policy',
        summary: 'Japan published new AI policy guidance.',
        evidence: 'Policy draft was announced this quarter.',
        addedAt: '2026-01-01T00:00:00.000Z',
        sources: [
          {
            url: 'https://oecd.org/ai/policy',
            title: 'OECD AI policy guidance',
          },
        ],
      },
      {
        topic: 'AI regulation',
        summary: 'OECD framework compares AI policy strategies.',
        evidence: 'Comparative framework includes risk categories.',
        addedAt: '2026-01-02T00:00:00.000Z',
        sources: [
          {
            url: 'https://oecd.org/ai/framework',
            title: 'OECD AI framework',
          },
        ],
      },
    ];

    const result = groupingApi.prepareInsightViewModel(insights);

    expect(result.timeline.length).toBe(2);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].insightCount).toBe(2);
    expect(result.clusters[0].sharedTags.length).toBeGreaterThan(0);
  });
});
