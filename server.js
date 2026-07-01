import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { deleteProposalById } from './proposal-delete.js';
import { buildNuseirSummary, pendingNuseirStatus } from './nuseir-summary.js';

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const larkUserSessions = new Map();
const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false } }) : null;

const proposalStatuses = ['Pending Details', pendingNuseirStatus, 'Agreed; Pending Contract', 'Rejected', 'Contract Signed', 'Delivered'];
const opportunityTypes = ['Collaboration / Content Opportunity', 'Speaking Engagement', 'Partnership Proposal', 'Non-Profit / Cause Initiative', 'Media Opportunity', 'Other'];
const paymentStatuses = ['Pending', 'Paid', 'Pro-Bono'];
const sheetHeaders = ['ID', 'Created', 'Updated', 'Status', 'Proposal', 'Brand', 'Type', 'Recommendation', 'Summary', 'Requester', 'Requester Context', 'Timeline', 'Budget', 'Engagement Date', 'Location', 'Payment Status', 'Patty Commission Breakdown', 'Website/Social Links', 'Reach', 'Relevance', 'Potential Business', 'Requester Credibility', 'Time Cost', 'Ask', 'Next Step', 'Reason', 'Notes', 'Source Files', 'Contracts', 'Invoices', 'Attachment Count'];
const attachmentSheetHeaders = ['Attachment ID', 'Proposal ID', 'Kind', 'File Name', 'MIME Type', 'File Size', 'Created', 'Data Key'];
const attachmentDataSheetHeaders = ['Data Key', 'Attachment ID', 'Chunk Index', 'Chunk Count', 'Base64 Chunk'];
const attachmentBackupChunkSize = 45000;
const scoutAssessmentSystemPrompt = `You are Scout, Patty's opportunity scout for Nuseir Yassin (Nas Daily / Nas.com). Your personality: sharp-eyed, commercially aware, story-hungry, mission-driven, and allergic to wasted executive time. You spot hidden upside, but you do not hype weak opportunities.

Keep the output extremely simple, executive-friendly, and easy for Nuseir to digest in under 20 seconds.

First classify the opportunity as exactly one of:
- Collaboration / Content Opportunity
- Speaking Engagement
- Partnership Proposal
- Non-Profit / Cause Initiative
- Media Opportunity
- Other

Then evaluate using universal criteria:
1. Reach: audience, distribution, credibility, media value, or amplification.
2. Relevance: fit with Nas Daily content, education, storytelling, entrepreneurship, global optimism, creator economy, useful products, or world-scale ideas.
3. Potential business: revenue, strategic access, sponsors, repeatability, partnership, or material upside.
4. Time Cost: whether this justifies Nuseir's personal attention. Attention is often scarcer than money.
5. Requester credibility: whether the person who reached out appears real, relevant, senior enough, and connected to the stated organization.

Requester credibility rules:
- Identify the person who reached out when possible.
- Use web search when possible to find LinkedIn/profile/context for that person and confirm they are connected to the organization.
- If you cannot verify the requester, say so plainly and reduce confidence.
- Never invent a LinkedIn profile or credential. Use "Not verified" when evidence is missing.

Classification-specific calibration:

For Collaboration / Content Opportunity:
- Do not judge only by business value.
- Ask: Is there a compelling Nas Daily story here?
- Consider human story, educational value, surprising insights, global relevance, viral potential, and access to unique people/places/experiences.
- Distinguish "could be interesting" from "there is a guaranteed Nas Daily story." If access, characters, filming angle, or global hook are unclear, do not over-score story potential.
- For pro-bono opportunities, ask: Would Nas Daily want to create content about this even with no commercial benefit?
- If yes, increase recommendation strength. If no direct business benefit and no guaranteed story, the recommendation should usually be NO.
- Set type_score_label to "Story Potential".

For Speaking Engagement:
- Assume Nuseir's standard speaking fee is $50,000 USD.
- Evaluate fee offered, audience quality, event prestige, strategic access, future business, sponsorship potential, and content opportunities.
- If fee is below $50,000, do not automatically reject. Ask whether strategic value compensates for the fee gap.
- Strategic value can include founders, investors, government leaders, enterprise decision makers, potential sponsors, or significant media exposure.
- Set type_score_label to "Worth Nuseir's Time".

For Partnership Proposal:
- Evaluate strategic fit with the Nas Daily ecosystem, long-term potential, distribution value, revenue potential, repeatability, and ability to unlock future opportunities.
- Set type_score_label to "Partnership Potential".

For Non-Profit / Cause Initiative:
- Evaluate mission alignment rather than revenue.
- Ask: Does this advance the broader Nas Daily mission?
- Consider education, human progress, opportunity creation, entrepreneurship, global understanding, and positive impact.
- Also evaluate organization credibility, ability to execute, storytelling value, and audience relevance.
- Set type_score_label to "Mission Impact".

For Media Opportunity:
- Evaluate audience quality, credibility, reach, narrative control, reputational upside/downside, and whether it advances Nuseir's positioning.
- Set type_score_label to "Media Value".

For Other:
- Identify the real opportunity logic and set type_score_label to "Opportunity Value".

Final decision philosophy, in order:
1. Great stories
2. Strategic leverage
3. Mission alignment
4. Revenue and business opportunities
5. Efficient use of Nuseir's time

Confidence and intake hygiene:
- Add an overall confidence level based on how complete and verifiable the submission is.
- Use exactly one confidence level: High, Medium, or Low.
- High = direct, clear, specific, and verifiable.
- Medium = mostly clear, with a few important unknowns.
- Low = forwarded chain is messy, details are partial, attachments are missing context, or requester/opportunity facts cannot be confidently verified.
- If the submission is too messy, contradictory, or incomplete to assess properly, set review_flag to "Needs human cleanup" and explain the missing pieces plainly.
- If the submission is workable without human cleanup, set review_flag to "Ready".`;

