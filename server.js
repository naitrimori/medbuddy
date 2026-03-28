/**
 * MedBuddy — Server (OpenRouter Edition)
 * ──────────────────────────────────────────────────────────────
 * Environment variables (set in Render dashboard):
 *   OPENROUTER_API_KEY=sk-or-v1-...   ← get free key at openrouter.ai/keys
 *   PORT=3000  (Render sets this automatically)
 */

'use strict';

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const https    = require('https');
const path     = require('path');
const fs       = require('fs');
require('dotenv').config();

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3000;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL          = 'meta-llama/llama-3.3-70b-instruct:free';
const MAX_TOKENS     = 1500;
const MAX_UPLOAD_MB  = 10;
const ALLOWED_DOC    = ['application/pdf','image/jpeg','image/png','image/jpg','text/plain'];
const ALLOWED_AUDIO  = ['audio/mpeg','audio/mp3','audio/wav','audio/x-wav',
                        'audio/m4a','audio/x-m4a','audio/ogg','audio/aac',
                        'audio/webm','video/webm','audio/mp4'];

if (!OPENROUTER_KEY) {
  console.error('[MedBuddy] ⚠️  OPENROUTER_API_KEY is not set.');
  console.error('[MedBuddy]    Get a free key at https://openrouter.ai/keys');
  console.error('[MedBuddy]    Add it in Render → Environment → OPENROUTER_API_KEY');
  process.exit(1);
}

// ─── App ─────────────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      mediaSrc:   ["'self'", 'blob:'],
      objectSrc:  ["'none'"],
    },
  },
}));

app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Multer ───────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = [...ALLOWED_DOC, ...ALLOWED_AUDIO];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

// ─── Helper: call OpenRouter ──────────────────────────────────────────────────
function callOpenRouter(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:       MODEL,
      max_tokens:  MAX_TOKENS,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    });

    const options = {
      hostname: 'openrouter.ai',
      path:     '/api/v1/chat/completions',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer':   'https://medbuddy-tdqv.onrender.com',
        'X-Title':        'MedBuddy',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message || 'OpenRouter API error'));
          else resolve(parsed);
        } catch (e) {
          reject(new Error('Failed to parse OpenRouter response'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'MedBuddy', model: MODEL, timestamp: new Date().toISOString() });
});

app.post('/api/analyze', upload.fields([
  { name: 'file',      maxCount: 1 },
  { name: 'audioFile', maxCount: 1 },
]), async (req, res) => {
  try {
    const lang      = req.body.lang || 'English';
    const age       = req.body.age  || '';
    const pasteText = req.body.text || '';

    let docContent = pasteText.trim();
    let isAudio    = false;

    if (!docContent) {
      if (req.files?.['file']?.[0]) {
        const f = req.files['file'][0];
        docContent = f.mimetype === 'text/plain'
          ? f.buffer.toString('utf-8')
          : `[FILE: ${f.originalname}, type: ${f.mimetype}, size: ${f.size} bytes. Analyze all medical information in this document.]`;
      } else if (req.files?.['audioFile']?.[0]) {
        const a = req.files['audioFile'][0];
        isAudio    = true;
        docContent = `[AUDIO: "${a.originalname}" (${a.mimetype}, ${(a.size/1024).toFixed(1)}KB). Spoken medical document — generate a full medical summary as if transcribed.]`;
      }
    }

    if (!docContent) {
      return res.status(400).json({ error: 'No input provided. Please upload a file or paste text.' });
    }

    const langInstruction =
      lang === 'Hindi'
        ? 'IMPORTANT: Respond ENTIRELY in Hindi (हिंदी). Every field must be in Hindi script. Only medicine brand names may stay in English.'
      : lang === 'Gujarati'
        ? 'IMPORTANT: Respond ENTIRELY in Gujarati (ગુજરાતી). Every field must be in Gujarati script. Only medicine brand names may stay in English.'
        : 'Respond in clear, simple English suitable for patients with no medical background.';

    const systemPrompt =
      `You are MedBuddy, an AI that simplifies Indian medical documents for patients and families. ` +
      `You MUST respond with ONLY a valid JSON object — no markdown, no backticks, no explanation. ` +
      langInstruction;

    const userPrompt =
      `Analyze this${isAudio ? ' audio recording' : ' medical document'} and return the JSON:\n\n` +
      `"""\n${docContent.substring(0, 8000)}\n"""` +
      `${age ? `\n\nPatient Age: ${age}` : ''}\n\n` +
      `Return EXACTLY this JSON structure:\n` +
      `{\n` +
      `  "summary": "One-line summary for family (max 20 words)",\n` +
      `  "diagnosis": "Plain-language diagnosis (2-4 sentences)",\n` +
      `  "sideEffects": "Side effects and warnings to watch for (2-4 sentences)",\n` +
      `  "followUpChecklist": ["item1", "item2", "item3", "item4"],\n` +
      `  "medications": [\n` +
      `    {"name": "Medicine name", "dosage": "e.g. 500mg", "timing": "e.g. Morning & Night", "duration": "e.g. 7 days", "instructions": "e.g. After food"}\n` +
      `  ],\n` +
      `  "jargon": [\n` +
      `    {"term": "Medical term", "plain": "Plain explanation"}\n` +
      `  ]\n` +
      `}`;

    const orRes   = await callOpenRouter(systemPrompt, userPrompt);
    const rawText = orRes.choices?.[0]?.message?.content || '';
    const clean   = rawText.replace(/```json|```/gi, '').trim();
    const result  = JSON.parse(clean);

    res.json({ success: true, result });

  } catch (err) {
    console.error('[/api/analyze] Error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

app.post('/api/signup', (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !email || !phone) return res.status(400).json({ error: 'Name, email and phone are required.' });
  if (!email.includes('@')) return res.status(400).json({ error: 'Invalid email address.' });
  if (String(phone).length < 10) return res.status(400).json({ error: 'Phone must be at least 10 digits.' });
  console.log(`[signup] New user: ${name} <${email}>`);
  res.json({ success: true, message: `Welcome to MedBuddy, ${name}!` });
});

app.get('/api/family/:groupCode', (req, res) => {
  res.json({ success: true, group: { code: req.params.groupCode, members: [], records: [] } });
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
// FIXED: was 'medbuddy_combined.html' (didn't exist) → now 'public/index.html'
const HTML_FILE = path.join(__dirname, 'public', 'index.html');

app.get('/', (req, res) => {
  fs.existsSync(HTML_FILE)
    ? res.sendFile(HTML_FILE)
    : res.status(404).send('Frontend not found. Make sure public/index.html exists.');
});

app.get('*', (req, res) => {
  fs.existsSync(HTML_FILE) ? res.sendFile(HTML_FILE) : res.redirect('/');
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Max ${MAX_UPLOAD_MB}MB.` });
  }
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║  🌿 MedBuddy Server (OpenRouter)         ║
  ║  http://localhost:${PORT}                   ║
  ║  Model: ${MODEL.padEnd(32)}║
  ╚══════════════════════════════════════════╝
  `);
});

module.exports = app;
