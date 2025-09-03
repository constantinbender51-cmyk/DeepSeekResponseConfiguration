/* --------------  Env / deps  -------------- */
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const { createClient } = require('redis');
const path    = require('path');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

/* --------------  Tiny logger  -------------- */
const log = (level, msg, meta = '') => {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg} ${meta}`.trim();
  console.log(line);
  /* broadcast to every connected SSE client */
  if (global.sseClients) {
    global.sseClients.forEach(res => res.write(`data: ${line}\n\n`));
  }
};
const info = (m, meta) => log('info', m, meta);
const warn = (m, meta) => log('warn', m, meta);
const error = (m, meta) => log('error', m, meta);

/* --------------  Redis  -------------- */
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', err => error('Redis Client Error', err));
redis.on('connect', () => info('Redis connected'));

/* --------------  Config check  -------------- */
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL     = 'https://api.deepseek.com/v1/chat/completions';
if (!DEEPSEEK_API_KEY) {
  error('Missing DEEPSEEK_API_KEY – exiting');
  process.exit(1);
}

/* --------------  SSE endpoint  -------------- */
let clients = [];
global.sseClients = clients;
app.get('/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  clients.push(res);
  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
});

/* --------------  DeepSeek helper  -------------- */
async function askDeepSeek(systemPrompt, userPrompt, maxTokens = 4000) {
  const messages = [{ role: 'system', content: systemPrompt }];
  if (userPrompt) messages.push({ role: 'user', content: userPrompt });

  info('DeepSeek request', `tokens=${maxTokens}`);

  const t0 = Date.now();
  const { data } = await axios.post(
    DEEPSEEK_URL,
    {
      model: 'deepseek-chat',
      messages,
      temperature: 0,
      max_tokens: maxTokens
    },
    {
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  info('DeepSeek response', `latency=${Date.now() - t0}ms`);

  let raw = data.choices[0]?.message?.content?.trim() || '';

  const codeBlockMatch = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (codeBlockMatch) raw = codeBlockMatch[1].trim();

  try { return JSON.parse(raw); } catch (_) { /* ignore */ }

  const jsonLike = raw.match(/(\[.*?\]|\{.*?\})/s);
  if (jsonLike) {
    try { return JSON.parse(jsonLike[0]); } catch (_) { /* ignore */ }
  }
  return raw;
}

/* --------------  Book generator  -------------- */
async function generateBook(keywords, totalPages) {
  info('Start book generation', `keywords="${keywords}" pages=${totalPages}`);

  /* ---- TOC ---- */
  const tocPrompt = `Create a concise table of contents for a book on "${keywords}" (~${totalPages} pages).
Return ONLY a JSON array like:
[{"title":"Chapter 1: Foo","description":"A brief 1–2 sentence summary.","pages":15}, ...]
If you must add prose, include the JSON array on its own line.`;

  let toc = await askDeepSeek(tocPrompt, null, 1000);
  if (!Array.isArray(toc)) {
    warn('TOC was not an array – trying extraction');
    const secondPrompt = `Extract and return ONLY the JSON array, nothing else.\n\n${toc}`;
    toc = await askDeepSeek(secondPrompt, null, 1000);
  }
  if (!Array.isArray(toc)) throw new Error('Could not obtain valid TOC array from DeepSeek');
  info('TOC received', `${toc.length} chapters`);

  /* ---- Skeleton ---- */
  let bookMarkdown = `# ${keywords}\n\nGenerated automatically with DeepSeek.\n\n## Table of Contents\n\n`;
  toc.forEach((ch, idx) => { bookMarkdown += `${idx + 1}. ${ch.title} (${ch.pages} pp.)\n`; });
  bookMarkdown += '\n---\n\n';

  /* ---- Chapters ---- */
  for (let i = 0; i < toc.length; i++) {
    const ch = toc[i];
    info(`Generating chapter ${i + 1}`, `${ch.title} (${ch.pages} pp)`);

    if (!ch.description) {
      const descPrompt = `Write a concise description of the contents for the chapter "${ch.title}".`;
      ch.description = await askDeepSeek(descPrompt, null, 300);
    }

    const chapterPrompt = `You are an expert author.
Write **chapter ${i + 1}: ${ch.title}** (${ch.pages} pages) based on this description:

${ch.description}

Return well-structured markdown with headings, paragraphs, bullet lists, and code snippets where appropriate. Aim for roughly ${Math.round(ch.pages * 250)} words.`;

    const chapterText = await askDeepSeek(chapterPrompt, null, ch.pages * 80);
    bookMarkdown += `# ${ch.title}\n\n> ${ch.description}\n\n${chapterText}\n\n---\n\n`;
    info(`Chapter ${i + 1} complete`);
  }

  const t0 = Date.now();
  await redis.set('book:markdown', bookMarkdown);
  info('Book saved to Redis', `latency=${Date.now() - t0}ms`);
  return bookMarkdown;
}

/* --------------  Routes  -------------- */
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/generate', async (req, res) => {
  const keywords   = req.query.keywords || 'Artificial Intelligence';
  const totalPages = parseInt(req.query.pages) || 120;
  info('HTTP /generate', `keywords="${keywords}" pages=${totalPages}`);

  try {
    await generateBook(keywords, totalPages);
    info('Book generation finished');
    res.json({ ok: true });
  } catch (err) {
    error('Book generation failed', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/download', async (_req, res) => {
  info('HTTP /download');
  const markdown = await redis.get('book:markdown');
  if (!markdown) {
    warn('Download requested but book not found');
    return res.status(404).send('Book not found. Generate it first.');
  }
  res.set('Content-Type', 'text/markdown');
  res.set('Content-Disposition', 'attachment; filename="book.md"');
  res.send(markdown);
  info('Book downloaded');
});

/* --------------  Boot  -------------- */
(async () => {
  await redis.connect();
  app.listen(PORT, () => info(`Server listening`, `http://localhost:${PORT}`));
})();
