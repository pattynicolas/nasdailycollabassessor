function md(content) {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content
    }
  };
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

function proposalUrl(proposalId) {
  return proposalId ? `https://nasdailycollabassessor.onrender.com/?view=database&proposal=${encodeURIComponent(proposalId)}` : '';
}

function titleCase(value) {
  const text = String(value || '').trim();
  return text ? text.replace(/\b\w/g, char => char.toUpperCase()) : '';
}

function formatLocation(location) {
  const text = String(location || '').trim();
  if (!text || /not stated|unknown|tbd|flexible/i.test(text)) return 'Not stated';
  if (/online/i.test(text)) return 'Online';
  return `In-Person · ${text}`;
}

function formatDateValue(eventDate, timeline) {
  const text = String(eventDate || timeline || '').trim();
  if (!text || /not stated|unknown|tbd|flexible/i.test(text)) return 'Not stated';
  return text;
}

function formatOriginalSummary({ sourceFiles, hasForwardedText }) {
  if (sourceFiles.length) {
    return `${sourceFiles.length} screenshot${sourceFiles.length === 1 ? '' : 's'} stored in Scout.`;
  }

  if (hasForwardedText) {
    return 'Forwarded email text stored in Scout.';
  }

  return 'Original source stored in Scout.';
}

function originalSourceLink(originalLink) {
  return originalLink ? `[🔗 CLICK HERE](${originalLink})` : '';
}

export function buildLarkCardContent(message) {
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

export function buildScoutAssessmentCard(assessment, fallbackMessage) {
  const opportunityType = titleCase(assessment.opportunity_type || 'Opportunity');
  const eventTitle = assessment.proposal_name || assessment.brand || 'Opportunity';
  const title = `${opportunityType} ${eventTitle}`.trim();
  const verdict = assessment.verdict || 'MAYBE';
  const headerTemplate = verdict === 'YES' ? 'green' : verdict === 'NO' ? 'red' : 'orange';
  const summary = assessment.proposal_summary || getMessageBody(fallbackMessage) || 'No proposal summary available.';
  const reason = assessment.decision_reason || assessment.one_line_take || 'Scout did not provide a reason.';
  const proposalId = assessment.proposal_record?.id || assessment.proposal_id || '';
  const sourceFiles = Array.isArray(assessment.source_files) ? assessment.source_files : [];
  const originalLink = proposalUrl(proposalId);
  const hasForwardedText = Boolean(String(fallbackMessage || '').trim());

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
      md(`**🔍 Recommendation**\n${scoreMarker(verdict)} ${verdict}\n${assessment.one_line_take || reason}`),
      { tag: 'hr' },
      md(`**📄 Summary**\n${summary}`),
      md(`**❓ Ask/ Deliverables**\n${assessment.ask || assessment.next_step || 'Not stated'}`),
      md(`**🗓️ Date**\n${formatDateValue(assessment.event_date, assessment.timeline)}`),
      md(`**💵 Budget**\n${assessment.budget || 'Not stated'}`),
      md(`**📍Location**\n${formatLocation(assessment.location)}`),
      md(`**Original source**\n${formatOriginalSummary({ sourceFiles, hasForwardedText })}${originalLink ? `\nWant to view original proposal/email from sender? ${originalSourceLink(originalLink)}` : ''}`)
    ]
  };
}
