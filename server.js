import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
        max_output_tokens: 1200,
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto',
        text: {
          format: {
            type: 'json_schema',
            name: 'collab_assessment',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                brand: { type: 'string' },
                verdict: { type: 'string', enum: ['YES', 'MAYBE', 'NO'] },
                one_line_take: { type: 'string' },
                proposal_summary: { type: 'string' },
                timeline: { type: 'string' },
                budget: { type: 'string' },
                social_links: { type: 'string' },
                reach_score: { type: 'string', enum: ['STRONG', 'MEDIUM', 'WEAK'] },
                reach_reason: { type: 'string' },
                relevance_score: { type: 'string', enum: ['STRONG', 'MEDIUM', 'WEAK'] },
                relevance_reason: { type: 'string' },
                business_score: { type: 'string', enum: ['STRONG', 'MEDIUM', 'WEAK'] },
                business_reason: { type: 'string' },
                ask: { type: 'string' },
                next_step: { type: 'string' }
              },
              required: [
                'brand',
                'verdict',
                'one_line_take',
                'proposal_summary',
                'timeline',
                'budget',
                'social_links',
                'reach_score',
                'reach_reason',
                'relevance_score',
                'relevance_reason',
                'business_score',
                'business_reason',
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

    const createTaskUrl = process.env.LARK_TODO_CREATE_URL || 'https://open.larksuite.com/open-apis/task/v2/tasks';
    const taskResponse = await fetch(createTaskUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        summary: title,
        description: `${details}\n\nTask list: ${taskListUrl || `https://applink.larksuite.com/client/todo/task_list?guid=${taskListGuid}`}`,
        tasklist_guid: taskListGuid,
        task_list_guid: taskListGuid,
        tasklists: [{ guid: taskListGuid }]
      })
    });

    const taskData = await taskResponse.json();
    if (!taskResponse.ok || taskData.code) {
      return res.status(500).json({
        error: taskData.msg || taskData.error?.message || 'Lark task creation failed.'
      });
    }

    const task = taskData.data?.task || taskData.task || taskData.data || taskData;
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
  console.log(`Collab Assessor running on port ${port}`);
});
