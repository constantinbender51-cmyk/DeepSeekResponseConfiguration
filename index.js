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

/* ---------- DeepSeek helpers ---------- */

/**
 * Calls DeepSeek and returns *either* parsed JSON *or* null.
 * Falls back to extracting a JSON array/object from the text.
 */
async function askDeepSeek(systemPrompt, userPrompt, maxTokens = 4000) {
  const messages = [{ role: 'system', content: systemPrompt }];
  if (userPrompt) messages.push({ role: 'user', content: userPrompt });

  const { data } = await axios.post(
  process.env.DEEPSEEK_URL || 'https://api.deepseek.com/v1/chat/completions',
  {
    model: 'deepseek-chat',
    messages,
    temperature: 0.0,
    max_tokens,
    response_format: { type: 'json_object' }   // <-- NEW
  },
  {
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    }
  }
);
  let raw = data.choices[0]?.message?.content?.trim() || '';

  // Strip ```json … ``` if present
  const codeBlockMatch = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (codeBlockMatch) raw = codeBlockMatch[1].trim();

  // 1. Try direct JSON
  try {
    return JSON.parse(raw);
  } catch (_) { /* ignore */ }

  // 2. Look for JSON array `[...]` or object `{...}` in the text
  const jsonLike = raw.match(/(\[.*?\]|\{.*?\})/s);
  if (jsonLike) {
    try {
      return JSON.parse(jsonLike[0]);
    } catch (_) { /* ignore */ }
  }

  // 3. If nothing worked, return the raw string so caller can decide
  return raw;
}

async function buildChapterBlueprint(chapterTitle, chapterPages, description) {
  const prompt = `You are an expert technical author.  
Create a detailed, hierarchical outline for the upcoming chapter:  
"${chapterTitle}" (${chapterPages} pages ≈ ${Math.round(chapterPages * 250)} words).  
The outline must be a JSON object with this exact shape:  
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
}
Be exhaustive; every page should have at least one section or subsection.  
Return ONLY the raw JSON, no prose.`;

  return await askDeepSeek(prompt, null, 800);
}

/* ---------- Book generation ---------- */
async function generateBook(keywords, totalPages) {
  // 1. TOC
  const tocPrompt = `Create a concise table of contents for a book on "${keywords}" (~${totalPages} pages).  
    Return ONLY a JSON array like:
    [{"title":"Chapter 1: Foo","pages":15}, ...]  
    If you must add prose, include the JSON array on its own line.`;

  let toc = await askDeepSeek(tocPrompt, null, 1000);
  // If DeepSpeak gave us text instead of JSON, use a *tiny* secondary prompt
    if (!Array.isArray(toc)) {
      console.warn('DeepSeek returned prose; asking it to extract JSON...');
      const secondPrompt = `Below is the response. Extract and return ONLY the JSON array, nothing else.\n\n${toc}`;
      toc = await askDeepSeek(secondPrompt, null, 1000);
    }

  // Final safety net
  if (!Array.isArray(toc)) {
    throw new Error('Could not obtain valid TOC array from DeepSeek');
  }
  let bookMarkdown = `# ${keywords}\n\nGenerated automatically with DeepSeek.\n\n## Table of Contents\n\n`;
  toc.forEach((ch, idx) => (bookMarkdown += `${idx + 1}. ${ch.title} (${ch.pages} pp.)\n`));
  bookMarkdown += '\n---\n\n';

  // 2. Iterate chapters
  for (let i = 0; i < toc.length; i++) {
    const ch = toc[i];

    // 2a. Chapter description
    const descPrompt = `Write a concise 2-sentence description for the chapter "${ch.title}".`;
    const description = await askDeepSeek(descPrompt, null, 200);

    const blueprint = await buildChapterBlueprint(ch.title, ch.pages, description);

    const fullPrompt = `Using the following detailed blueprint, write the complete markdown chapter **"${ch.title}"** (${ch.pages} pages).  
    Expand every bullet into full paragraphs (≈ 250 words per page).  
    Insert all requested code snippets as fenced blocks with brief explanations.  
    Keep the exact section/sub-section hierarchy; do NOT add new top-level sections.  
    Blueprint: ${JSON.stringify(blueprint, null, 2)}`;

    const chapterText = await askDeepSeek(fullPrompt, null, ch.pages * 90);

    bookMarkdown += `# ${ch.title}\n\n${chapterText}\n\n---\n\n`;
  }

  await redis.set('book:markdown', bookMarkdown);
  return bookMarkdown;
}

/* ---------- Routes ---------- */
app.use(express.static(path.join(__dirname, 'public')));

app.get('/generate', async (req, res) => {
  const keywords  = req.query.keywords || 'Artificial Intelligence';
  const totalPages = parseInt(req.query.pages) || 120;

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
