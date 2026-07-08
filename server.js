import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { buildLarkCardContent, buildScoutAssessmentCard } from './cards.js';
import { deleteProposalById } from './proposal-delete.js';

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const larkUserSessions = new Map();
const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false } }) : null;

const proposalStatuses = ['Pending Details', 'Pending Nuseir', 'Agreed; Pending Contract', 'Rejected', 'Contract Signed', 'Delivered'];
const opportunityTypes = ['Collaboration / Content Opportunity', 'Speaking Engagement', 'Partnership Proposal', 'Non-Profit / Cause Initiative', 'Media Opportunity', 'Other'];
const paymentStatuses = ['Pending', 'Paid', 'Pro-Bono'];
const sheetHeaders = ['ID', 'Created', 'Updated', 'Status', 'Proposal', 'Brand', 'Type', 'Recommendation', 'Summary', 'Requester', 'Requester Context', 'Timeline', 'Budget', 'Engagement Date', 'Location', 'Payment Status', 'Patty Commission Breakdown', 'Website/Social Links', 'Reach', 'Relevance', 'Potential Business', 'Requester Credibility', 'Time Cost', 'Ask', 'Next Step', 'Reason', 'Notes'];

function parseEnvList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function isAllowedLarkMessageTarget(receiveId, receiveIdType) {
  const allowlist = parseEnvList(process.env.COLLAB_ASSESSOR_LARK_ALLOWED_RECEIVE_IDS);
  if (!allowlist.length) return false;

  const candidates = new Set([
    receiveId,
    `${receiveIdType}:${receiveId}`,
    `${receiveIdType}=${receiveId}`
  ].filter(Boolean));

  return allowlist.some(entry => candidates.has(entry));
}

function getLarkMessageTarget() {
  const mode = process.env.COLLAB_ASSESSOR_LARK_MESSAGE_MODE?.trim().toLowerCase() || 'draft_only';

  if (mode === 'live') {
    const receiveId = process.env.COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID?.trim()
      || process.env.COLLAB_ASSESSOR_LARK_NUSEIR_EMAIL?.trim();
    const receiveIdType = process.env.COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID_TYPE?.trim()
      || (process.env.COLLAB_ASSESSOR_LARK_NUSEIR_EMAIL?.trim() ? 'email' : 'open_id');
    return { mode, receiveId, receiveIdType, label: 'live target' };
  }

  if (mode === 'test') {
    const receiveId = process.env.COLLAB_ASSESSOR_LARK_TEST_RECEIVE_ID?.trim()
      || process.env.COLLAB_ASSESSOR_LARK_TEST_EMAIL?.trim();
    const receiveIdType = process.env.COLLAB_ASSESSOR_LARK_TEST_RECEIVE_ID_TYPE?.trim()
      || (process.env.COLLAB_ASSESSOR_LARK_TEST_EMAIL?.trim() ? 'email' : 'chat_id');
    return { mode, receiveId, receiveIdType, label: 'test target' };
  }

  return { mode, receiveId: '', receiveIdType: '', label: 'disabled' };
}

