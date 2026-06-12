import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

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
                reach_score: { type: 'string', enum: ['STRONG', 'MEDIUM', 'WEAK'] },
                reach_reason: { type: 'string' },
                relevance_score: { type: 'string', enum: ['STRONG', 'MEDIUM', 'WEAK'] },
                relevance_reason: { type: 'string' },
                business_score: { type: 'string', enum: ['STRONG', 'MEDIUM', 'WEAK'] },
                business_reason: { type: 'string' },
                ask: { type: 'string' },
                next_step: { type: 'string' },
                lark_message: { type: 'string' }
              },
              required: [
                'brand',
                'verdict',
                'one_line_take',
                'reach_score',
                'reach_reason',
                'relevance_score',
                'relevance_reason',
                'business_score',
                'business_reason',
                'ask',
                'next_step',
                'lark_message'
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

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Collab Assessor running on port ${port}`);
});
