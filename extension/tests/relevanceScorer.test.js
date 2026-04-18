import { describe, expect, it } from 'vitest';

import { scorePageRelevance } from '../relevanceScorer.js';

describe('scorePageRelevance', () => {
  it('returns high relevance immediately when manual override is set', () => {
    const result = scorePageRelevance({
      goal: 'understand poverty in japan',
      url: 'https://example.com',
      domain: 'example.com',
      title: 'Random page',
      snippet: 'Random snippet',
      manualOverride: true,
    });

    expect(result.score).toBe(0.95);
    expect(result.label).toBe('high');
    expect(result.isDistraction).toBe(false);
  });

  it('applies research-domain boost compared with a neutral domain', () => {
    const baseInput = {
      goal: 'child nutrition policy',
      url: 'https://example.com/report',
      title: 'Child nutrition policy report',
      snippet: 'policy analysis for child nutrition outcomes',
      manualOverride: false,
    };

    const neutral = scorePageRelevance({ ...baseInput, domain: 'example.com' });
    const research = scorePageRelevance({ ...baseInput, domain: 'who.int' });

    expect(research.score).toBeGreaterThan(neutral.score);
    expect(research.reasons.some((item) => item.includes('research-oriented domain boost'))).toBe(true);
  });

  it('offsets distraction penalty when keyword overlap is strong', () => {
    const result = scorePageRelevance({
      goal: 'climate change documentary',
      url: 'https://youtube.com/watch?v=abc',
      domain: 'youtube.com',
      title: 'Climate change documentary',
      snippet: 'documentary about climate change and policy response',
      manualOverride: false,
    });

    expect(result.isDistraction).toBe(true);
    expect(result.distractionCategory).toBe('video');
    expect(result.reasons.some((item) => item.includes('strong overlap offsets distraction penalty'))).toBe(true);
    expect(result.score).toBeGreaterThan(0.5);
  });
});