async function runScoutAssessment({ system, content, updateProposalId = 0 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('Missing OPENAI_API_KEY in Render environment variables.');
    error.statusCode = 500;
    throw error;
  }

  if (!system || !Array.isArray(content)) {
    const error = new Error('Missing assessment content.');
    error.statusCode = 400;
    throw error;
  }

  const existingProposalId = Number(updateProposalId || 0);
  if (existingProposalId && !Number.isSafeInteger(existingProposalId)) {
    const error = new Error('Invalid proposal ID.');
    error.statusCode = 400;
    throw error;
  }

  const inputContent = content.map(item => {
    if (item.type === 'text') {
      return { type: 'input_text', text: item.text };
    }

    if (item.type === 'image' && item.source?.data) {
      return {
        type: 'input_image',
        image_url: `data:${item.source.media_type || 'image/png'};base64,${item.source.data}`
      };
    }

    return null;
  }).filter(Boolean);

  const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1',
      instructions: system,
      input: [{ role: 'user', content: inputContent }],
      max_output_tokens: 1600,
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      text: {
        format: {
          type: 'json_schema',
          name: 'opportunity_assessment',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              brand: { type: 'string' },
              proposal_name: { type: 'string' },
              opportunity_type: {
                type: 'string',
                enum: [
                  'Collaboration / Content Opportunity',
                  'Speaking Engagement',
                  'Partnership Proposal',
                  'Non-Profit / Cause Initiative',
                  'Media Opportunity',
                  'Other'
                ]
              },
              verdict: { type: 'string', enum: ['YES', 'MAYBE', 'NO'] },
              one_line_take: { type: 'string' },
              decision_reason: { type: 'string' },
              proposal_summary: { type: 'string' },
              requester_name: { type: 'string' },
              requester_context: { type: 'string' },
              timeline: { type: 'string' },
              location: { type: 'string' },
              budget: { type: 'string' },
              social_links: { type: 'string' },
              type_score_label: { type: 'string' },
              type_score: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
              type_score_reason: { type: 'string' },
              reach_score: { type: 'string', enum: ['STRONG', 'MEDIUM', 'WEAK'] },
              reach_reason: { type: 'string' },
              relevance_score: { type: 'string', enum: ['STRONG', 'MEDIUM', 'WEAK'] },
              relevance_reason: { type: 'string' },
              business_score: { type: 'string', enum: ['STRONG', 'MEDIUM', 'WEAK'] },
              business_reason: { type: 'string' },
              credibility_score: { type: 'string', enum: ['STRONG', 'MEDIUM', 'WEAK'] },
              credibility_reason: { type: 'string' },
              time_cost_score: { type: 'string', enum: ['WORTH IT', 'BORDERLINE', 'NOT WORTH IT'] },
              time_cost_reason: { type: 'string' },
              ask: { type: 'string' },
              next_step: { type: 'string' }
            },
            required: [
              'brand',
              'proposal_name',
              'opportunity_type',
              'verdict',
              'one_line_take',
              'decision_reason',
              'proposal_summary',
              'requester_name',
              'requester_context',
              'timeline',
              'location',
              'budget',
              'social_links',
              'type_score_label',
              'type_score',
              'type_score_reason',
              'reach_score',
              'reach_reason',
              'relevance_score',
              'relevance_reason',
              'business_score',
              'business_reason',
              'credibility_score',
              'credibility_reason',
              'time_cost_score',
              'time_cost_reason',
              'ask',
              'next_step'
            ]
          }
        }
      }
    })
  });

  const data = await openaiResponse.json();
  if (!openaiResponse.ok) {
    const error = new Error(data.error?.message || 'OpenAI request failed.');
    error.statusCode = openaiResponse.status;
    throw error;
  }

  const outputText = data.output_text || (data.output || [])
    .flatMap(item => item.content || [])
    .filter(part => part.type === 'output_text')
    .map(part => part.text)
    .join('');

  if (!outputText) {
    const error = new Error('OpenAI returned no assessment text.');
    error.statusCode = 500;
    throw error;
  }

  const assessment = JSON.parse(outputText);
  if (pool) {
    try {
      await databaseReady;
      const rawSourceText = content.filter(item => item.type === 'text').map(item => item.text || '').join('\n\n');
      const additionalMarker = 'Additional text:\n';
      const sourceText = (rawSourceText.includes(additionalMarker) ? rawSourceText.split(additionalMarker).slice(1).join(additionalMarker) : '').slice(0, 50000);
      let saved;
      if (existingProposalId) {
        const current = await pool.query('SELECT source_text, event_date, location FROM scout_proposals WHERE id = $1', [existingProposalId]);
        if (!current.rowCount) {
          const error = new Error('Proposal not found.');
          error.statusCode = 404;
          throw error;
        }
        const prior = current.rows[0];
        const mergedSource = [prior.source_text, sourceText].filter(Boolean).join('\n\n--- Update ---\n\n').slice(0, 50000);
        const proposedDate = String(assessment.timeline || '').trim();
        const proposedLocation = String(assessment.location || '').trim();
        const eventDate = proposedDate && !/not stated|unknown|tbd/i.test(proposedDate) ? proposedDate : prior.event_date;
        const location = proposedLocation && !/not stated|unknown|tbd/i.test(proposedLocation) ? proposedLocation : prior.location;
        saved = await pool.query(
          `UPDATE scout_proposals SET assessment = $1::jsonb, source_text = $2, event_date = $3, location = $4, updated_at = NOW()
           WHERE id = $5 RETURNING id, created_at, status`,
          [JSON.stringify(assessment), mergedSource, eventDate || '', location || '', existingProposalId]
        );
      } else {
        saved = await pool.query(
          'INSERT INTO scout_proposals (assessment, source_text, event_date, location) VALUES ($1::jsonb, $2, $3, $4) RETURNING id, created_at, status',
          [JSON.stringify(assessment), sourceText, String(assessment.timeline || ''), String(assessment.location || '')]
        );
      }
      let screenshotIndex = 0;
      for (const item of content.filter(item => item.type === 'image' && item.source?.data)) {
        const imageData = Buffer.from(item.source.data, 'base64');
        if (!imageData.length || imageData.length > 10 * 1024 * 1024) continue;
        screenshotIndex += 1;
        const mimeType = String(item.source.media_type || 'image/jpeg');
        const extension = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
        await pool.query(
          `INSERT INTO scout_proposal_files (proposal_id, kind, file_name, mime_type, file_size, file_data)
           VALUES ($1, 'source', $2, $3, $4, $5)`,
          [saved.rows[0].id, `${existingProposalId ? 'proposal-update' : 'proposal-screenshot'}-${Date.now()}-${screenshotIndex}.${extension}`, mimeType, imageData.length, imageData]
        );
      }
      assessment.proposal_record = saved.rows[0];
      syncGoogleSheetSoon();
    } catch (databaseError) {
      console.error('Assessment succeeded but database save failed:', databaseError.message);
      assessment.database_warning = 'Assessment completed, but it was not saved to the proposal database.';
    }
  } else {
    assessment.database_warning = 'Assessment completed, but DATABASE_URL is not configured.';
  }

  return assessment;
}

function proposalSheetRow(row) {
  const a = row.assessment || {};
  return [row.id, row.created_at, row.updated_at, row.status, a.proposal_name, a.brand, a.opportunity_type, a.verdict, a.proposal_summary, a.requester_name, a.requester_context, a.timeline, a.budget, row.event_date, row.location, row.payment_status, row.commission_breakdown, a.social_links, a.reach_score, a.relevance_score, a.business_score, a.credibility_score, a.time_cost_score, a.ask, a.next_step, a.decision_reason, row.notes].map(value => value ?? '');
}

