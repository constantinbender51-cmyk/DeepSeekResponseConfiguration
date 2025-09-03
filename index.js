// index.js  —  Railway-ready Redis-Book-Generator
// Generates a book via DeepSeek, stores it in Redis, serves download button
// NO JSON—only plain markdown lists
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

/* ---------- DeepSeek helper (plain text) ---------- */
async function askDeepSeek(systemPrompt, userPrompt, maxTokens = 2000) {
  maxTokens = Math.max(1, Math.min(maxTokens, 8000));

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
      max_tokens: maxTokens
    },
    {
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return data.choices[0].message.content.trim();
}

/* ---------- TOC parser ---------- */
function parseToc(md) {
  const lines = md.split('\n');
  const toc   = [];
  for (const line of lines) {
    const m = line.match(/^-\s*([^)]+)\s*\((\d+)\s*pages?\)/i);
    if (m) toc.push({ title: m[1].trim(), pages: parseInt(m[2]) });
  }
  return toc;
}

/* ---------- Book generation ---------- */
async function generateBook(keywords, totalPages) {
  // 1. TOC (plain markdown bullets)
  const tocPrompt =
    `Create a markdown table of contents for a book on "${keywords}" (~${totalPages} pages).\n` +
    `Return only bullet lines like:\n\n` +
    `- Chapter 1: Introduction (5 pages)\n` +
    `No extra text.`;

  const tocMd = await askDeepSeek(tocPrompt, '', 1000);
  const toc   = parseToc(tocMd);

  let bookMarkdown = `# ${keywords}\n\nGenerated automatically with DeepSeek.\n\n## Table of Contents\n\n${tocMd}\n\n---\n\n`;

  // 2. Iterate chapters
  for (const ch of toc) {
    // 2a. Plain-text outline prompt
    const outlinePrompt =
      `Outline the chapter "${ch.title}" (${ch.pages} pages).\n` +
      `Return a markdown bullet list with sections and subsections only.`;

    const outline = await askDeepSeek(outlinePrompt, '', 800);

    // 2b. Full chapter prompt
    const fullPrompt =
      `Using the outline below, write the complete markdown chapter "${ch.title}" (${ch.pages} pages).\n` +
      `Expand every bullet into full paragraphs (~${Math.round(ch.pages * 250)} words).\n` +
      `Include code snippets as fenced blocks.\n\n` +
      `Outline:\n${outline}`;

    const chapterText = await askDeepSeek(fullPrompt, '', Math.min(400 + ch.pages * 250, 8000));
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
