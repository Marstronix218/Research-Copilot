import { describe, expect, it } from 'vitest';

import { evaluateDrift } from '../driftDetector.js';

const NOW = 1_700_000_000_000;
const defaultSettings = {
  inactivityThresholdMs: 10 * 60 * 1000,
  unrelatedSoftThresholdMs: 4 * 60 * 1000,
  unrelatedNotifyThresholdMs: 6 * 60 * 1000,
  distractionNotifyThresholdMs: 5 * 60 * 1000,
};

describe('evaluateDrift', () => {
  it('returns focused when there is no active session', () => {
    const result = evaluateDrift({
      activeSession: null,
      browsingState: {},
      idleState: 'active',
      driftSettings: defaultSettings,
      now: NOW,
      currentPage: {},
    });

    expect(result.status).toBe('focused');
    expect(result.score).toBe(0);
    expect(result.shouldNotify).toBe(false);
  });

  it('flags inactivity when user is idle beyond threshold', () => {
    const result = evaluateDrift({
      activeSession: { isActive: true, goal: 'Research topic' },
      browsingState: { lastUserActivityAt: NOW - 11 * 60 * 1000 },
      idleState: 'idle',
      driftSettings: defaultSettings,
      now: NOW,
      currentPage: {},
    });

    expect(result.status).toBe('inactive');
    expect(result.shouldNotify).toBe(true);
    expect(result.notificationType).toBe('inactive');
  });

  it('marks drifting when there are three consecutive off-topic pages', () => {
    const result = evaluateDrift({
      activeSession: { isActive: true, goal: 'Research topic' },
      browsingState: {
        currentTabStartedAt: NOW - 2 * 60 * 1000,
        recentHistory: [
          { relevanceLabel: 'low', isDistraction: false },
          { relevanceLabel: 'unrelated', isDistraction: false },
          { relevanceLabel: 'low', isDistraction: true },
        ],
      },
      idleState: 'active',
      driftSettings: {
        ...defaultSettings,
        unrelatedNotifyThresholdMs: 30 * 60 * 1000,
        distractionNotifyThresholdMs: 30 * 60 * 1000,
      },
      now: NOW,
      currentPage: {
        url: 'https://example.com',
        relevanceScore: 0.2,
        relevanceLabel: 'low',
        isDistraction: false,
        distractionCategory: null,
      },
    });

    expect(result.status).toBe('drifting');
    expect(result.shouldNotify).toBe(true);
    expect(result.notificationType).toBe('distraction_pattern');
    expect(result.reasons.some((item) => item.includes('consecutive'))).toBe(true);
  });
});