async function syncGoogleSheet() {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL?.trim();
  const webhookSecret = process.env.GOOGLE_SHEETS_WEBHOOK_SECRET?.trim();
  if (!webhookUrl || !webhookSecret || !pool) return { configured: false };
  const result = await pool.query('SELECT * FROM scout_proposals ORDER BY id');
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: webhookSecret, sheet: 'Proposals', headers: sheetHeaders, rows: result.rows.map(proposalSheetRow), synced_at: new Date().toISOString() })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Sheet backup failed (${response.status}).`);
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { ok: true }; }
  if (payload?.ok === false) throw new Error(payload.error || 'Google Sheet backup was rejected.');
  return { configured: true, rows: result.rowCount, ...payload };
}

function syncGoogleSheetSoon() {
  setTimeout(() => syncGoogleSheet().catch(error => console.error('Google Sheet backup failed:', error.message)), 0);
}

async function initializeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scout_proposals (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'Pending Details',
      notes TEXT NOT NULL DEFAULT '',
      source_text TEXT NOT NULL DEFAULT '',
      assessment JSONB NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS scout_proposals_created_at_idx ON scout_proposals (created_at DESC)');
  await pool.query(`ALTER TABLE scout_proposals
    ADD COLUMN IF NOT EXISTS event_date TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'Pending',
    ADD COLUMN IF NOT EXISTS commission_breakdown TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE scout_proposals ALTER COLUMN status SET DEFAULT 'Pending Details'`);
  await pool.query(`UPDATE scout_proposals SET status = CASE
    WHEN status IN ('New', 'Reviewing', 'Needs Info') THEN 'Pending Details'
    WHEN status IN ('Approved', 'Sent to Nuseir') THEN 'Agreed; Pending Contract'
    WHEN status = 'Completed' THEN 'Delivered'
    ELSE status END`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scout_proposal_files (
      id BIGSERIAL PRIMARY KEY,
      proposal_id BIGINT NOT NULL REFERENCES scout_proposals(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

const databaseReady = initializeDatabase().catch(error => {
  console.error('Scout database initialization failed:', error.message);
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

app.use((error, _req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Screenshots are too large. Try fewer screenshots or crop them smaller.' });
  }

  if (error instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid request JSON.' });
  }

  next(error);
});

app.get('/api/version', (_req, res) => {
  res.json({
    version: 'scout-deal-tracker-1',
    updated: '2026-06-23',
    database: Boolean(pool)
  });
});

app.get('/api/proposals', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Proposal database is not connected. Add DATABASE_URL in Render.' });
  try {
    await databaseReady;
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const values = [];
    const conditions = [];
    if (status && status !== 'All') {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(assessment::text ILIKE $${values.length} OR notes ILIKE $${values.length} OR source_text ILIKE $${values.length})`);
    }
    const result = await pool.query(
      `SELECT p.id, p.created_at, p.updated_at, p.status, p.notes, p.event_date, p.location, p.source_text,
        p.payment_status, p.commission_breakdown, p.assessment,
        COALESCE((SELECT json_agg(json_build_object('id', f.id, 'kind', f.kind, 'file_name', f.file_name, 'mime_type', f.mime_type, 'file_size', f.file_size)) FROM scout_proposal_files f WHERE f.proposal_id = p.id), '[]'::json) AS attachments
       FROM scout_proposals p ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY p.created_at DESC LIMIT 500`,
      values
    );
    res.json({ proposals: result.rows, statuses: proposalStatuses });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not load proposals.' });
  }
});

