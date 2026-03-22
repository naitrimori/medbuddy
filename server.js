const express = require("express");
const cors    = require("cors");
const multer  = require("multer");
const fetch   = require("node-fetch");
const path    = require("path");
const fs      = require("fs");
const XLSX    = require("xlsx");

const app     = express();
const PORT    = process.env.PORT || 3000;
const OR_KEY  = process.env.OPENROUTER_API_KEY;

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

function loadDB() {
  const dbPath = fs.existsSync(path.join(__dirname, "data", "MedBuddy_Database.xlsx"))
    ? path.join(__dirname, "data", "MedBuddy_Database.xlsx")
    : path.join(__dirname, "MedBuddy_Database.xlsx");
  if (!fs.existsSync(dbPath)) return {};
  const wb = XLSX.readFile(dbPath);
  const get = (keyword) => wb.SheetNames.find(n => n.includes(keyword));
  const toRows = (name) => name ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" }) : [];
  return {
    medicines:   toRows(get("Medicines")).filter(r => r["Generic Name"]),
    sideEffects: toRows(get("Side Effects")).filter(r => r["Drug Category"]),
    conditions:  toRows(get("Conditions")).filter(r => r["Medical Term"]),
    glossary:    toRows(get("Medical Terms")).filter(r => r["Medical Jargon"]),
    timing:      toRows(get("Dosage")).filter(r => r["Code"]),
    diet:        toRows(get("Diet")).filter(r => r["Condition"]),
    labTests:    toRows(get("Lab")).filter(r => r["Test Name"]),
  };
}

function buildSystemPrompt(db, lang) {
  const meds  = (db.medicines||[]).map(m => `${m["Brand Name (India)"]}|${m["Generic Name"]}|${m["Drug Category"]}|${m["Std Dosage"]}|${m["Std Timing"]}|${m["Duration (typical)"]}`).join("\n");
  const se    = (db.sideEffects||[]).map(s => `${s["Drug Category"]}: ${s["Common Side Effect 1"]}; ${s["Common Side Effect 2"]}; ${s["Common Side Effect 3"]} | EMERGENCY: ${s["Call Doctor Immediately If…"]}`).join("\n");
  const conds = (db.conditions||[]).map(c => `${c["Medical Term"]} = ${lang==="Hindi" ? c["Plain-Language Explanation (Hindi)"] : c["Plain-Language Explanation (English)"]}`).join("\n");
  const gloss = (db.glossary||[]).map(g => `${g["Medical Jargon"]} → ${lang==="Hindi" ? g["Hindi Explanation"] : g["Plain English Explanation"]}`).join("\n");
  const tim   = (db.timing||[]).map(t => `${t["Code"]} = ${t["Plain English"]} (${t["Typical Times"]})`).join("\n");

  return `You are MedBuddy — an AI that simplifies medical documents for Indian patients.
Output language: ${lang}.
CRITICAL RULES:
1. Only use information FROM the document. Never add outside advice.
2. Medication dosages and timing must match the prescription EXACTLY.
3. Do NOT suggest alternative medicines.

=== MEDICINES ===\n${meds}
=== SIDE EFFECTS ===\n${se}
=== CONDITIONS ===\n${conds}
=== GLOSSARY ===\n${gloss}
=== TIMING CODES ===\n${tim}

Respond ONLY with valid JSON:
{"summary":"...","diagnosis":{"condition":"...","explanation":"..."},"medications":[{"name":"...","dosage":"...","timing":"...","duration":"...","instructions":"..."}],"sideEffects":[{"type":"warn","text":"..."},{"type":"danger","text":"..."}],"checklist":["..."],"comparison":[{"jargon":"...","plain":"..."}]}`;
}

let db = {};
try { db = loadDB(); console.log("DB loaded"); } catch(e) { console.warn("DB load failed:", e.message); }

app.get("/api/db-stats", (req, res) => {
  res.json(Object.fromEntries(Object.entries(db).map(([k,v])=>[k, Array.isArray(v)?v.length:0])));
});

app.post("/api/analyze", upload.single("file"), async (req, res) => {
  if (!OR_KEY) return res.status(500).json({ error: "OPENROUTER_API_KEY not set in Render environment variables." });

  const { text, age, language } = req.body;
  const lang = language || "English";
  const userContent = [];

  if (req.file) {
    const mime = req.file.mimetype;
    const b64  = req.file.buffer.toString("base64");
    if (mime === "text/plain") {
      userContent.push({ type: "text", text: "DOCUMENT:\n" + req.file.buffer.toString("utf8") });
    } else {
      userContent.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
    }
  }

  if (text && text.trim()) userContent.push({ type: "text", text: "DOCUMENT:\n" + text.trim() });
  userContent.push({ type: "text", text: `Patient age: ${age||"not provided"}. Language: ${lang}. Return JSON only.` });

  if (userContent.length <= 1) return res.status(400).json({ error: "No document provided" });

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OR_KEY}`,
        "HTTP-Referer": "https://medbuddy.onrender.com",
        "X-Title": "MedBuddy"
      },
      body: JSON.stringify({
        model: "mistralai/mistral-7b-instruct:free",
        messages: [
          { role: "system", content: buildSystemPrompt(db, lang) },
          { role: "user", content: userContent }
        ],
        max_tokens: 2000
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || "OpenRouter error" });

    const raw    = data.choices?.[0]?.message?.content || "";
    const clean  = raw.replace(/```json|```/g, "").trim();
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
  console.log(`🔑 OpenRouter Key: ${OR_KEY ? "✅ Set" : "❌ MISSING"}`);
});
