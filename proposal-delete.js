export async function deleteProposalById({ pool, id, afterDelete = () => {} }) {
  if (!pool) {
    const error = new Error('Proposal database is not connected.');
    error.status = 503;
    throw error;
  }

  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error('Invalid proposal ID.');
    error.status = 400;
    throw error;
  }

  const result = await pool.query(
    `DELETE FROM scout_proposals
     WHERE id = $1
     RETURNING id, assessment`,
    [id]
  );

  if (!result.rowCount) {
    const error = new Error('Proposal not found.');
    error.status = 404;
    throw error;
  }

  afterDelete();
  return result.rows[0];
}