app.patch('/api/proposals/:id', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Proposal database is not connected.' });
  try {
    const id = Number(req.params.id);
    const status = String(req.body?.status || '').trim();
    const notes = String(req.body?.notes ?? '');
    const type = String(req.body?.type || 'Other').trim();
    const budget = String(req.body?.budget || '').trim();
    const eventDate = String(req.body?.eventDate || '').trim();
    const location = String(req.body?.location || '').trim();
    const paymentStatus = String(req.body?.paymentStatus || 'Pending').trim();
    const commissionBreakdown = String(req.body?.commissionBreakdown || '');
    const sourceText = String(req.body?.sourceText || '');
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid proposal ID.' });
    if (!proposalStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    if (!opportunityTypes.includes(type)) return res.status(400).json({ error: 'Invalid opportunity type.' });
    if (!paymentStatuses.includes(paymentStatus)) return res.status(400).json({ error: 'Invalid payment status.' });
    const result = await pool.query(
      `UPDATE scout_proposals SET status = $1, notes = $2, event_date = $3, location = $4,
       payment_status = $5, commission_breakdown = $6,
       source_text = $7, assessment = assessment || jsonb_build_object('opportunity_type', $8::text, 'budget', $9::text), updated_at = NOW()
       WHERE id = $10 RETURNING id, created_at, updated_at, status, notes, event_date, location, payment_status, commission_breakdown, source_text, assessment`,
      [status, notes.slice(0, 10000), eventDate.slice(0, 250), location.slice(0, 250), paymentStatus, commissionBreakdown.slice(0, 10000), sourceText.slice(0, 50000), type, budget.slice(0, 500), id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Proposal not found.' });
    syncGoogleSheetSoon();
    res.json({ proposal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not update proposal.' });
  }
});

app.delete('/api/proposals/:id', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Proposal database is not connected.' });
  try {
    const id = Number(req.params.id);
    await deleteProposalById({
      pool,
      id,
      afterDelete: syncGoogleSheetSoon
    });
    res.json({ deleted: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not delete proposal.' });
  }
});

app.post('/api/proposals/:id/files', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Proposal database is not connected.' });
  try {
    const proposalId = Number(req.params.id);
    const kind = String(req.body?.kind || '').toLowerCase();
    const fileName = String(req.body?.fileName || '').trim();
    const mimeType = String(req.body?.mimeType || 'application/octet-stream').trim();
    const base64 = String(req.body?.data || '');
    if (!Number.isSafeInteger(proposalId) || proposalId < 1) return res.status(400).json({ error: 'Invalid proposal ID.' });
    if (!['contract', 'invoice', 'source'].includes(kind)) return res.status(400).json({ error: 'Invalid attachment type.' });
    if (!fileName || !base64) return res.status(400).json({ error: 'Missing attachment.' });
    const data = Buffer.from(base64, 'base64');
    if (!data.length || data.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Attachments must be 10 MB or smaller.' });
    const result = await pool.query(
      `INSERT INTO scout_proposal_files (proposal_id, kind, file_name, mime_type, file_size, file_data)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, kind, file_name, mime_type, file_size`,
      [proposalId, kind, fileName.slice(0, 300), mimeType.slice(0, 150), data.length, data]
    );
    res.json({ attachment: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not upload attachment.' });
  }
});

app.get('/api/proposals/files/:fileId', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Proposal database is not connected.' });
  const result = await pool.query('SELECT file_name, mime_type, file_data FROM scout_proposal_files WHERE id = $1', [Number(req.params.fileId)]);
  if (!result.rowCount) return res.status(404).json({ error: 'Attachment not found.' });
  const file = result.rows[0];
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.file_name)}`);
  res.send(file.file_data);
});

app.delete('/api/proposals/files/:fileId', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Proposal database is not connected.' });
  await pool.query('DELETE FROM scout_proposal_files WHERE id = $1', [Number(req.params.fileId)]);
  res.json({ deleted: true });
});

app.post('/api/proposals/import', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Proposal database is not connected.' });
  try {
    const proposals = Array.isArray(req.body?.proposals) ? req.body.proposals : [];
    if (!proposals.length || proposals.length > 200) {
      return res.status(400).json({ error: 'Import must contain between 1 and 200 proposals.' });
    }
    let imported = 0;
    let skipped = 0;
    for (const item of proposals) {
      const assessment = item?.assessment || item;
      const proposalName = String(assessment?.proposal_name || '').trim();
      if (!proposalName) {
        skipped += 1;
        continue;
      }
      const duplicate = await pool.query(
        `SELECT 1 FROM scout_proposals WHERE LOWER(assessment->>'proposal_name') = LOWER($1) LIMIT 1`,
        [proposalName]
      );
      if (duplicate.rowCount) {
        skipped += 1;
        continue;
      }
      const legacyStatusMap = { New: 'Pending Details', Reviewing: 'Pending Details', 'Needs Info': 'Pending Details', Approved: 'Agreed; Pending Contract', 'Sent to Nuseir': 'Agreed; Pending Contract', Completed: 'Delivered' };
      const requestedStatus = legacyStatusMap[item?.status] || item?.status;
      const status = proposalStatuses.includes(requestedStatus) ? requestedStatus : 'Pending Details';
      const notes = String(item?.notes || '').slice(0, 10000);
      await pool.query(
        'INSERT INTO scout_proposals (assessment, source_text, status, notes) VALUES ($1::jsonb, $2, $3, $4)',
        [JSON.stringify(assessment), String(item?.source_text || 'Imported historical Scout assessment').slice(0, 50000), status, notes]
      );
      imported += 1;
    }
    if (imported) syncGoogleSheetSoon();
    res.json({ imported, skipped });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not import proposals.' });
  }
});

app.get('/api/proposals.csv', requireAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ error: 'Proposal database is not connected.' });
  try {
    const result = await pool.query(`SELECT p.*, COALESCE((SELECT string_agg(f.file_name, '; ') FROM scout_proposal_files f WHERE f.proposal_id = p.id AND f.kind = 'contract'), '') AS contracts, COALESCE((SELECT string_agg(f.file_name, '; ') FROM scout_proposal_files f WHERE f.proposal_id = p.id AND f.kind = 'invoice'), '') AS invoices FROM scout_proposals p ORDER BY created_at DESC`);
    const headers = ['ID', 'Created', 'Updated', 'Status', 'Proposal', 'Brand', 'Type', 'Recommendation', 'Summary', 'Requester', 'Requester Context', 'Timeline', 'Budget', 'Date', 'Location', 'Payment Status', 'Contract/Agreement', 'Invoice', 'Patty Commission Breakdown', 'Website/Social Links', 'Reach', 'Relevance', 'Potential Business', 'Requester Credibility', 'Time Cost', 'Ask', 'Next Step', 'Reason', 'Notes'];
    const rows = result.rows.map(row => {
      const a = row.assessment || {};
      return [row.id, row.created_at?.toISOString?.() || row.created_at, row.updated_at?.toISOString?.() || row.updated_at, row.status, a.proposal_name, a.brand, a.opportunity_type, a.verdict, a.proposal_summary, a.requester_name, a.requester_context, a.timeline, a.budget, row.event_date, row.location, row.payment_status, row.contracts, row.invoices, row.commission_breakdown, a.social_links, a.reach_score, a.relevance_score, a.business_score, a.credibility_score, a.time_cost_score, a.ask, a.next_step, a.decision_reason, row.notes];
    });
    const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="scout-proposals-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not export proposals.' });
  }
});

app.get('/api/proposals.backup.json', requireAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ error: 'Proposal database is not connected.' });
  try {
    await databaseReady;
    const proposals = await pool.query('SELECT * FROM scout_proposals ORDER BY id');
    const files = await pool.query(`
      SELECT id, proposal_id, kind, file_name, mime_type, file_size, created_at,
        encode(file_data, 'base64') AS file_data_base64
      FROM scout_proposal_files ORDER BY id
    `);
    const backup = {
      format: 'scout-proposals-backup',
      version: 1,
      exported_at: new Date().toISOString(),
      proposal_count: proposals.rowCount,
      attachment_count: files.rowCount,
      proposals: proposals.rows,
      attachments: files.rows
    };
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="scout-full-backup-${date}.json"`);
    res.send(JSON.stringify(backup));
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not create full backup.' });
  }
});

app.post('/api/proposals/sync-google-sheet', requireAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ error: 'Proposal database is not connected.' });
  try {
    await databaseReady;
    const result = await syncGoogleSheet();
    if (!result.configured) return res.status(503).json({ error: 'Google Sheet backup is not configured in Render yet.' });
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error.message || 'Could not sync the Google Sheet backup.' });
  }
});

app.get('/api/lark/oauth/start', (req, res) => {
  const appId = process.env.COLLAB_ASSESSOR_LARK_APP_ID?.trim();
  if (!appId) {
    return res.status(500).send('Missing COLLAB_ASSESSOR_LARK_APP_ID in Render.');
  }

  const redirectUri = getLarkRedirectUri(req);
  const state = crypto.randomBytes(16).toString('hex');
  const authBase = process.env.LARK_OAUTH_AUTHORIZE_URL || 'https://accounts.larksuite.com/open-apis/authen/v1/index';
  const authUrl = new URL(authBase);
  authUrl.searchParams.set('app_id', appId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

  res.cookie('lark_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: 10 * 60 * 1000
  });
  return res.redirect(authUrl.toString());
});

