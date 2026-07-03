import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

function timingSafeEqual(a, b) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function getAccessRole(req, env = process.env) {
  const adminKey = env.SCOUT_ADMIN_KEY?.trim();
  const viewerKey = env.SCOUT_VIEWER_KEY?.trim();
  const providedKey = req.headers['x-scout-admin-key'];
  if (typeof providedKey !== 'string') return 'none';
  const trimmed = providedKey.trim();
  if (adminKey && timingSafeEqual(trimmed, adminKey)) return 'admin';
  if (viewerKey && timingSafeEqual(trimmed, viewerKey)) return 'viewer';
  return 'none';
}

test('viewer key gets viewer role', () => {
  const role = getAccessRole({ headers: { 'x-scout-admin-key': 'view-123' } }, {
    SCOUT_ADMIN_KEY: 'admin-123',
    SCOUT_VIEWER_KEY: 'view-123'
  });
  assert.equal(role, 'viewer');
});

test('admin key stays admin', () => {
  const role = getAccessRole({ headers: { 'x-scout-admin-key': 'admin-123' } }, {
    SCOUT_ADMIN_KEY: 'admin-123',
    SCOUT_VIEWER_KEY: 'view-123'
  });
  assert.equal(role, 'admin');
});

test('unknown key gets no access', () => {
  const role = getAccessRole({ headers: { 'x-scout-admin-key': 'wrong' } }, {
    SCOUT_ADMIN_KEY: 'admin-123',
    SCOUT_VIEWER_KEY: 'view-123'
  });
  assert.equal(role, 'none');
});
