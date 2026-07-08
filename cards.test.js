import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLarkCardContent, buildScoutAssessmentCard } from './cards.js';

test('buildScoutAssessmentCard uses the simplified latest layout', () => {
  const card = buildScoutAssessmentCard({
    proposal_id: 42,
    opportunity_type: 'Collaboration / Content Opportunity',
    proposal_name: 'Global Leaders Retreat 2026',
    verdict: 'YES',
    one_line_take: 'Strong fit.',
    proposal_summary: 'A short summary.',
    ask: 'Decide whether to attend.',
    requester_name: 'Alex',
    event_date: '2026-07-02',
    timeline: '2026-07-02',
    budget: '$10k',
    location: 'Toronto, Canada',
    social_links: 'https://example.com',
    decision_reason: 'Worth the trip.',
    source_files: [{ id: 1 }]
  }, 'Fallback body');

  assert.equal(card.header.template, 'green');
  assert.equal(card.header.title.content, 'Collaboration / Content Opportunity Global Leaders Retreat 2026');
  assert.equal(card.elements.length, 8);
  assert.match(card.elements[0].text.content, /🔍 Recommendation/);
  assert.match(card.elements[0].text.content, /🟢 YES/);
  assert.match(card.elements[2].text.content, /📄 Summary/);
  assert.match(card.elements[3].text.content, /❓ Ask\/ Deliverables/);
  assert.match(card.elements[4].text.content, /🗓️ Date/);
  assert.match(card.elements[5].text.content, /💵 Budget/);
  assert.match(card.elements[6].text.content, /📍Location/);
  assert.match(card.elements[7].text.content, /Original source/);
  assert.match(card.elements[7].text.content, /🔗 CLICK HERE/);
  assert.match(card.elements[7].text.content, /1 screenshot stored in Scout/);
});

test('buildLarkCardContent keeps freeform messages simple', () => {
  const card = buildLarkCardContent('Title line\nBody line 1\nBody line 2');

  assert.equal(card.header.title.content, 'Title line');
  assert.equal(card.elements[0].text.content, 'Body line 1\nBody line 2');
});
