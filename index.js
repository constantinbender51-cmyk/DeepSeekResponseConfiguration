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
 * Calls DeepSeek and guarantees a **parsed JSON object**.
 * Retries up to `maxRetries` times if the answer isn’t JSON.
 */
async function askDeepSeek(systemPrompt, userPrompt, maxTokens = 4000, maxRetries = 3) {
  const messages = [{ role: 'system', content: systemPrompt }];
  if (userPrompt) messages.push({ role: 'user', content: userPrompt });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data } = await axios.post(
        process.env.DEEPSEEK_URL || 'https://api.deepseek.com/v1/chat/completions',
        {
          model: 'deepseek-chat',
          messages,
          temperature: 0.0,            // deterministic
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

      // Strip ```json ... ``` wrapper if present
      const codeBlockMatch = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
      if (codeBlockMatch) raw = codeBlockMatch[1];

      // Attempt to parse
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`JSON parse attempt ${attempt} failed`, err.message);
      if (attempt === maxRetries) {
        throw new Error(`DeepSeek did not return valid JSON after ${maxRetries} tries`);
      }
      // wait 1s, 2s, 4s …
      await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

/* ---------- Book generation ---------- */
async function generateBook(keywords, totalPages) {
  // 1. TOC
  const tocPrompt = `You are a machine. Return ONLY raw JSON.
Keywords: ${keywords}
Total pages: ${totalPages}
Return a JSON array like:
[{"title":"Chapter 1: Introduction","pages":15}, ...]
Do NOT add explanations, markdown, or code blocks.`;
  const toc = await askDeepSeek(tocPrompt, null, 1000);

  let bookMarkdown = `# ${keywords}\n\nGenerated automatically with DeepSeek.\n\n## Table of Contents\n\n`;
  toc.forEach((ch, idx) => (bookMarkdown += `${idx + 1}. ${ch.title} (${ch.pages} pp.)\n`));
  bookMarkdown += '\n---\n\n';

  // 2. Iterate chapters
  for (let i = 0; i < toc.length; i++) {
    const ch = toc[i];

    // 2a. Chapter description
    const descPrompt = `Write a concise 2-sentence description for the chapter "${ch.title}".`;
    const description = await askDeepSeek(descPrompt, null, 200);

    // 2b. Full chapter
    const chapterPrompt = `You are an expert author.  
Write **chapter ${i + 1}: ${ch.title}** (${ch.pages} pages) based on this description:\n${description}\n\nReturn well-structured markdown with headings, paragraphs, bullet lists, and code snippets where appropriate. Aim for roughly ${Math.round(ch.pages * 250)} words.`;
    const chapterText = await askDeepSeek(chapterPrompt, null, ch.pages * 80);

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