const attachmentKindsForStorage = new Set(['source', 'contract', 'invoice']);
const forwardedBoundaryPatterns = [
  /-{2,}\s*Forwarded message\s*-{2,}/i,
  /Begin forwarded message:/i,
  /Original Message/i
];

function normalizeWhitespace(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

function normalizeTextFingerprint(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/\b(fwd?|re):\s*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9@.:/\- ]+/g, '')
    .trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function classifyInboundSource(email) {
  const combined = [email.subject, email.text].filter(Boolean).join('\n');
  return /(forwarded message|begin forwarded message|^fwd:|^fw:)/im.test(combined)
    ? 'Forwarded Email'
    : 'Direct Email';
}

function extractBestEmailBody(text) {
  const raw = normalizeWhitespace(text);
  if (!raw) return '';
  for (const pattern of forwardedBoundaryPatterns) {
    if (pattern.test(raw)) {
      const [, tail = ''] = raw.split(pattern);
      if (tail.trim()) return tail.trim();
    }
  }
  return raw;
}

function inferIntakeConfidence(email, bodyText) {
  const text = normalizeWhitespace(bodyText || email.text || '');
  const hasForwarded = classifyInboundSource(email) === 'Forwarded Email';
  const signalCount = [
    /@\S+\.\S+/.test(text),
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/i.test(text),
    /\b(usd|\$|fee|budget|honorarium|covered|travel|accommodation)\b/i.test(text),
    /\b(https?:\/\/|www\.)\S+/i.test(text),
    text.length > 900
  ].filter(Boolean).length;

  if (!text || text.length < 180) return 'Low';
  if (hasForwarded && signalCount <= 2) return 'Low';
  if (signalCount >= 4) return 'High';
  return 'Medium';
}

function buildSourceFingerprint(email, bodyText) {
  const basis = [
    normalizeTextFingerprint(email.from),
    normalizeTextFingerprint(email.subject),
    normalizeTextFingerprint(bodyText).slice(0, 6000)
  ].join('|');
  return sha256(basis);
}