app.get('/api/lark/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const cookies = parseCookies(req.headers.cookie);

    if (!code || !state || cookies.lark_oauth_state !== state) {
      return res.status(400).send('Lark login failed. Please try connecting again.');
    }

    const appToken = await getLarkAppAccessToken();
    const tokenResult = await exchangeLarkCodeForUserToken(appToken, String(code));
    const userAccessToken = tokenResult.access_token || tokenResult.user_access_token;

    if (!userAccessToken) {
      return res.status(500).send(`Lark did not return a user token: ${escapeText(JSON.stringify(tokenResult))}`);
    }

    const sessionId = crypto.randomBytes(24).toString('hex');
    larkUserSessions.set(sessionId, {
      accessToken: userAccessToken,
      expiresAt: Date.now() + ((tokenResult.expires_in || 7200) * 1000)
    });

    res.cookie('collab_lark_session', sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: (tokenResult.expires_in || 7200) * 1000
    });
    res.clearCookie('lark_oauth_state');
    return res.redirect('/?lark_connected=1');
  } catch (error) {
    return res.status(500).send(`Lark login failed: ${escapeText(error.message || 'Unknown error')}`);
  }
});

app.post('/api/assess', async (req, res) => {
  try {
    const { system, content, updateProposalId } = req.body || {};
    const existingProposalId = Number(updateProposalId || 0);
    if (existingProposalId && !isAuthorizedAdmin(req)) {
      return res.status(403).json({ error: 'Not authorized. Updating existing proposals is restricted to Patty.' });
    }
    const assessment = await runScoutAssessment({ system, content, updateProposalId: existingProposalId });
    return res.status(200).json(assessment);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || 'Assessment failed.' });
  }
});

app.post('/api/inbound-email', async (req, res) => {
  try {
    const inboundSecret = process.env.SCOUT_INBOUND_EMAIL_SECRET?.trim();
    const providedSecret = String(req.get('X-Scout-Inbound-Secret') || req.body?.secret || '').trim();
    if (!inboundSecret) {
      return res.status(500).json({ error: 'SCOUT_INBOUND_EMAIL_SECRET is not configured in Render.' });
    }
    if (!providedSecret || providedSecret !== inboundSecret) {
      return res.status(403).json({ error: 'Invalid inbound email secret.' });
    }

    const email = req.body || {};
    const from = String(email.from || 'Not stated').trim();
    const to = String(email.to || 'Not stated').trim();
    const subject = String(email.subject || 'Untitled proposal').trim();
    const text = String(email.text || email.body || '').trim();
    const html = String(email.html || '').trim();
    const messageId = String(email.messageId || email.message_id || '').trim();
    const attachments = Array.isArray(email.attachments) ? email.attachments : [];
    const allowDuplicate = String(req.body?.allow_duplicate || req.body?.allowDuplicate || '').trim() === '1';

    const attachmentSummary = attachments.length
      ? attachments.map((file, index) => `${index + 1}. ${String(file.fileName || file.name || 'attachment').trim()} (${String(file.mimeType || file.mime_type || 'unknown').trim()})`).join('\n')
      : 'No attachments provided.';

    const sourceText = [
      'Forwarded Scout email',
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      messageId ? `Message ID: ${messageId}` : '',
      text ? `Body:\n${text}` : '',
      html ? `HTML:\n${html.slice(0, 12000)}` : '',
      `Attachments:\n${attachmentSummary}`
    ].filter(Boolean).join('\n\n').slice(0, 50000);

    const duplicateCandidate = pool ? await findPotentialDuplicateProposal({
      from,
      to,
      subject,
      text,
      html,
      messageId,
      sourceText,
      attachments
    }) : null;

    if (duplicateCandidate && !allowDuplicate) {
      return res.status(409).json({
        ok: false,
        duplicate: duplicateCandidate,
        error: 'This looks like the same proposal as an existing Scout record. Review the match, then retry with allow_duplicate=1 if you want to proceed.'
      });
    }

    const content = [];
    for (const file of attachments) {
      const data = String(file.data || file.base64 || '').trim();
      const mimeType = String(file.mimeType || file.mime_type || '').trim();
      if (data && mimeType.startsWith('image/')) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType,
            data
          }
        });
      }
    }
    content.push({
      type: 'text',
      text: `Scout this opportunity for Nuseir. Classify it first, then evaluate Reach, Relevance, Potential Business, Requester Credibility, Time Cost, and the type-specific opportunity score.\n\nAdditional text:\n${sourceText}`
    });

    const system = `You are Scout, Patty's opportunity scout for Nuseir Yassin. Assess a forwarded proposal email or WhatsApp message. Return a complete JSON assessment using professional executive English. Rewrite awkward wording, extract requester details, timeline, budget, location, website/social links, and the request itself. Be conservative with Nuseir's time and preserve verified facts unless contradicted.`;
    const assessment = await runScoutAssessment({ system, content });
    const larkDraft = buildScoutAssessmentCard({
      ...assessment,
      source_files: []
    }, sourceText);

    const sendResult = await maybeSendInboundAssessmentToLark({
      assessment,
      sourceText
    });

    return res.status(200).json({
      ok: true,
      assessment,
      lark_draft: larkDraft,
      lark_send: sendResult,
      duplicate: duplicateCandidate,
      email: { from, to, subject, messageId },
      attachment_count: attachments.length
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || 'Could not process inbound email.' });
  }
});

