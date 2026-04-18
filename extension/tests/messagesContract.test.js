import { describe, expect, it } from 'vitest';

import { parseRuntimeMessage } from '../contracts/messages.js';

describe('parseRuntimeMessage', () => {
  it('accepts valid message and normalizes missing payload to object', () => {
    const parsed = parseRuntimeMessage({ type: 'PING_BACKEND' });

    expect(parsed.ok).toBe(true);
    expect(parsed.type).toBe('PING_BACKEND');
    expect(parsed.payload).toEqual({});
  });

  it('rejects malformed message objects', () => {
    expect(parseRuntimeMessage(null).ok).toBe(false);
    expect(parseRuntimeMessage('bad').ok).toBe(false);
  });

  it('rejects missing or empty message types', () => {
    expect(parseRuntimeMessage({}).ok).toBe(false);
    expect(parseRuntimeMessage({ type: '   ' }).ok).toBe(false);
  });

  it('rejects non-object payload values', () => {
    expect(parseRuntimeMessage({ type: 'X', payload: [] }).ok).toBe(false);
    expect(parseRuntimeMessage({ type: 'X', payload: 'text' }).ok).toBe(false);
  });
});
