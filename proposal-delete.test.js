import test from 'node:test';
import assert from 'node:assert/strict';

import { deleteProposalById } from './proposal-delete.js';

test('deleteProposalById deletes an existing proposal and runs follow-up sync', async () => {
  let synced = false;
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return {
        rowCount: 1,
        rows: [{ id: 17, assessment: { proposal_name: 'Test proposal' } }]
      };
    }
  };

  const deleted = await deleteProposalById({
    pool,
    id: 17,
    afterDelete: () => {
      synced = true;
    }
  });

  assert.equal(deleted.id, 17);
  assert.equal(deleted.assessment.proposal_name, 'Test proposal');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [17]);
  assert.match(calls[0].sql, /DELETE FROM scout_proposals/i);
  assert.equal(synced, true);
});

test('deleteProposalById rejects invalid ids before touching the database', async () => {
  let queried = false;
  const pool = {
    async query() {
      queried = true;
      return { rowCount: 0, rows: [] };
    }
  };

  await assert.rejects(
    deleteProposalById({ pool, id: 0 }),
    error => error.message === 'Invalid proposal ID.' && error.status === 400
  );
  assert.equal(queried, false);
});

test('deleteProposalById returns a 404 when the proposal no longer exists', async () => {
  const pool = {
    async query() {
      return { rowCount: 0, rows: [] };
    }
  };

  await assert.rejects(
    deleteProposalById({ pool, id: 999 }),
    error => error.message === 'Proposal not found.' && error.status === 404
  );
});
