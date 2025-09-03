// index.js  —  Railway-ready Redis-Book-Generator
// Generates a book via DeepSeek, stores it in Redis, serves download button
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const { createClient } = require('redis');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', err => console.error('Redis Client Error', err));

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL     = 'https://api.deepseek.com/v1/chat/completions';

if (!DEEPSEEK_API_KEY) {
  console.error('Missing DEEPSEEK_API_KEY');
  process.exit(1);
}

/* ---------- DeepSeek helper ---------- */
async function askDeepSeek(systemPrompt, userPrompt, maxTokens = 2000) {
  maxTokens = Math.max(1, Math.min(maxTokens, 8000)); // 1…8000 inclusive

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt }
  ];

  const { data } = await axios.post(
    DEEPSEEK_URL,
    {
      model: 'deepseek-chat',
      messages,
      temperature: 0.25,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' }
    },
    {
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
let raw = data.choices[0].message.content.trim()
           .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')
           .replace(/,\s*$/gm, '');          // remove trailing commas at EOL

// Build one array string
const jsonArray = '[' + raw.replace(/\n/g, '').replace(/}{/g, '},{') + ']';

return JSON.parse(jsonArray);
}

/* ---------- Blueprint helper ---------- */
async function buildChapterBlueprint(chapterTitle, chapterPages) {
  const prompt = `You are an expert technical author.  
Create a detailed, hierarchical outline for the upcoming chapter:  
"${chapterTitle}" (${chapterPages} pages ≈ ${Math.round(chapterPages * 250)} words).  
Return ONLY a JSON object with this exact shape:  
{
  "sections": [
    {
      "heading": "string",
      "subsections": ["string"],
      "codeSnippets": ["brief description"],
      "datasets": ["brief description"],
      "keyTakeaways": ["string"]
    }
  ]
}`;
  return await askDeepSeek(prompt, '', 800);
}

/* ---------- Book generation ---------- */
async function generateBook(keywords, totalPages) {
  // 1. TOC
  const tocPrompt = `You are a book planner.  
Keywords: ${keywords}  
Total pages: ${totalPages}  
Return ONLY a JSON array like:
[{"title":"Chapter 1: Foo","pages":15}, ...]`;
  const toc = await askDeepSeek(tocPrompt, '', 1000);

  let bookMarkdown = `# ${keywords}\n\nGenerated automatically with DeepSeek.\n\n## Table of Contents\n\n`;
  toc.forEach((ch, idx) => (bookMarkdown += `${idx + 1}. ${ch.title} (${ch.pages} pp.)\n`));
  bookMarkdown += '\n---\n\n';

  // 2. Iterate chapters
  for (const ch of toc) {
    const blueprint = await buildChapterBlueprint(ch.title, ch.pages);

    const fullPrompt = `Using the following blueprint, write the complete markdown chapter "${ch.title}" (${ch.pages} pages).  
Expand every bullet into full paragraphs (≈ ${Math.round(ch.pages * 250)} words).  
Insert code snippets as fenced blocks.  
Keep exact hierarchy.  
Blueprint: ${JSON.stringify(blueprint, null, 2)}`;

    const chapterText = await askDeepSeek(
      fullPrompt,
      '',
      Math.min(400 + ch.pages * 250, 8000)
    );
    bookMarkdown += `# ${ch.title}\n\n${chapterText}\n\n---\n\n`;
  }

  await redis.set('book:markdown', bookMarkdown);
  return bookMarkdown;
}

/* ---------- Routes ---------- */
app.use(express.static(path.join(__dirname, 'public')));

app.get('/generate', async (req, res) => {
  const keywords   = req.query.keywords || 'Machine Learning';
  const totalPages = parseInt(req.query.pages) || 50;

  try {
    await generateBook(keywords, totalPages);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/download', async (_req, res) => {
  const markdown = await redis.get('book:markdown');
  if (!markdown) return res.status(404).send('Book not found. Generate it first.');
  res.set('Content-Type', 'text/markdown');
  res.set('Content-Disposition', 'attachment; filename="book.md"');
  res.send(markdown);
});

/* ---------- Startup ---------- */
(async () => {
  await redis.connect();
  app.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));
})();
