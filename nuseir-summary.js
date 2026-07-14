import { readFileSync } from 'node:fs';

export const pendingNuseirStatus = 'Pending Nuseir';
const funnelUrl = 'https://nasdailycollabassessor.onrender.com/?view=database';
const funnelPassword = 'NasMeansPeople';
const pendingNuseirLarkLinks = loadPendingNuseirLarkLinks();

function cleanText(value, fallback = 'Not stated') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function normalizeProposalTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function loadPendingNuseirLarkLinks() {
  try {
    const url = new URL('./pending-nuseir-lark-links.json', import.meta.url);
    const raw = JSON.parse(readFileSync(url, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    return Object.entries(raw).reduce((acc, [title, link]) => {
      const key = normalizeProposalTitle(title);
      const value = String(link || '').trim();
      if (key && value) acc[key] = value;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function summarizeNeed(proposal) {
  const assessment = proposal?.assessment || {};
  const nextStep = cleanText(assessment.next_step, '');
  if (nextStep && !/not stated/i.test(nextStep)) return nextStep;
  const ask = cleanText(assessment.ask, '');
  if (ask && !/not stated/i.test(ask)) return `Decide on: ${ask}`;
  return 'Review and share go / no-go / questions.';
}

function summarizeWhyItMatters(proposal) {
  const assessment = proposal?.assessment || {};
  const reason = cleanText(assessment.decision_reason || assessment.one_line_take, '');
  if (reason && !/not stated/i.test(reason)) return reason;
  return cleanText(assessment.proposal_summary, 'Worth a quick read before deciding.');
}

function summarizeDeadline(proposal) {
  const assessment = proposal?.assessment || {};
  const date = cleanText(proposal?.event_date || assessment.timeline, '');
  if (!date || /not stated|unknown|tbd|flexible/i.test(date)) return 'No clear deadline stated.';
  return date;
}

function parseTimelineDate(proposal) {
  const assessment = proposal?.assessment || {};
  const value = cleanText(proposal?.event_date || assessment.timeline, '');
  if (!value || /not stated|unknown|tbd|flexible|end of summer/i.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function isUrgent(proposal, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const target = parseTimelineDate(proposal);
  if (!target) return false;
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.ceil((target.getTime() - now.getTime()) / dayMs);
  return diffDays <= 3;
}

function urgencyRank(proposal, options = {}) {
  return isUrgent(proposal, options) ? 0 : 1;
}

function formatProposalTitle(proposal, options = {}) {
  const assessment = proposal?.assessment || {};
  const title = cleanText(assessment.proposal_name || assessment.brand, `Proposal #${proposal.id}`);
  const link = typeof options.linkForProposal === 'function'
    ? options.linkForProposal(proposal)
    : pendingNuseirLarkLinks[normalizeProposalTitle(title)] || '';
  const prefix = isUrgent(proposal, options) ? '• 🔴 Urgent ' : '• ';
  if (link) return `${prefix}**[${title}](${link})**`;
  return `${prefix}**${title}**`;
}

export function buildNuseirSummary(proposals = [], options = {}) {
  const pending = proposals.filter(proposal => String(proposal?.status || '').trim() === pendingNuseirStatus);
  const footer = `\n\n[View all active proposals here](${funnelUrl})`;
  if (!pending.length) {
    return `No proposals are currently marked "${pendingNuseirStatus}".${footer}`;
  }

  const lines = [
    `Hey Nuseir! @Nuseir Yassqueen ✨`,
    `click on each item and reply on the thread.`,
    '',
    `${pending.length} proposal${pending.length === 1 ? '' : 's'} pending your decision. Please reply to each thread if YES or SKIP.`,
    `Password: ${funnelPassword}`,
    ''
  ];

  const ordered = [...pending].sort((a, b) => {
    const urgencyDiff = urgencyRank(a, options) - urgencyRank(b, options);
    if (urgencyDiff !== 0) return urgencyDiff;
    const dateA = parseTimelineDate(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const dateB = parseTimelineDate(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (dateA !== dateB) return dateA - dateB;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });

  for (const proposal of ordered) {
    lines.push(formatProposalTitle(proposal, options));
  }

  return `${lines.join('\n').trim()}${footer}`;
}
