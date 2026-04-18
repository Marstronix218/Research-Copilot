// Runtime message contract helpers for extension internal messaging.

/**
 * Validate and normalize a chrome.runtime message payload.
 *
 * This keeps message handlers resilient to malformed inputs while preserving
 * backwards compatibility for callers that omit payload.
 */
export function parseRuntimeMessage(message) {
  if (!message || typeof message !== 'object') {
    return { ok: false, error: 'Invalid message object' };
  }

  const type = typeof message.type === 'string' ? message.type.trim() : '';
  if (!type) {
    return { ok: false, error: 'Missing message type' };
  }

  const payload = message.payload == null ? {} : message.payload;
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Message payload must be an object when provided' };
  }

  return { ok: true, type, payload };
}