function groupAttachmentsByProposal(files) {
  const grouped = new Map();
  for (const file of files) {
    const key = String(file.proposal_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(file);
  }
  return grouped;
}

function attachmentNames(files, kind) {
  return files.filter(file => file.kind === kind).map(file => file.file_name).join('; ');
}

function proposalSheetRow(row, filesByProposal = new Map()) {
  const a = row.assessment || {};
  const files = filesByProposal.get(String(row.id)) || [];
  return [row.id, row.created_at, row.updated_at, row.status, a.proposal_name, a.brand, a.opportunity_type, a.verdict, a.proposal_summary, a.requester_name, a.requester_context, a.timeline, a.budget, row.event_date, row.location, row.payment_status, row.commission_breakdown, a.social_links, a.reach_score, a.relevance_score, a.business_score, a.credibility_score, a.time_cost_score, a.ask, a.next_step, a.decision_reason, row.notes, attachmentNames(files, 'source'), attachmentNames(files, 'contract'), attachmentNames(files, 'invoice'), files.length].map(value => value ?? '');
}

function buildAttachmentBackupRows(files) {
  const attachmentRows = [];
  const attachmentDataRows = [];

  for (const file of files) {
    const dataKey = `attachment-${file.id}`;
    const base64 = String(file.file_data_base64 || '');
    const chunkCount = Math.max(1, Math.ceil(base64.length / attachmentBackupChunkSize));
    attachmentRows.push([
      file.id,
      file.proposal_id,
      file.kind,
      file.file_name,
      file.mime_type,
      file.file_size,
      file.created_at,
      dataKey
    ].map(value => value ?? ''));

    for (let index = 0; index < chunkCount; index += 1) {
      attachmentDataRows.push([
        dataKey,
        file.id,
        index + 1,
        chunkCount,
        base64.slice(index * attachmentBackupChunkSize, (index + 1) * attachmentBackupChunkSize)
      ]);
    }
  }

  return { attachmentRows, attachmentDataRows };
}

async function syncGoogleSheet() {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL?.trim();
  const webhookSecret = process.env.GOOGLE_SHEETS_WEBHOOK_SECRET?.trim();
  if (!webhookUrl || !webhookSecret || !pool) return { configured: false };
  const result = await pool.query('SELECT * FROM scout_proposals ORDER BY id');
  const files = await pool.query(`
    SELECT id, proposal_id, kind, file_name, mime_type, file_size, created_at,
      encode(file_data, 'base64') AS file_data_base64
    FROM scout_proposal_files ORDER BY proposal_id, id
  `);
  const filesByProposal = groupAttachmentsByProposal(files.rows);
  const { attachmentRows, attachmentDataRows } = buildAttachmentBackupRows(files.rows);
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: webhookSecret,
      synced_at: new Date().toISOString(),
      sheets: [
        { sheet: 'Proposals', headers: sheetHeaders, rows: result.rows.map(row => proposalSheetRow(row, filesByProposal)) },
        { sheet: 'Attachments', headers: attachmentSheetHeaders, rows: attachmentRows },
        { sheet: 'Attachment Data', headers: attachmentDataSheetHeaders, rows: attachmentDataRows }
      ]
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Sheet backup failed (${response.status}).`);
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { ok: true }; }
  if (payload?.ok === false) throw new Error(payload.error || 'Google Sheet backup was rejected.');
  return { configured: true, rows: result.rowCount, attachments: files.rowCount, attachment_chunks: attachmentDataRows.length, ...payload };
}

function syncGoogleSheetSoon() {
  setTimeout(() => syncGoogleSheet().catch(error => console.error('Google Sheet backup failed:', error.message)), 0);
}

function buildAssessmentSchema() {
  return {
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
      confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
      review_flag: { type: 'string', enum: ['Ready', 'Needs human cleanup'] },
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
      'confidence',
      'review_flag',
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
  };
}

function toOpenAIInputContent(content = []) {
  return content.map(item => {
    if (item.type === 'text') return { type: 'input_text', text: item.text };
    if (item.type === 'image' && item.source?.data) {
      return {
        type: 'input_image',
        image_url: `data:${item.source.media_type || 'image/png'};base64,${item.source.data}`
      };
    }
    return null;
  }).filter(Boolean);
}

async function runScoutAssessment({ system, content, existingProposalId = 0, previewOnly = false, proposalMeta = null }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Render environment variables.');

  const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1',
      instructions: system,
      input: [{ role: 'user', content: toOpenAIInputContent(content) }],
      max_output_tokens: 1600,
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      text: {
        format: {
          type: 'json_schema',
          name: 'opportunity_assessment',
          strict: true,
          schema: buildAssessmentSchema()
        }
      }
    })
  });

  const data = await openaiResponse.json();
  if (!openaiResponse.ok) {
    throw new Error(data.error?.message || 'OpenAI request failed.');
  }

  const outputText = data.output_text || (data.output || [])
    .flatMap(item => item.content || [])
    .filter(part => part.type === 'output_text')
    .map(part => part.text)
    .join('');
  if (!outputText) throw new Error('OpenAI returned no assessment text.');

  const assessment = JSON.parse(outputText);
  if (previewOnly) return assessment;

  if (!pool) {
    assessment.database_warning = 'Assessment completed, but DATABASE_URL is not configured.';
    return assessment;
  }

  try {
    await databaseReady;
    const rawSourceText = content.filter(item => item.type === 'text').map(item => item.text || '').join('\n\n');
    const additionalMarker = 'Additional text:\n';
    const sourceText = (rawSourceText.includes(additionalMarker) ? rawSourceText.split(additionalMarker).slice(1).join(additionalMarker) : rawSourceText).slice(0, 50000);
    let saved;
    if (existingProposalId) {
      const current = await pool.query('SELECT source_text, event_date, location, intake_source, intake_confidence, inbound_message_id, source_fingerprint FROM scout_proposals WHERE id = $1', [existingProposalId]);
      if (!current.rowCount) throw new Error('Proposal not found.');
      const prior = current.rows[0];
      const mergedSource = [prior.source_text, sourceText].filter(Boolean).join('\n\n--- Update ---\n\n').slice(0, 50000);
      const proposedDate = String(assessment.timeline || '').trim();
      const proposedLocation = String(assessment.location || '').trim();
      const eventDate = proposedDate && !/not stated|unknown|tbd/i.test(proposedDate) ? proposedDate : prior.event_date;
      const location = proposedLocation && !/not stated|unknown|tbd/i.test(proposedLocation) ? proposedLocation : prior.location;
      saved = await pool.query(
        `UPDATE scout_proposals SET assessment = $1::jsonb, source_text = $2, event_date = $3, location = $4,
         intake_source = COALESCE($5, intake_source), intake_confidence = COALESCE($6, intake_confidence),
         inbound_message_id = COALESCE($7, inbound_message_id), source_fingerprint = COALESCE($8, source_fingerprint),
         updated_at = NOW()
         WHERE id = $9 RETURNING id, created_at, status`,
        [JSON.stringify(assessment), mergedSource, eventDate || '', location || '', proposalMeta?.intakeSource || null, proposalMeta?.intakeConfidence || null, proposalMeta?.messageId || null, proposalMeta?.sourceFingerprint || null, existingProposalId]
      );
    } else {
      saved = await pool.query(
        `INSERT INTO scout_proposals
         (assessment, source_text, event_date, location, intake_source, intake_confidence, inbound_message_id, source_fingerprint)
         VALUES ($1::jsonb, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at, status`,
        [JSON.stringify(assessment), sourceText, String(assessment.timeline || ''), String(assessment.location || ''), proposalMeta?.intakeSource || 'Manual', proposalMeta?.intakeConfidence || assessment.confidence || 'Medium', proposalMeta?.messageId || '', proposalMeta?.sourceFingerprint || '']
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

    if (proposalMeta?.rawAttachments?.length) {
      let attachmentIndex = 0;
      for (const attachment of proposalMeta.rawAttachments.filter(item => !String(item.mimeType || '').startsWith('image/'))) {
        const mimeType = String(attachment.mimeType || 'application/octet-stream');
        const data = Buffer.from(String(attachment.data || ''), 'base64');
        if (!data.length || data.length > 10 * 1024 * 1024) continue;
        attachmentIndex += 1;
        const baseName = String(attachment.fileName || `email-attachment-${attachmentIndex}`).slice(0, 180);
        const duplicateFile = await pool.query(
          `SELECT id FROM scout_proposal_files
           WHERE proposal_id = $1 AND kind = 'source' AND file_name = $2 AND file_size = $3 LIMIT 1`,
          [saved.rows[0].id, baseName, data.length]
        );
        if (duplicateFile.rowCount) continue;
        await pool.query(
          `INSERT INTO scout_proposal_files (proposal_id, kind, file_name, mime_type, file_size, file_data)
           VALUES ($1, 'source', $2, $3, $4, $5)`,
          [saved.rows[0].id, baseName, mimeType, data.length, data]
        );
      }
    }

    assessment.proposal_record = saved.rows[0];
    syncGoogleSheetSoon();
  } catch (databaseError) {
    console.error('Assessment succeeded but database save failed:', databaseError.message);
    assessment.database_warning = 'Assessment completed, but it was not saved to the proposal database.';
  }

  return assessment;
}

function normalizeInboundEmail(payload) {
  const from = String(payload.from || payload.sender || '').trim();
  const subject = String(payload.subject || '').trim();
  const text = String(payload.text || payload.body || payload.plainText || '').trim();
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (!from) throw new Error('Inbound email is missing sender.');
  if (!subject && !text && !attachments.length) throw new Error('Inbound email is empty.');
  return {
    from,
    to: String(payload.to || '').trim(),
    cc: String(payload.cc || '').trim(),
    subject: subject || '(No subject)',
    text,
    messageId: String(payload.messageId || payload.message_id || '').trim(),
    sourceLabel: String(payload.sourceLabel || payload.source_label || '').trim(),
    attachments: attachments.map(item => ({
      fileName: String(item.fileName || item.filename || 'attachment').trim(),
      mimeType: String(item.mimeType || item.contentType || 'application/octet-stream').trim(),
      data: String(item.data || '').trim()
    })).filter(item => item.data)
  };
}

function buildInboundEmailContent(email) {
  const mainBody = extractBestEmailBody(email.text);
  const attachmentManifest = email.attachments.length
    ? email.attachments.map(item => `- ${item.fileName || 'attachment'} (${item.mimeType || 'application/octet-stream'})`).join('\n')
    : 'None';
  const headerBlock = [
    `Scout this forwarded email opportunity for Nuseir.`,
    ``,
    `Submission Source: ${email.sourceLabel || classifyInboundSource(email)}`,
    `From: ${email.from}`,
    email.to ? `To: ${email.to}` : '',
    email.cc ? `CC: ${email.cc}` : '',
    `Subject: ${email.subject}`,
    email.messageId ? `Message ID: ${email.messageId}` : '',
    ``,
    `Attachments:`,
    attachmentManifest,
    ``,
    `Additional text:`,
    mainBody || '(No plain-text body provided.)'
  ].filter(Boolean).join('\n');

  const content = [{ type: 'text', text: headerBlock }];
  for (const attachment of email.attachments.filter(item => item.mimeType.startsWith('image/'))) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mimeType || 'image/png',
        data: attachment.data
      }
    });
  }
  return content;
}

function getInboundAutomationMode(env = process.env) {
  return String(env.SCOUT_EMAIL_AUTOMATION_LARK_MODE || 'draft_only').trim().toLowerCase();
}

function shouldSendInboundAutomationToLark(env = process.env) {
  return getInboundAutomationMode(env) === 'live';
}

function isAuthorizedInboundEmail(req) {
  const secret = process.env.SCOUT_INBOUND_EMAIL_SECRET?.trim();
  if (!secret) return false;
  const provided = String(req.headers['x-scout-inbound-secret'] || req.body?.secret || '').trim();
  return Boolean(provided) && timingSafeEqual(provided, secret);
}

function buildAutomationLarkDraft(assessment, email) {
  const title = `${formatOpportunityType(assessment.opportunity_type)}: ${assessment.proposal_name || assessment.brand || email.subject || 'Opportunity'}`;
  return `${title}

${assessment.proposal_summary || assessment.ask || 'No proposal summary available.'}

Source - ${email.sourceLabel || classifyInboundSource(email)}
Confidence - ${assessment.confidence || 'Medium'}
Review Status - ${assessment.review_flag || 'Ready'}
From - ${email.from}
Subject - ${email.subject}
Requester - ${assessment.requester_name || 'Not stated'}
Timeline - ${assessment.timeline || 'Not stated'}
Location - ${assessment.location || 'Not stated'}
Budget - ${assessment.budget || 'Not stated'}

My Take: ${assessment.verdict || 'MAYBE'}

Why:
${assessment.decision_reason || assessment.one_line_take || 'Scout did not provide a reason.'}

Next step:
${assessment.next_step || 'Not stated'}`;
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
    ADD COLUMN IF NOT EXISTS commission_breakdown TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS intake_source TEXT NOT NULL DEFAULT 'Manual',
    ADD COLUMN IF NOT EXISTS intake_confidence TEXT NOT NULL DEFAULT 'Medium',
    ADD COLUMN IF NOT EXISTS inbound_message_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS source_fingerprint TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE scout_proposals ALTER COLUMN status SET DEFAULT 'Pending Details'`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS scout_proposals_inbound_message_id_idx
    ON scout_proposals (inbound_message_id) WHERE inbound_message_id <> ''`);
  await pool.query(`CREATE INDEX IF NOT EXISTS scout_proposals_source_fingerprint_idx
    ON scout_proposals (source_fingerprint) WHERE source_fingerprint <> ''`);
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

app.get('/api/proposals', requireDatabaseRead, async (req, res) => {
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
        p.payment_status, p.commission_breakdown, p.intake_source, p.intake_confidence, p.inbound_message_id, p.source_fingerprint, p.assessment,
        COALESCE((SELECT json_agg(json_build_object('id', f.id, 'kind', f.kind, 'file_name', f.file_name, 'mime_type', f.mime_type, 'file_size', f.file_size)) FROM scout_proposal_files f WHERE f.proposal_id = p.id), '[]'::json) AS attachments
       FROM scout_proposals p ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY p.created_at DESC LIMIT 500`,
      values
    );
    res.json({ proposals: result.rows, statuses: proposalStatuses, access_role: getAccessRole(req) });
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
  try {
    const deleted = await deleteProposalById({
      pool,
      id: Number(req.params.id),
      afterDelete: syncGoogleSheetSoon
    });
    res.json({ deleted: true, proposal: deleted });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not delete proposal.' });
  }
});