app.post('/api/lark/todo', async (req, res) => {
  if (!isAuthorizedAdmin(req)) {
    return res.status(403).json({ error: 'Not authorized. This action is restricted to Patty.' });
  }

  const appId = process.env.COLLAB_ASSESSOR_LARK_APP_ID?.trim();
  const appSecret = process.env.COLLAB_ASSESSOR_LARK_APP_SECRET?.trim();
  const taskListGuid = process.env.COLLAB_ASSESSOR_LARK_TASKLIST_GUID?.trim() || 'b7545c13-3909-49d6-8cb5-6acf92db994f';

  if (!appId || !appSecret) {
    return res.status(500).json({
      error: 'Lark is not connected yet. Add COLLAB_ASSESSOR_LARK_APP_ID and COLLAB_ASSESSOR_LARK_APP_SECRET in Render environment variables, then redeploy.'
    });
  }

  try {
    const { title, details, taskListUrl } = req.body || {};
    if (!title || !details) {
      return res.status(400).json({ error: 'Missing task title or details.' });
    }

    const userSession = getLarkUserSession(req);
    if (userSession?.accessToken) {
      const userCreateResult = await createTaskInLarkList(userSession.accessToken, {
        title,
        description: `${details}\n\nTask list: ${taskListUrl || `https://applink.larksuite.com/client/todo/task_list?guid=${taskListGuid}`}`,
        taskListGuid
      });

      if (userCreateResult.ok) {
        return res.status(200).json({ ok: true, task: userCreateResult.task, auth: 'user' });
      }

      return res.status(500).json({
        error: userCreateResult.error || 'Lark task creation failed with your login.',
        create_attempts: userCreateResult.attempts
      });
    }

    if (req.query.auth === 'user') {
      return res.status(401).json({
        error: 'Please connect Lark first.',
        needs_lark_login: true,
        auth_url: '/api/lark/oauth/start'
      });
    }

    const tokenResponse = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret
      })
    });
    const tokenData = await tokenResponse.json();
    const token = tokenData.tenant_access_token;

    if (!tokenResponse.ok || !token) {
      return res.status(500).json({
        error: tokenData.msg || tokenData.error || 'Could not get Lark tenant access token.'
      });
    }

    const description = `${details}\n\nTask list: ${taskListUrl || `https://applink.larksuite.com/client/todo/task_list?guid=${taskListGuid}`}`;
    const createResult = await createTaskInLarkList(token, {
      title,
      description,
      taskListGuid
    });

    if (!createResult.ok) {
      return res.status(500).json({
        error: createResult.error || 'Lark task creation failed.',
        create_attempts: createResult.attempts
      });
    }

    const task = createResult.task;
    const taskGuid = task.guid;
    const attachedToList = Array.isArray(task.tasklists) && task.tasklists.some(tasklist => (
      tasklist.guid === taskListGuid || tasklist.tasklist_guid === taskListGuid
    ));

    if (!taskGuid) {
      return res.status(500).json({ error: 'Lark created the task, but did not return a task GUID.' });
    }

    if (!attachedToList) {
      const attachResults = await tryAttachTaskToList(token, taskListGuid, taskGuid);
      const attached = attachResults.some(result => result.ok);

      if (!attached) {
        return res.status(500).json({
          error: 'Task was created, but Lark did not attach it to the requested task list.',
          task_url: task.url,
          attach_results: attachResults
        });
      }
    }

    return res.status(200).json({ ok: true, task });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not add to Lark To-Do.' });
  }
});

