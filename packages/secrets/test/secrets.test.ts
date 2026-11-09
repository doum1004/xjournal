import { describe, expect, test } from 'bun:test';
import { connectorSecretRef, memorySecrets, osKeychain, redact } from '../src';

describe('secrets', () => {
  test('memory store round-trips and deletes', async () => {
    const s = memorySecrets();
    await s.set('a', 'one');
    expect(await s.get('a')).toBe('one');
    expect(await s.delete('a')).toBe(true);
    expect(await s.delete('a')).toBe(false);
    expect(await s.get('a')).toBeNull();
  });

  test('redact replaces every occurrence and ignores empty or tiny values', () => {
    expect(redact('a=TOKEN1 b=TOKEN1', ['TOKEN1'])).toBe('a=[redacted] b=[redacted]');
    expect(redact('abc', [null, undefined, '', 'ab'])).toBe('abc');
  });

  test('connector refs are namespaced', () => {
    expect(connectorSecretRef('01ABC')).toBe('connector/01ABC');
  });

  // Touches the real OS credential store, so it runs only when asked for.
  test.skipIf(!process.env.HUB_TEST_OS_KEYCHAIN)('OS keychain round-trips', async () => {
    const s = osKeychain('xjournal-test');
    const ref = `test/${crypto.randomUUID()}`;
    await s.set(ref, 'value-1');
    expect(await s.get(ref)).toBe('value-1');
    expect(await s.delete(ref)).toBe(true);
    expect(await s.get(ref)).toBeNull();
  });
});