app.post('/api/proposals/:id/apply-update', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Proposal database is not connected.' });
  try {
    const id = Number(req.params.id);
    const assessment = req.body?.assessment;
    const updateText = String(req.body?.updateText || '').trim();
    const screenshots = Array.isArray(req.body?.screenshots) ? req.body.screenshots : [];
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid proposal ID.' });
    if (!assessment || typeof assessment !== 'object') return res.status(400).json({ error: 'Missing approved Scout update.' });
    if (!opportunityTypes.includes(String(assessment.opportunity_type || ''))) return res.status(400).json({ error: 'Invalid opportunity type.' });

    await databaseReady;
    const current = await pool.query('SELECT source_text, event_date, location FROM scout_proposals WHERE id = $1', [id]);
    if (!current.rowCount) return res.status(404).json({ error: 'Proposal not found.' });
    const prior = current.rows[0];
    const mergedSource = [prior.source_text, updateText].filter(Boolean).join('\n\n--- Update ---\n\n').slice(0, 50000);
    const proposedDate = String(assessment.timeline || '').trim();
    const proposedLocation = String(assessment.location || '').trim();
    const eventDate = proposedDate && !/not stated|unknown|tbd/i.test(proposedDate) ? proposedDate : prior.event_date;
    const location = proposedLocation && !/not stated|unknown|tbd/i.test(proposedLocation) ? proposedLocation : prior.location;

    const result = await pool.query(
      `UPDATE scout_proposals SET assessment = $1::jsonb, source_text = $2, event_date = $3, location = $4, updated_at = NOW()
       WHERE id = $5 RETURNING id, created_at, updated_at, status, notes, event_date, location, payment_status, commission_breakdown, source_text, assessment`,
      [JSON.stringify(assessment), mergedSource, eventDate || '', location || '', id]
    );

    let screenshotIndex = 0;
    for (const item of screenshots) {
      const base64 = String(item?.data || '');
      const imageData = Buffer.from(base64, 'base64');
      if (!imageData.length || imageData.length > 10 * 1024 * 1024) continue;
      screenshotIndex += 1;
      const mimeType = String(item?.mediaType || 'image/jpeg');
      const extension = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
      await pool.query(
        `INSERT INTO scout_proposal_files (proposal_id, kind, file_name, mime_type, file_size, file_data)
         VALUES ($1, 'source', $2, $3, $4, $5)`,
        [id, `proposal-update-${Date.now()}-${screenshotIndex}.${extension}`, mimeType, imageData.length, imageData]
      );
    }

    syncGoogleSheetSoon();
    res.json({ proposal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not apply Scout update.' });
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

app.get('/api/proposals/files/:fileId', requireDatabaseRead, async (req, res) => {
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
    const { system, content, updateProposalId, previewOnly } = req.body || {};
    if (!system || !Array.isArray(content)) {
      return res.status(400).json({ error: 'Missing assessment content.' });
    }
    const existingProposalId = Number(updateProposalId || 0);
    if (existingProposalId && !isAuthorizedAdmin(req)) {
      return res.status(403).json({ error: 'Not authorized. Updating existing proposals is restricted to Patty.' });
    }

    const assessment = await runScoutAssessment({ system, content, existingProposalId, previewOnly });
    return res.status(200).json(assessment);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Assessment failed.' });
  }
});

app.post('/api/inbound-email', async (req, res) => {
  if (!isAuthorizedInboundEmail(req)) {
    return res.status(403).json({ error: 'Not authorized. Invalid inbound email secret.' });
  }

  try {
    const email = normalizeInboundEmail(req.body || {});
    const extractedBody = extractBestEmailBody(email.text);
    const intakeSource = email.sourceLabel || classifyInboundSource(email);
    const intakeConfidence = inferIntakeConfidence(email, extractedBody);
    const sourceFingerprint = buildSourceFingerprint(email, extractedBody);
    if (pool) {
      await databaseReady;
      const duplicate = await pool.query(
        `SELECT id, assessment, status, created_at FROM scout_proposals
         WHERE ($1 <> '' AND inbound_message_id = $1)
            OR ($2 <> '' AND source_fingerprint = $2)
         ORDER BY id DESC LIMIT 1`,
        [email.messageId || '', sourceFingerprint]
      );
      if (duplicate.rowCount) {
        const existing = duplicate.rows[0];
        const duplicateAssessment = {
          ...(existing.assessment || {}),
          duplicate_of_proposal_id: existing.id
        };
        return res.status(200).json({
          ok: true,
          duplicate: true,
          email: {
            from: email.from,
            subject: email.subject,
            messageId: email.messageId || ''
          },
          assessment: duplicateAssessment,
          lark_draft: `Duplicate detected for proposal #${existing.id}. Scout skipped a new record because this email appears to match an existing intake.`,
          lark_delivery: {
            mode: getInboundAutomationMode(),
            status: 'skipped_duplicate',
            note: `Duplicate detected; existing proposal #${existing.id} kept.`
          }
        });
      }
    }
    const content = buildInboundEmailContent(email);
    const assessment = await runScoutAssessment({
      system: scoutAssessmentSystemPrompt,
      content,
      existingProposalId: 0,
      previewOnly: false,
      proposalMeta: {
        intakeSource,
        intakeConfidence,
        messageId: email.messageId || '',
        sourceFingerprint,
        rawAttachments: email.attachments
      }
    });

    const larkDraft = buildAutomationLarkDraft(assessment, email);
    const deliveryMode = getInboundAutomationMode();
    let larkDelivery = { mode: deliveryMode, status: 'skipped' };

    if (shouldSendInboundAutomationToLark()) {
      const liveResult = await sendLarkInteractiveMessage({
        message: larkDraft,
        assessment,
        receiveId: process.env.SCOUT_EMAIL_AUTOMATION_TEST_RECEIVE_ID?.trim(),
        receiveIdType: process.env.SCOUT_EMAIL_AUTOMATION_TEST_RECEIVE_ID_TYPE?.trim() || 'chat_id'
      });
      larkDelivery = { mode: deliveryMode, status: 'sent', ...liveResult };
    } else {
      larkDelivery = {
        mode: deliveryMode,
        status: 'draft_only',
        note: 'Lark delivery skipped because SCOUT_EMAIL_AUTOMATION_LARK_MODE is not set to live.'
      };
    }

    return res.status(200).json({
      ok: true,
      email: {
        from: email.from,
        subject: email.subject,
        messageId: email.messageId || ''
      },
      assessment,
      lark_draft: larkDraft,
      lark_delivery: larkDelivery
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not process inbound email.' });
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

  try {
    const { message, assessment } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Missing message draft.' });
    }
    const result = await sendLarkInteractiveMessage({ message: String(message).trim(), assessment });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not send Lark message.' });
  }
});

app.post('/api/nuseir-digest/test', async (req, res) => {
  if (!isAuthorizedAdmin(req)) {
    return res.status(403).json({ error: 'Not authorized. This action is restricted to Patty.' });
  }
  if (!pool) {
    return res.status(503).json({ error: 'Proposal database is not connected. Add DATABASE_URL in Render.' });
  }

  try {
    await databaseReady;
    const result = await pool.query(
      `SELECT p.id, p.created_at, p.updated_at, p.status, p.notes, p.event_date, p.location, p.source_text,
        p.payment_status, p.commission_breakdown, p.intake_source, p.intake_confidence, p.inbound_message_id, p.source_fingerprint, p.assessment
       FROM scout_proposals p
       WHERE p.status = $1
       ORDER BY p.created_at DESC
       LIMIT 200`,
      [pendingNuseirStatus]
    );

    const proposals = result.rows || [];
    const summary = buildNuseirSummary(proposals);
    const receiveId = process.env.SCOUT_NUSEIR_DIGEST_TEST_RECEIVE_ID?.trim()
      || process.env.SCOUT_EMAIL_AUTOMATION_TEST_RECEIVE_ID?.trim()
      || process.env.COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID?.trim()
      || process.env.COLLAB_ASSESSOR_LARK_NUSEIR_EMAIL?.trim();
    const receiveIdType = process.env.SCOUT_NUSEIR_DIGEST_TEST_RECEIVE_ID_TYPE?.trim()
      || process.env.SCOUT_EMAIL_AUTOMATION_TEST_RECEIVE_ID_TYPE?.trim()
      || process.env.COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID_TYPE?.trim()
      || (process.env.COLLAB_ASSESSOR_LARK_NUSEIR_EMAIL?.trim() ? 'email' : 'chat_id');

    if (!receiveId) {
      return res.status(400).json({
        error: 'No test digest Lark target is configured. Add SCOUT_NUSEIR_DIGEST_TEST_RECEIVE_ID (preferred) or reuse SCOUT_EMAIL_AUTOMATION_TEST_RECEIVE_ID.'
      });
    }

    const intro = proposals.length
      ? `Scout test digest for Nuseir\n\nReview only — this is a test digest, not the live Scout group.\n\n${summary}`
      : `Scout test digest for Nuseir\n\nReview only — this is a test digest, not the live Scout group.\n\n${summary}`;
    const sendResult = await sendLarkInteractiveMessage({
      message: intro,
      receiveId,
      receiveIdType
    });

    return res.status(200).json({
      ok: true,
      proposals: proposals.length,
      receive_id_type: receiveIdType,
      summary,
      ...sendResult
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not send the test digest.' });
  }
});

function isAuthorizedAdmin(req) {
  return getAccessRole(req) === 'admin';
}

function getAccessRole(req) {
  const adminKey = process.env.SCOUT_ADMIN_KEY?.trim();
  const viewerKey = process.env.SCOUT_VIEWER_KEY?.trim();
  const providedKey = req.headers['x-scout-admin-key'];
  if (typeof providedKey !== 'string') return 'none';
  const trimmed = providedKey.trim();
  if (adminKey && timingSafeEqual(trimmed, adminKey)) return 'admin';
  if (viewerKey && timingSafeEqual(trimmed, viewerKey)) return 'viewer';
  return 'none';
}

function requireAdmin(req, res, next) {
  if (!isAuthorizedAdmin(req)) {
    return res.status(403).json({ error: 'Not authorized. The proposal database is restricted to Patty.' });
  }
  next();
}

function requireDatabaseRead(req, res, next) {
  if (getAccessRole(req) === 'none') {
    return res.status(403).json({ error: 'Not authorized. This proposal view is restricted.' });
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

function buildLarkCardContent(message) {
  const lines = message.split(/\r?\n/);
  const title = lines.shift() || 'Scout Opportunity';
  const body = lines.join('\n').trim() || 'No details provided.';

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: title
      }
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: body
        }
      }
    ]
  };
}

function buildScoutAssessmentCard(assessment, fallbackMessage) {
  const title = `${formatOpportunityType(assessment.opportunity_type)}: ${assessment.proposal_name || assessment.brand || 'Opportunity'}`;
  const verdict = assessment.verdict || 'MAYBE';
  const headerTemplate = verdict === 'YES' ? 'green' : verdict === 'NO' ? 'red' : 'orange';
  const summary = assessment.proposal_summary || getMessageBody(fallbackMessage) || 'No proposal summary available.';
  const reason = assessment.decision_reason || assessment.one_line_take || 'Scout did not provide a reason.';

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: headerTemplate,
      title: {
        tag: 'plain_text',
        content: title
      }
    },
    elements: [
      md(`**RECOMMENDATION**\n${scoreMarker(verdict)} **${verdict}** — ${assessment.one_line_take || reason}`),
      { tag: 'hr' },
      md(`**SUMMARY**\n${summary}`),
      md(`**Requester:** ${assessment.requester_name || 'Not stated'}\n**Requester Context:** ${assessment.requester_context || 'Not verified'}`),
      md(`**Timeline:** ${assessment.timeline || 'Not stated'}\n**Budget:** ${assessment.budget || 'Not stated'}\n**Website/Social Links:** ${assessment.social_links || 'Not stated'}`),
      { tag: 'hr' },
      md(`**OPPORTUNITY TYPE**\n${formatOpportunityType(assessment.opportunity_type)}`),
      { tag: 'hr' },
      md(`**ASK**\n${assessment.ask || 'Not stated'}`),
      md(`**NEXT STEP**\n${assessment.next_step || 'Not stated'}`),
      { tag: 'hr' },
      md(`**REASON**\n${reason}`)
    ]
  };
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

function criterionLine(label, score, reason) {
  return `**${label}:** ${scoreMarker(score)} **${score || 'MEDIUM'}**${reason ? ` — ${reason}` : ''}`;
}

function scoreMarker(score = '') {
  if (['YES', 'STRONG', 'HIGH', 'WORTH IT'].includes(score)) return '🟢';
  if (['NO', 'WEAK', 'LOW', 'NOT WORTH IT'].includes(score)) return '🔴';
  return '🟡';
}

function formatOpportunityType(type) {
  if (type === 'Collaboration / Content Opportunity') return 'Content Opportunity';
  if (type === 'Non-Profit / Cause Initiative') return 'Non-Profit Initiative';
  return type || 'Opportunity';
}

function getMessageBody(message) {
  const lines = String(message || '').split(/\r?\n/);
  lines.shift();
  return lines.join('\n').trim();
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

async function sendLarkInteractiveMessage({ message, assessment, receiveId, receiveIdType }) {
  const resolvedReceiveId = receiveId
    || process.env.COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID?.trim()
    || process.env.COLLAB_ASSESSOR_LARK_NUSEIR_EMAIL?.trim();
  const resolvedReceiveIdType = receiveIdType
    || process.env.COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID_TYPE?.trim()
    || (process.env.COLLAB_ASSESSOR_LARK_NUSEIR_EMAIL?.trim() ? 'email' : 'open_id');

  if (!resolvedReceiveId) {
    throw new Error('Lark recipient is not set. Add COLLAB_ASSESSOR_LARK_NUSEIR_EMAIL in Render, or add COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID plus COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID_TYPE.');
  }

  const token = await getLarkTenantAccessToken();
  const response = await fetch(`https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(resolvedReceiveIdType)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      receive_id: resolvedReceiveId,
      msg_type: 'interactive',
      content: JSON.stringify(assessment
        ? buildScoutAssessmentCard(assessment, String(message).trim())
        : buildLarkCardContent(String(message).trim()))
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code) {
    throw new Error(data.msg || data.error?.message || 'Could not send Lark message.');
  }
  return { message_id: data.data?.message_id, data };
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
