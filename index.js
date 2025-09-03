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
      max_tokens: maxTokens
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

/* ---------- Book generation ---------- */
async function generateBook(keywords, totalPages) {
  /* -------------------------------------------------
   * 1. Build the table of contents
   * ------------------------------------------------- */
  const tocPrompt = `Create a concise table of contents for a book on "${keywords}" (~${totalPages} pages).  
Return ONLY a JSON array like:
[{"title":"Chapter 1: Foo","description":"A brief 1–2 sentence summary of what this chapter covers.","pages":15}, ...]  
If you must add prose, include the JSON array on its own line.`;

  let toc = await askDeepSeek(tocPrompt, null, 1000);

  // Fallback: extract JSON if DeepSeek wrapped it in prose
  if (!Array.isArray(toc)) {
    console.warn('DeepSeek returned prose; asking it to extract JSON...');
    const secondPrompt = `Below is the response. Extract and return ONLY the JSON array, nothing else.\n\n${toc}`;
    toc = await askDeepSeek(secondPrompt, null, 1000);
  }

  if (!Array.isArray(toc)) {
    throw new Error('Could not obtain valid TOC array from DeepSeek');
  }

  /* -------------------------------------------------
   * 2. Build the markdown skeleton
   * ------------------------------------------------- */
  let bookMarkdown = `# ${keywords}\n\nGenerated automatically with DeepSeek.\n\n## Table of Contents\n\n`;
  toc.forEach((ch, idx) => {
    bookMarkdown += `${idx + 1}. ${ch.title} (${ch.pages} pp.)\n`;
  });
  bookMarkdown += '\n---\n\n';

  /* -------------------------------------------------
   * 3. Iterate chapters
   * ------------------------------------------------- */
  for (let i = 0; i < toc.length; i++) {
    const ch = toc[i];

    /* 3a. Ensure description exists (fallback to 2-sentence description) */
if (!ch.description) {
  const descPrompt = `Write a concise description of the contents for the chapter "${ch.title}".`;
  ch.description = await askDeepSeek(descPrompt, null, 300);
}

    // 3b. Write the full chapter
    const chapterPrompt = `You are an expert author.  
Write **chapter ${i + 1}: ${ch.title}** (${ch.pages} pages) based on this description:

${ch.description}

Return well-structured markdown with headings, paragraphs, bullet lists, and code snippets where appropriate. Aim for roughly ${Math.round(ch.pages * 250)} words.`;
    const chapterText = await askDeepSeek(chapterPrompt, null, ch.pages * 80);

    // 3c. Attach to book
    bookMarkdown += `# ${ch.title}\n\n> ${ch.description}\n\n${chapterText}\n\n---\n\n`;
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
