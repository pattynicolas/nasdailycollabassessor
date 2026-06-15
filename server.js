import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const larkUserSessions = new Map();

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
    version: 'scout-requester-credibility-1',
    updated: '2026-06-15'
  });
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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing OPENAI_API_KEY in Render environment variables.' });
  }

  try {
    const { system, content } = req.body || {};
    if (!system || !Array.isArray(content)) {
      return res.status(400).json({ error: 'Missing assessment content.' });
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
      return res.status(openaiResponse.status).json({
        error: data.error?.message || 'OpenAI request failed.'
      });
    }

    const outputText = data.output_text || (data.output || [])
      .flatMap(item => item.content || [])
      .filter(part => part.type === 'output_text')
      .map(part => part.text)
      .join('');

    if (!outputText) {
      return res.status(500).json({ error: 'OpenAI returned no assessment text.' });
    }

    return res.status(200).json(JSON.parse(outputText));
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Assessment failed.' });
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

  const receiveId = process.env.COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID?.trim()
    || process.env.COLLAB_ASSESSOR_LARK_NUSEIR_EMAIL?.trim();
  const receiveIdType = process.env.COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID_TYPE?.trim()
    || (process.env.COLLAB_ASSESSOR_LARK_NUSEIR_EMAIL?.trim() ? 'email' : 'open_id');

  if (!receiveId) {
    return res.status(500).json({
      error: 'Lark recipient is not set. Add COLLAB_ASSESSOR_LARK_NUSEIR_EMAIL in Render, or add COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID plus COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID_TYPE.'
    });
  }

  try {
    const { message, assessment } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Missing message draft.' });
    }

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
        content: JSON.stringify(assessment
          ? buildScoutAssessmentCard(assessment, String(message).trim())
          : buildLarkCardContent(String(message).trim()))
      })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.code) {
      return res.status(response.ok ? 500 : response.status).json({
        error: data.msg || data.error?.message || 'Could not send Lark message.',
        details: data
      });
    }

    return res.status(200).json({ ok: true, message_id: data.data?.message_id, data });
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