app.post('/api/lark/message', async (req, res) => {
  if (!isAuthorizedAdmin(req)) {
    return res.status(403).json({ error: 'Not authorized. This action is restricted to Patty.' });
  }

  const target = getLarkMessageTarget();
  const { receiveId, receiveIdType, mode } = target;

  if (mode !== 'test' && mode !== 'live') {
    return res.status(403).json({
      error: 'Lark sending is disabled. Set COLLAB_ASSESSOR_LARK_MESSAGE_MODE=test to send to the test chat, or live only when you are ready for the live target.'
    });
  }

  if (!receiveId) {
    return res.status(500).json({
      error: mode === 'test'
        ? 'Test Lark recipient is not set. Add COLLAB_ASSESSOR_LARK_TEST_RECEIVE_ID plus COLLAB_ASSESSOR_LARK_TEST_RECEIVE_ID_TYPE in Render.'
        : 'Live Lark recipient is not set. Add COLLAB_ASSESSOR_LARK_NUSEIR_EMAIL in Render, or add COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID plus COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID_TYPE.'
    });
  }

  if (!isAllowedLarkMessageTarget(receiveId, receiveIdType)) {
    return res.status(403).json({
      error: `Lark sending is locked to the test allowlist. Add the ${target.label} receive ID to COLLAB_ASSESSOR_LARK_ALLOWED_RECEIVE_IDS in Render, and leave the live group out of that list.`
    });
  }

  try {
    const { message, assessment } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Missing message draft.' });
    }
    const result = await sendLarkMessageToTarget({
      receiveId,
      receiveIdType,
      card: assessment
        ? buildScoutAssessmentCard(assessment, String(message).trim())
        : buildLarkCardContent(String(message).trim())
    });

    return res.status(200).json({ ok: true, message_id: result.message_id, data: result.data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not send Lark message.' });
  }
});

function isAuthorizedAdmin(req) {
  const adminKey = process.env.SCOUT_ADMIN_KEY?.trim();
  if (!adminKey) return false;

  const providedKey = req.headers['x-scout-admin-key'];
  return typeof providedKey === 'string' && timingSafeEqual(providedKey.trim(), adminKey);
}

function requireAdmin(req, res, next) {
  if (!isAuthorizedAdmin(req)) {
    return res.status(403).json({ error: 'Not authorized. The proposal database is restricted to Patty.' });
  }
  next();
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function timingSafeEqual(a, b) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

async function sendLarkMessageToTarget({ receiveId, receiveIdType, card }) {
  const token = await getLarkTenantAccessToken();
  const response = await fetch(`https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code) {
    const error = new Error(data.msg || data.error?.message || 'Could not send Lark message.');
    error.statusCode = response.ok ? 500 : response.status;
    error.details = data;
    throw error;
  }
  return { message_id: data.data?.message_id, data };
}

function normalizeDuplicateText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "'")
    .replace(/[\u201c\u201d"]/g, '"')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSourceFingerprint(sourceText) {
  const text = String(sourceText || '');
  const messageId = (text.match(/Message ID:\s*([^\n]+)/i)?.[1] || '').trim();
  const subject = (text.match(/Subject:\s*([^\n]+)/i)?.[1] || '').trim();
  const from = (text.match(/From:\s*([^\n]+)/i)?.[1] || '').trim();
  return {
    messageId: normalizeDuplicateText(messageId),
    subject: normalizeDuplicateText(subject),
    from: normalizeDuplicateText(from),
    body: normalizeDuplicateText(text.replace(/^[\s\S]*?Body:\s*/i, ''))
  };
}

function sharedTokenCount(a, b) {
  const left = new Set(normalizeDuplicateText(a).split(' ').filter(Boolean));
  const right = new Set(normalizeDuplicateText(b).split(' ').filter(Boolean));
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

async function findPotentialDuplicateProposal({ from, subject, text, html, messageId, sourceText, attachments }) {
  if (!pool) return null;
  await databaseReady;

  const rows = await pool.query(
    `SELECT p.id, p.created_at, p.status, p.source_text, p.assessment,
      COALESCE((SELECT string_agg(f.file_name, '; ') FROM scout_proposal_files f WHERE f.proposal_id = p.id AND f.kind = 'source'), '') AS source_files
     FROM scout_proposals p
     ORDER BY p.created_at DESC
     LIMIT 200`
  );

  const incoming = {
    messageId: normalizeDuplicateText(messageId),
    subject: normalizeDuplicateText(subject),
    from: normalizeDuplicateText(from),
    body: normalizeDuplicateText([text, html ? html.slice(0, 5000) : ''].filter(Boolean).join('\n'))
  };
  const incomingFingerprint = extractSourceFingerprint(sourceText);
  const incomingAttachments = Array.isArray(attachments) ? attachments : [];
  const hasImageAttachment = incomingAttachments.some(file => String(file?.mimeType || file?.mime_type || '').startsWith('image/'));

  let best = null;
  for (const row of rows.rows) {
    const a = row.assessment || {};
    const storedSource = String(row.source_text || '');
    const storedFingerprint = extractSourceFingerprint(storedSource);
    const scoreParts = [];
    let score = 0;

    if (incoming.messageId && storedFingerprint.messageId && incoming.messageId === storedFingerprint.messageId) {
      score += 100;
      scoreParts.push('same message ID');
    }

    if (incoming.subject && storedFingerprint.subject && incoming.subject === storedFingerprint.subject) {
      score += 25;
      scoreParts.push('same subject');
    }

    if (incoming.from && storedFingerprint.from && incoming.from === storedFingerprint.from) {
      score += 15;
      scoreParts.push('same sender');
    }

    const bodyOverlap = sharedTokenCount(incoming.body || incomingFingerprint.body, storedFingerprint.body || storedSource);
    if (bodyOverlap >= 12) {
      score += 35;
      scoreParts.push('strong body overlap');
    } else if (bodyOverlap >= 6) {
      score += 20;
      scoreParts.push('body overlap');
    }

    const titleOverlap = sharedTokenCount(subject, a.proposal_name || a.brand || '');
    if (titleOverlap >= 3) {
      score += 12;
      scoreParts.push('similar title');
    }

    if (hasImageAttachment && /screenshot/i.test(String(row.source_files || ''))) {
      score += 10;
      scoreParts.push('screenshots present');
    }

    if (score < 35) continue;
    if (!best || score > best.score) {
      const title = a.proposal_name || a.brand || `Proposal #${row.id}`;
      best = {
        id: row.id,
        title,
        status: row.status,
        reason: scoreParts.join(', '),
        score,
        link: proposalUrl(row.id)
      };
    }
  }

  return best;
}

async function maybeSendInboundAssessmentToLark({ assessment, sourceText }) {
  const mode = process.env.SCOUT_EMAIL_AUTOMATION_LARK_MODE?.trim().toLowerCase()
    || process.env.COLLAB_ASSESSOR_LARK_MESSAGE_MODE?.trim().toLowerCase()
    || 'draft_only';

  if (mode !== 'test' && mode !== 'live') {
    const result = { sent: false, mode, skipped: 'Lark mode is draft_only or unset.' };
    console.log('[inbound-email] lark send skipped', result);
    return result;
  }

  const target = getLarkMessageTarget();
  if (target.mode !== mode) {
    const result = { sent: false, mode, skipped: `Target mode mismatch: ${target.mode}` };
    console.log('[inbound-email] lark send skipped', result);
    return result;
  }

  if (!target.receiveId) {
    const result = {
      sent: false,
      mode,
      skipped: mode === 'test'
        ? 'Missing test receive ID.'
        : 'Missing live receive ID.'
    };
    console.log('[inbound-email] lark send skipped', result);
    return result;
  }

  if (!isAllowedLarkMessageTarget(target.receiveId, target.receiveIdType)) {
    const result = { sent: false, mode, skipped: 'Receive ID is not on the allowlist.' };
    console.log('[inbound-email] lark send skipped', result);
    return result;
  }

  const card = buildScoutAssessmentCard({ ...assessment, source_files: [] }, sourceText);
  const result = await sendLarkMessageToTarget({
    receiveId: target.receiveId,
    receiveIdType: target.receiveIdType,
    card
  });
  const sent = { sent: true, mode, receiveIdType: target.receiveIdType, receiveId: target.receiveId, message_id: result.message_id };
  console.log('[inbound-email] lark send success', sent);
  return sent;
}

function md(content) {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content
    }
  };
}

function buildLarkPostContent(message) {
  const lines = message.split(/\r?\n/);
  const title = lines.shift() || 'Scout Opportunity';
  const content = [];

  for (const line of lines) {
    if (!line) {
      content.push([{ tag: 'text', text: ' ' }]);
      continue;
    }

    content.push(linkifyLarkLine(line));
  }

  return {
    post: {
      en_us: {
        title,
        content
      }
    }
  };
}

