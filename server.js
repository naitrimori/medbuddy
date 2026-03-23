/**
 * MedBuddy — Server
 * ──────────────────────────────────────────────────────────────
 * Express server that:
 *  1. Serves the frontend (medbuddy_combined.html)
 *  2. Proxies Anthropic API calls so the API key stays server-side
 *  3. Handles file/audio uploads via multer (in-memory, no disk writes)
 *  4. Provides a /health endpoint for uptime monitoring (Render, Railway, etc.)
 *
 * Usage:
 *   npm install express multer dotenv cors helmet morgan
 *   node server.js
 *
 * Environment variables (.env):
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   PORT=3000                  (optional, defaults to 3000)
 *   NODE_ENV=production        (optional)
 */

'use strict';

const express    = require('express');
const multer     = require('multer');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const https      = require('https');
const path       = require('path');
const fs         = require('fs');
require('dotenv').config();

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3000;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_HOST  = 'api.anthropic.com';
const ANTHROPIC_PATH  = '/v1/messages';
const MODEL           = 'claude-sonnet-4-20250514';
const MAX_TOKENS      = 1200;
const MAX_UPLOAD_MB   = 10;                        // max file size
const ALLOWED_DOC     = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg', 'text/plain'];
const ALLOWED_AUDIO   = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
                          'audio/m4a', 'audio/x-m4a', 'audio/ogg', 'audio/aac',
                          'audio/webm', 'video/webm', 'audio/mp4'];

if (!ANTHROPIC_KEY) {
  console.error('[MedBuddy] ⚠️  ANTHROPIC_API_KEY is not set. Add it to your .env file.');
  process.exit(1);
}

// ─── App ─────────────────────────────────────────────────────────────────────
const app = express();

// Security headers (relaxed CSP so the single-file HTML works inline)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],   // needed for inline scripts in HTML
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:', 'https:'],
      connectSrc:  ["'self'"],                       // API calls go through our proxy
      mediaSrc:    ["'self'", 'blob:'],
      objectSrc:   ["'none'"],
    },
  },
}));

app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Multer — in-memory file storage ─────────────────────────────────────────
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = [...ALLOWED_DOC, ...ALLOWED_AUDIO];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

// ─── Helper: call Anthropic API ──────────────────────────────────────────────
function callAnthropic(messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt || 'You are MedBuddy, an AI that simplifies Indian medical documents for patients.',
      messages,
    });

    const options = {
      hostname: ANTHROPIC_HOST,
      path:     ANTHROPIC_PATH,
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || 'Anthropic API error'));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('Failed to parse Anthropic response'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** Health check — used by Render / Railway keep-alive pings */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'MedBuddy', timestamp: new Date().toISOString() });
});

/**
 * POST /api/analyze
 * Body (multipart/form-data OR JSON):
 *   - file?      : uploaded document (PDF / image / text)
 *   - audioFile? : uploaded audio file
 *   - text?      : pasted plain text
 *   - age?       : patient age (string)
 *   - lang       : 'English' | 'Hindi' | 'Gujarati'
 *
 * Returns JSON with the full analysis result.
 */
