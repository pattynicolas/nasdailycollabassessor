export const pendingNuseirStatus = 'Pending Nuseir';

function cleanText(value, fallback = 'Not stated') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
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

function getUrgencyTag(proposal, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const target = parseTimelineDate(proposal);
  if (!target) return '⚪ No deadline';
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.ceil((target.getTime() - now.getTime()) / dayMs);
  if (diffDays <= 3) return '🔴 Urgent';
  if (diffDays <= 7) return '🟠 This week';
  return '🟢 Upcoming';
}

function formatProposalTitle(proposal, options = {}) {
  const assessment = proposal?.assessment || {};
  const title = cleanText(assessment.proposal_name || assessment.brand, `Proposal #${proposal.id}`);
  const link = typeof options.linkForProposal === 'function' ? options.linkForProposal(proposal) : '';
  const urgency = getUrgencyTag(proposal, options);
  if (link) return `• ${urgency} **[${title}](${link})**`;
  return `• ${urgency} **${title}**`;
}

export function buildNuseirSummary(proposals = [], options = {}) {
  const pending = proposals.filter(proposal => String(proposal?.status || '').trim() === pendingNuseirStatus);
  if (!pending.length) {
    return `Pending Nuseir decisions\n\nNo proposals are currently marked "${pendingNuseirStatus}".`;
  }

  const lines = [
    'Pending Nuseir decisions',
    '',
    `${pending.length} proposal${pending.length === 1 ? '' : 's'} waiting on your thoughts.`,
    ''
  ];

  for (const proposal of pending) {
    const assessment = proposal?.assessment || {};
    lines.push(formatProposalTitle(proposal, options));
    lines.push(`Need: ${summarizeNeed(proposal)}`);
    lines.push(`Why it matters: ${summarizeWhyItMatters(proposal)}`);
    lines.push(`Timeline: ${summarizeDeadline(proposal)}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}