function linkifyLarkLine(line) {
  const parts = [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  let lastIndex = 0;
  let match;

  while ((match = urlRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ tag: 'text', text: line.slice(lastIndex, match.index) });
    }
    parts.push({ tag: 'a', text: match[0], href: match[0] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    parts.push({ tag: 'text', text: line.slice(lastIndex) });
  }

  return parts.length ? parts : [{ tag: 'text', text: line }];
}

app.get('/api/lark/chats', async (_req, res) => {
  try {
    const token = await getLarkTenantAccessToken();
    const response = await fetch('https://open.larksuite.com/open-apis/im/v1/chats?page_size=100', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.code) {
      return res.status(response.ok ? 500 : response.status).json({
        error: data.msg || data.error?.message || 'Could not list Lark chats.',
        details: data
      });
    }

    const chats = (data.data?.items || []).map(chat => ({
      name: chat.name || chat.description || '(unnamed chat)',
      chat_id: chat.chat_id,
      avatar: chat.avatar,
      owner_id: chat.owner_id,
      chat_mode: chat.chat_mode
    }));

    return res.status(200).json({ ok: true, chats });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not list Lark chats.' });
  }
});

async function createTaskInLarkList(token, { title, description, taskListGuid }) {
  const createTaskUrl = process.env.LARK_TODO_CREATE_URL || 'https://open.larksuite.com/open-apis/task/v2/tasks';
  const payloads = [
    {
      name: 'tasklists-object-tasklist-array-tasklist-guid',
      body: {
        summary: title,
        description,
        tasklists: {
          tasklist: [{ tasklist_guid: taskListGuid }]
        }
      }
    },
    {
      name: 'tasklists-object-tasklist-array-guid',
      body: {
        summary: title,
        description,
        tasklists: {
          tasklist: [{ guid: taskListGuid }]
        }
      }
    },
    {
      name: 'tasklists-array-tasklist-guid',
      body: {
        summary: title,
        description,
        tasklists: [{ tasklist_guid: taskListGuid }]
      }
    },
    {
      name: 'tasklists-object-tasklist-guid',
      body: {
        summary: title,
        description,
        tasklists: { tasklist_guid: taskListGuid }
      }
    },
    {
      name: 'tasklists-array-tasklist-object',
      body: {
        summary: title,
        description,
        tasklists: [{ tasklist: { tasklist_guid: taskListGuid } }]
      }
    },
    {
      name: 'tasklists-object-tasklist-object',
      body: {
        summary: title,
        description,
        tasklists: { tasklist: { tasklist_guid: taskListGuid } }
      }
    },
    {
      name: 'root-tasklist-guid',
      body: {
        summary: title,
        description,
        tasklist_guid: taskListGuid,
        task_list_guid: taskListGuid
      }
    }
  ];

  const attempts = [];

  for (const payload of payloads) {
    const response = await fetch(createTaskUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload.body)
    });

    const data = await response.json().catch(() => ({}));
    const task = data.data?.task || data.task || data.data || data;
    const attachedToList = Array.isArray(task.tasklists) && task.tasklists.some(tasklist => (
      tasklist.guid === taskListGuid || tasklist.tasklist_guid === taskListGuid
    ));

    attempts.push({
      name: payload.name,
      status: response.status,
      code: data.code,
      msg: data.msg || data.error?.message,
      task_guid: task.guid,
      attached_to_list: attachedToList
    });

    if (response.ok && !data.code && attachedToList) {
      return { ok: true, task, attempts };
    }

  }

  return {
    ok: false,
    error: attempts.at(-1)?.msg || 'Lark did not accept any task list payload shape.',
    attempts
  };
}

async function getLarkAppAccessToken() {
  const appId = process.env.COLLAB_ASSESSOR_LARK_APP_ID?.trim();
  const appSecret = process.env.COLLAB_ASSESSOR_LARK_APP_SECRET?.trim();
  const response = await fetch('https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code) {
    throw new Error(data.msg || data.error || 'Could not get Lark app access token.');
  }

  return data.app_access_token;
}

async function getLarkTenantAccessToken() {
  const appId = process.env.COLLAB_ASSESSOR_LARK_APP_ID?.trim();
  const appSecret = process.env.COLLAB_ASSESSOR_LARK_APP_SECRET?.trim();

  if (!appId || !appSecret) {
    throw new Error('Missing COLLAB_ASSESSOR_LARK_APP_ID or COLLAB_ASSESSOR_LARK_APP_SECRET in Render.');
  }

  const response = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code || !data.tenant_access_token) {
    throw new Error(data.msg || data.error || 'Could not get Lark tenant access token.');
  }

  return data.tenant_access_token;
}

async function exchangeLarkCodeForUserToken(appAccessToken, code) {
  const tokenUrl = process.env.LARK_USER_TOKEN_URL || 'https://open.larksuite.com/open-apis/authen/v1/access_token';
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${appAccessToken}`
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code
    })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code) {
    throw new Error(data.msg || data.error || 'Could not exchange Lark login code for a user token.');
  }

  return data.data || data;
}

function getLarkUserSession(req) {
  const sessionId = parseCookies(req.headers.cookie).collab_lark_session;
  if (!sessionId) return null;

  const session = larkUserSessions.get(sessionId);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    larkUserSessions.delete(sessionId);
    return null;
  }

  return session;
}

function getLarkRedirectUri(req) {
  if (process.env.LARK_OAUTH_REDIRECT_URI) return process.env.LARK_OAUTH_REDIRECT_URI;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${protocol}://${host}/api/lark/oauth/callback`;
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const index = cookie.indexOf('=');
    if (index === -1) return cookies;
    const key = cookie.slice(0, index).trim();
    const value = cookie.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function escapeText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function tryAttachTaskToList(token, taskListGuid, taskGuid) {
  const attempts = [
    {
      method: 'POST',
      url: `https://open.larksuite.com/open-apis/task/v2/tasklists/${taskListGuid}/tasks`,
      body: { task_guid: taskGuid }
    },
    {
      method: 'POST',
      url: `https://open.larksuite.com/open-apis/task/v2/tasklists/${taskListGuid}/tasks/${taskGuid}`,
      body: {}
    },
    {
      method: 'PUT',
      url: `https://open.larksuite.com/open-apis/task/v2/tasklists/${taskListGuid}/tasks/${taskGuid}`,
      body: {}
    },
    {
      method: 'POST',
      url: `https://open.larksuite.com/open-apis/task/v2/tasks/${taskGuid}/tasklists`,
      body: { tasklist_guid: taskListGuid }
    }
  ];

  const results = [];

  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, {
        method: attempt.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(attempt.body)
      });
      const data = await response.json().catch(() => ({}));
      results.push({
        ok: response.ok && !data.code,
        method: attempt.method,
        url: attempt.url,
        status: response.status,
        code: data.code,
        msg: data.msg || data.error?.message
      });

      if (response.ok && !data.code) break;
    } catch (error) {
      results.push({
        ok: false,
        method: attempt.method,
        url: attempt.url,
        msg: error.message
      });
    }
  }

  return results;
}

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Scout running on port ${port}`);
});