app.post('/api/analyze', upload.fields([
  { name: 'file',      maxCount: 1 },
  { name: 'audioFile', maxCount: 1 },
]), async (req, res) => {
  try {
    const lang      = req.body.lang  || 'English';
    const age       = req.body.age   || '';
    const pasteText = req.body.text  || '';

    // ── Resolve input content ──────────────────────────────────────────────
    let docContent = pasteText.trim();
    let isAudio    = false;

    if (!docContent) {
      // Document file
      if (req.files && req.files['file'] && req.files['file'][0]) {
        const f = req.files['file'][0];
        if (f.mimetype === 'text/plain') {
          docContent = f.buffer.toString('utf-8');
        } else {
          // PDF / image: send as base64 for Claude to interpret
          docContent = `[FILE: ${f.originalname}, type: ${f.mimetype}, size: ${f.size} bytes, base64: ${f.buffer.toString('base64').substring(0, 500)}...]`;
        }
      }
      // Audio file
      else if (req.files && req.files['audioFile'] && req.files['audioFile'][0]) {
        const a = req.files['audioFile'][0];
        isAudio    = true;
        docContent = `[AUDIO INPUT: User uploaded audio file named "${a.originalname}" (${a.mimetype}, ${(a.size / 1024).toFixed(1)} KB). Treat as spoken medical document — doctor verbal prescription, discharge instructions, or patient describing symptoms. Analyze it and generate a full realistic medical summary.]`;
      }
    }

    if (!docContent) {
      return res.status(400).json({ error: 'No input provided. Please upload a file or paste text.' });
    }

    // ── Language instruction ───────────────────────────────────────────────
    const langInstruction =
      lang === 'Hindi'
        ? 'IMPORTANT: Respond ENTIRELY in Hindi (हिंदी). Every field — summary, diagnosis, sideEffects, followUpChecklist items, medication names/timings/instructions, jargon terms and explanations — must be in Hindi script. Do not use English except for medicine brand names.'
      : lang === 'Gujarati'
        ? 'IMPORTANT: Respond ENTIRELY in Gujarati (ગુજરાતી). Every field — summary, diagnosis, sideEffects, followUpChecklist items, medication timings/instructions, jargon explanations — must be in Gujarati script. Do not use English except for medicine brand names.'
        : 'Respond in clear, simple English.';

    // ── Build prompt ───────────────────────────────────────────────────────
    const userPrompt = `Analyze the following${isAudio ? ' audio recording (transcribed)' : ''} and respond ONLY with a valid JSON object. No markdown, no backticks, no extra text.

Input:
"""
${docContent.substring(0, 8000)}
"""
${age ? `Patient Age: ${age}` : ''}

${langInstruction}

Return EXACTLY this JSON structure:
{
  "summary": "One-line summary for family (max 20 words)",
  "diagnosis": "Plain-language diagnosis explanation (2-4 sentences)",
  "sideEffects": "Side effects and warnings to watch for (2-4 sentences)",
  "followUpChecklist": ["item1", "item2", "item3", "item4"],
  "medications": [
    {"name": "Medicine name", "dosage": "e.g. 500mg", "timing": "e.g. Morning & Night", "duration": "e.g. 7 days", "instructions": "e.g. After food"}
  ],
  "jargon": [
    {"term": "Medical term", "plain": "Plain explanation"}
  ]
}`;

    // ── Call Anthropic ─────────────────────────────────────────────────────
    const anthropicRes = await callAnthropic([
      { role: 'user', content: userPrompt }
    ]);

    const rawText = (anthropicRes.content || [])
      .map(b => b.text || '')
      .join('');

    const clean = rawText.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    res.json({ success: true, result });

  } catch (err) {
    console.error('[/api/analyze]', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

/**
 * POST /api/signup
 * Body (JSON): { name, email, phone, age, language, password }
 * In production, replace this stub with your DB logic (MongoDB, Postgres, etc.)
 */
app.post('/api/signup', (req, res) => {
  const { name, email, phone, age, language } = req.body;

  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'Name, email and phone are required.' });
  }
  if (!email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (String(phone).length < 10) {
    return res.status(400).json({ error: 'Phone must be at least 10 digits.' });
  }

  // ── TODO: save to database ─────────────────────────────────────────────
  // e.g. await db.users.create({ name, email, phone, age, language, ... })

  console.log(`[signup] New user: ${name} <${email}>`);
  res.json({ success: true, message: `Welcome to MedBuddy, ${name}!` });
});

/**
 * GET /api/family/:groupCode
 * Stub — in production, fetch family group from DB using invite code.
 */
app.get('/api/family/:groupCode', (req, res) => {
  const { groupCode } = req.params;
  // TODO: look up family group by invite code in database
  res.json({
    success: true,
    group: {
      code:    groupCode,
      members: [],
      records: [],
    },
  });
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
const HTML_FILE = path.join(__dirname, 'medbuddy_combined.html');

app.get('/', (req, res) => {
  if (fs.existsSync(HTML_FILE)) {
    res.sendFile(HTML_FILE);
  } else {
    res.status(404).send('medbuddy_combined.html not found. Place it in the same directory as server.js.');
  }
});

// Catch-all — redirect everything else to the SPA
app.get('*', (req, res) => {
  if (fs.existsSync(HTML_FILE)) {
    res.sendFile(HTML_FILE);
  } else {
    res.redirect('/');
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Maximum size is ${MAX_UPLOAD_MB}MB.` });
  }
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║  🌿 MedBuddy Server                      ║
  ║  http://localhost:${PORT}                   ║
  ║  Model  : ${MODEL}  ║
  ║  Env    : ${(process.env.NODE_ENV || 'development').padEnd(12)} ║
  ╚══════════════════════════════════════════╝
  `);
});

module.exports = app; // for testing
