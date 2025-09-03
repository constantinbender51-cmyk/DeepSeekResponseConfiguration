require('dotenv').config();
const express = require('express');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL     = 'https://api.deepseek.com/v1/chat/completions';

if (!DEEPSEEK_API_KEY) {
  console.error('🚨 Missing DEEPSEEK_API_KEY in environment variables.');
  process.exit(1);
}

const SYSTEM_PROMPT = {
  role: 'system',
  content: 'You are an expert computer-science lecturer. Deliver a single, long-form lecture of approximately 6 000 words on large language models (LLMs). Cover history, architecture (transformers), pre-training, fine-tuning, alignment, evaluation, safety, open-source vs proprietary, current limitations, and future directions. Use clear sections with markdown headings. Do NOT split into multiple messages—return the entire lecture in one response.'
};

/**
 * Calls DeepSeek with exponential-backoff retries.
 * @returns {Promise<string|null>} The lecture text or null on failure.
 */
async function fetchLecture() {
  const maxRetries = 6;
  const baseDelay  = 1_000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data } = await axios.post(
        DEEPSEEK_URL,
        {
          model: 'deepseek-chat',
          messages: [SYSTEM_PROMPT],
          temperature: 0.25,
          max_tokens: 8000 // ~6k words ≈ 8k tokens
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`
          },
          timeout: 60_000
        }
      );
      return data.choices[0]?.message?.content || null;
    } catch (err) {
      console.warn(`Attempt ${attempt} failed:`, err.message);
      if (attempt === maxRetries) return null;
      await new Promise(r => setTimeout(r, baseDelay * 2 ** (attempt - 1)));
    }
  }
}

// Health-check route
app.get('/', (_req, res) => res.send('Service alive. GET /lecture to download the lecture.'));

// Lecture route
app.get('/lecture', async (_req, res) => {
  const lecture = await fetchLecture();
  if (!lecture) {
    return res.status(503).send('Unable to generate lecture from DeepSeek.');
  }
  res.set('Content-Type', 'text/markdown; charset=utf-8');
  res.send(lecture);
});

// Start server
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
