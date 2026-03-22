const express = require("express");
const cors    = require("cors");
const multer  = require("multer");
const fetch   = require("node-fetch");
const path    = require("path");
const fs      = require("fs");
const XLSX    = require("xlsx");

const app     = express();
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["application/pdf","image/jpeg","image/png","image/jpg","text/plain"];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error("Only PDF, JPG, PNG, TXT allowed"));
  }
});

// ── Load Excel Database ──────────────────────────────────────────
function loadDB() {
  const dbPath = fs.existsSync(path.join(__dirname, "data", "MedBuddy_Database.xlsx"))
    ? path.join(__dirname, "data", "MedBuddy_Database.xlsx")
    : path.join(__dirname, "MedBuddy_Database.xlsx");
  if (!fs.existsSync(dbPath)) return {};
  const wb = XLSX.readFile(dbPath);
  const get = (keyword) => wb.SheetNames.find(n => n.includes(keyword));
  const toRows = (name) => name ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" }) : [];

  const medicines  = toRows(get("Medicines")).filter(r => r["Generic Name"]);
  const sideEffects= toRows(get("Side Effects")).filter(r => r["Drug Category"]);
  const conditions = toRows(get("Conditions")).filter(r => r["Medical Term"]);
  const glossary   = toRows(get("Medical Terms")).filter(r => r["Medical Jargon"]);
  const timing     = toRows(get("Dosage")).filter(r => r["Code"]);
  const diet       = toRows(get("Diet")).filter(r => r["Condition"]);
  const labTests   = toRows(get("Lab")).filter(r => r["Test Name"]);

  return { medicines, sideEffects, conditions, glossary, timing, diet, labTests };
}

function buildSystemPrompt(db, lang) {
  const meds = (db.medicines||[]).map(m =>
    `${m["Brand Name (India)"]}|${m["Generic Name"]}|${m["Drug Category"]}|${m["Std Dosage"]}|${m["Std Timing"]}|${m["Duration (typical)"]}`
  ).join("\n");

  const se = (db.sideEffects||[]).map(s =>
    `${s["Drug Category"]}: ${s["Common Side Effect 1"]}; ${s["Common Side Effect 2"]}; ${s["Common Side Effect 3"]} | EMERGENCY: ${s["Call Doctor Immediately If…"]}`
  ).join("\n");

  const conds = (db.conditions||[]).map(c =>
    `${c["Medical Term"]} = ${lang==="Hindi" ? c["Plain-Language Explanation (Hindi)"] : c["Plain-Language Explanation (English)"]}`
  ).join("\n");

  const gloss = (db.glossary||[]).map(g =>
    `${g["Medical Jargon"]} → ${lang==="Hindi" ? g["Hindi Explanation"] : g["Plain English Explanation"]}`
  ).join("\n");

  const tim = (db.timing||[]).map(t =>
    `${t["Code"]} = ${t["Plain English"]} (${t["Typical Times"]})`
  ).join("\n");

  const dietMap = (db.diet||[]).map(d =>
    `${d["Condition"]}: AVOID: ${d["Foods to AVOID"]} | INCLUDE: ${d["Foods to INCLUDE"]} | ACTIVITY: ${d["Activity Guidelines"]}`
  ).join("\n");

  return `You are MedBuddy — an AI that simplifies medical documents for Indian patients.
Output language: ${lang}.

CRITICAL RULES:
1. Only use information FROM the uploaded document. Never add outside advice.
2. Medication dosages and timing must match the prescription EXACTLY.
3. Do NOT suggest alternative medicines or add anything not in the document.

DATABASE KNOWLEDGE — use this to enrich and decode the prescription:

=== MEDICINES (Brand|Generic|Category|Dosage|Timing|Duration) ===
${meds}

=== SIDE EFFECTS BY DRUG CATEGORY ===
${se}

=== CONDITIONS ===
${conds}

=== MEDICAL JARGON GLOSSARY ===
${gloss}

=== DOSAGE TIMING CODES ===
${tim}

=== DIET & ACTIVITY ===
${dietMap}

Respond ONLY with valid JSON:
{
  "summary": "One sentence a family member can understand",
  "diagnosis": {
    "condition": "Condition name in plain language",
    "explanation": "2-3 sentence plain explanation"
  },
  "medications": [
    { "name": "exact name from prescription", "dosage": "e.g. 500mg", "timing": "decoded e.g. Morning and Night", "duration": "e.g. 7 days", "instructions": "e.g. After food" }
  ],
  "sideEffects": [
    { "type": "warn", "text": "side effect to watch" },
    { "type": "danger", "text": "when to call doctor immediately" }
  ],
  "checklist": ["item 1", "item 2", "item 3"],
  "comparison": [
    { "jargon": "medical term", "plain": "plain explanation" }
  ]
}`;
}

let db = {};
try { db = loadDB(); console.log("✅ DB loaded:", Object.fromEntries(Object.entries(db).map(([k,v])=>[k,v.length]))); }
catch(e) { console.warn("DB load failed:", e.message); }

// ── Routes ───────────────────────────────────────────────────────
app.get("/api/db-stats", (req, res) => {
  res.json(Object.fromEntries(Object.entries(db).map(([k,v])=>[k, Array.isArray(v)?v.length:0])));
});

app.post("/api/reload-db", (req, res) => {
  try { db = loadDB(); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/analyze", upload.single("file"), async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set. Add it in Railway Variables tab." });

  const { text, age, language } = req.body;
  const lang = language || "English";
  const userContent = [];

  if (req.file) {
    const mime = req.file.mimetype;
    const b64  = req.file.buffer.toString("base64");
    if (mime === "application/pdf") {
      userContent.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } });
    } else if (mime === "text/plain") {
      userContent.push({ type: "text", text: "DOCUMENT:\n" + req.file.buffer.toString("utf8") });
    } else {
      userContent.push({ type: "image", source: { type: "base64", media_type: mime, data: b64 } });
    }
  }

  if (text && text.trim()) userContent.push({ type: "text", text: "DOCUMENT:\n" + text.trim() });
  if (!userContent.length) return res.status(400).json({ error: "No document or text provided" });

  userContent.push({ type: "text", text: `Patient age: ${age||"not provided"}. Language: ${lang}. Analyze and return JSON only.` });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system: buildSystemPrompt(db, lang),
        messages: [{ role: "user", content: userContent }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || "API error" });

    const raw    = (data.content||[]).map(c=>c.text||"").join("");
    const clean  = raw.replace(/```json|```/g,"").trim();
    const result = JSON.parse(clean);
    res.json({ success: true, result });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`\n🏥 MedBuddy running on port ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY ? "✅ Set" : "❌ MISSING — add ANTHROPIC_API_KEY in Railway Variables"}`);
});
