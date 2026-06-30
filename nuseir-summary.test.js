import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNuseirSummary, pendingNuseirStatus } from './nuseir-summary.js';

test('buildNuseirSummary includes only Pending Nuseir proposals', () => {
  const summary = buildNuseirSummary([
    {
      id: 1,
      status: pendingNuseirStatus,
      event_date: '2026-07-02',
      assessment: {
        proposal_name: 'Global Leaders Retreat 2026',
        next_step: 'Decide whether to attend.',
        decision_reason: 'High-level network and travel is covered.'
      }
    },
    {
      id: 2,
      status: 'Rejected',
      assessment: { proposal_name: 'Skip me' }
    }
  ]);

  assert.match(summary, /Global Leaders Retreat 2026/);
  assert.match(summary, /Decide whether to attend\./);
  assert.match(summary, /High-level network and travel is covered\./);
  assert.doesNotMatch(summary, /Skip me/);
});

test('buildNuseirSummary shows empty state when no proposals are pending', () => {
  const summary = buildNuseirSummary([]);
  assert.match(summary, /No proposals are currently marked "Pending Nuseir"\./);
});
