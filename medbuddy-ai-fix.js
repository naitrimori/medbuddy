/**
 * MedBuddy — AI Analysis Fix (OpenRouter Edition)
 *
 * DROP THIS FILE into your project and include it AFTER your main script.
 * It replaces the static/hardcoded analyzeDocument() with a real AI call via OpenRouter.
 *
 * SETUP (one-time):
 *   1. Get your FREE OpenRouter API key from https://openrouter.ai/keys
 *   2. Replace "YOUR_OPENROUTER_API_KEY_HERE" below with your actual key.
 *   3. Add this line at the bottom of index.html just before </body>:
 *        <script src="medbuddy-ai-fix.js"></script>
 *
 * FREE models you can use (change MODEL below):
 *   "meta-llama/llama-3.3-70b-instruct:free"   ← Best free option (recommended)
 *   "mistralai/mistral-7b-instruct:free"
 *   "google/gemma-3-27b-it:free"
 *   "deepseek/deepseek-chat:free"
 */

const OPENROUTER_API_KEY = "YOUR_OPENROUTER_API_KEY_HERE"; // 🔑 Replace this!
const MODEL = "meta-llama/llama-3.3-70b-instruct:free";    // 🤖 Change model here if you want

// ─────────────────────────────────────────────
// Core: call OpenRouter API with the document text
// ─────────────────────────────────────────────
async function analyzeMedicalTextWithAI(documentText, patientAge, outputLanguage) {
  const langInstructions = {
    english:  "Respond entirely in English.",
    hindi:    "Respond entirely in Hindi (हिंदी). Use Devanagari script.",
    gujarati: "Respond entirely in Gujarati (ગુજરાતી). Use Gujarati script.",
  };

  const langNote = langInstructions[outputLanguage] || langInstructions.english;
  const ageNote  = patientAge ? `The patient is ${patientAge} years old.` : "";

  const systemPrompt = `You are MedBuddy, an AI that simplifies Indian medical documents for patients and families.
${langNote} ${ageNote}

You MUST respond with ONLY valid JSON — no markdown, no explanation, no extra text, no code fences.
The JSON must follow this exact structure:
{
  "summary": "One plain-language sentence summarising the document",
  "diagnosis": "What the patient has, in simple words (2-4 sentences)",
  "sideEffects": "Key warnings or side effects to watch for (2-4 sentences)",
  "followUp": ["Checklist item 1", "Checklist item 2", "Checklist item 3"],
  "medications": [
    {
      "name": "Medicine name",
      "dosage": "e.g. 500mg",
      "timing": "e.g. After meals",
      "duration": "e.g. 7 days",
      "instructions": "Any special instructions"
    }
  ],
  "jargonSimplified": [
    { "medical": "Medical term", "plain": "Plain language meaning" }
  ]
}
If any section is not applicable, use an empty string "" or empty array [].`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer":  window.location.origin,
      "X-Title":       "MedBuddy",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: `Analyze this medical document and return the JSON response:\n\n${documentText}` },
      ],
      max_tokens: 1500,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenRouter API error ${response.status}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";

  // Strip any accidental markdown fences
  const cleaned = rawText.replace(/```json|```/gi, "").trim();
  return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────
// Helper: extract text from uploaded files
// ─────────────────────────────────────────────
async function extractTextFromFile(file) {
  return new Promise((resolve, reject) => {
    if (file.type === "text/plain") {
      const reader = new FileReader();
      reader.onload  = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error("Could not read text file"));
      reader.readAsText(file);
    } else {
      resolve(
        `[File uploaded: ${file.name} (${file.type || "unknown type"})]\n` +
        `Please paste the medical document text in the text box for best results.`
      );
    }
  });
}

// ─────────────────────────────────────────────
// Helper: render results into existing DOM
// ─────────────────────────────────────────────
function renderResults(result) {
  const summaryEl = document.querySelector(".one-line-summary, [data-summary], .summary-text");
  if (summaryEl) summaryEl.textContent = result.summary || "—";

  document.querySelectorAll(".diagnosis-text, [data-diagnosis]")
    .forEach((el) => (el.textContent = result.diagnosis || "—"));

  document.querySelectorAll(".side-effects-text, [data-side-effects]")
    .forEach((el) => (el.textContent = result.sideEffects || "—"));

  const checklistEl = document.querySelector(".followup-list, [data-checklist], .checklist");
  if (checklistEl && result.followUp?.length) {
    checklistEl.innerHTML = result.followUp
      .map((item) =>
        `<li style="display:flex;align-items:center;gap:8px;margin:6px 0;">
          <input type="checkbox" style="width:16px;height:16px;cursor:pointer;">
          <span>${item}</span>
        </li>`
      ).join("");
  }

  const medTable = document.querySelector(".med-table tbody, table tbody, [data-medications]");
  if (medTable && result.medications?.length) {
    medTable.innerHTML = result.medications
      .map((med) =>
        `<tr>
          <td>${med.name         || "—"}</td>
          <td>${med.dosage       || "—"}</td>
          <td>${med.timing       || "—"}</td>
          <td>${med.duration     || "—"}</td>
          <td>${med.instructions || "—"}</td>
        </tr>`
      ).join("");
  }

  const jargonEl = document.querySelector(".jargon-table, [data-jargon], .jargon-list");
  if (jargonEl && result.jargonSimplified?.length) {
    jargonEl.innerHTML = result.jargonSimplified
      .map((j) =>
        `<div style="display:flex;gap:16px;padding:10px;border-bottom:1px solid rgba(0,0,0,.08);">
          <div style="flex:1;font-weight:600;color:#c0392b;">${j.medical}</div>
          <div style="flex:1;color:#27ae60;">→ ${j.plain}</div>
        </div>`
      ).join("");
  }
}

// ─────────────────────────────────────────────
// Show / hide error banner
// ─────────────────────────────────────────────
function showError(message) {
  const errEl = document.querySelector(".error-banner, [data-error], .alert-error");
  if (errEl) {
    errEl.textContent = `⚠️ ${message}`;
    errEl.style.display = "block";
  } else {
    alert(`MedBuddy Error: ${message}`);
  }
}

function hideError() {
  const errEl = document.querySelector(".error-banner, [data-error], .alert-error");
  if (errEl) errEl.style.display = "none";
}

// ─────────────────────────────────────────────
// MAIN: runs when Analyze button is clicked
// ─────────────────────────────────────────────
async function runMedBuddyAnalysis() {
  hideError();

  if (OPENROUTER_API_KEY === "YOUR_OPENROUTER_API_KEY_HERE") {
    showError("API key not set. Open medbuddy-ai-fix.js and replace YOUR_OPENROUTER_API_KEY_HERE with your key from openrouter.ai/keys");
    return;
  }

  const langEl = document.querySelector(
    "input[name='language']:checked, .lang-btn.active, [data-lang].selected, select[id*='lang']"
  );
  const outputLanguage = (langEl?.dataset?.lang || langEl?.value || "english").toLowerCase();

  const ageEl = document.querySelector("input[type='number'], input[placeholder*='age' i], #age");
  const patientAge = ageEl?.value?.trim() || "";

  const textareaEl = document.querySelector("textarea, [data-input], .doc-textarea");
  let documentText = textareaEl?.value?.trim() || "";

  if (!documentText) {
    const fileInput = document.querySelector("input[type='file']");
    const file = fileInput?.files?.[0];
    if (file) {
      try { documentText = await extractTextFromFile(file); }
      catch (e) {
        showError("Could not read the uploaded file. Please paste the document text instead.");
        return;
      }
    }
  }

  if (!documentText) {
    showError("Please upload a document or paste the medical text first.");
    return;
  }

  // Loading state
  const analyzeBtn = document.querySelector(
    "button[data-analyze], .analyze-btn, button.primary, #analyzeBtn"
  );
  const originalLabel = analyzeBtn?.innerHTML;
  if (analyzeBtn) { analyzeBtn.disabled = true; analyzeBtn.innerHTML = "⏳ Analyzing…"; }

  const loadingEl = document.querySelector(".loading, .analyzing-overlay, [data-loading]");
  if (loadingEl) loadingEl.style.display = "block";

  try {
    const result = await analyzeMedicalTextWithAI(documentText, patientAge, outputLanguage);
    renderResults(result);

    const resultsEl = document.querySelector(".results, .output-section, [data-results]");
    if (resultsEl) {
      resultsEl.style.display = "block";
      resultsEl.scrollIntoView({ behavior: "smooth" });
    }
  } catch (err) {
    console.error("MedBuddy AI error:", err);
    showError(
      err.message.includes("JSON")
        ? "AI returned an unexpected response. Try again or switch to a different model in medbuddy-ai-fix.js."
        : `Analysis failed: ${err.message}`
    );
  } finally {
    if (analyzeBtn) { analyzeBtn.disabled = false; analyzeBtn.innerHTML = originalLabel || "🔬 Analyze Medical Document"; }
    if (loadingEl) loadingEl.style.display = "none";
  }
}

// ─────────────────────────────────────────────
// Hook up to existing button on page load
// ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const analyzeBtn = document.querySelector(
    "button[data-analyze], .analyze-btn, #analyzeBtn, button.primary"
  );

  if (analyzeBtn) {
    const freshBtn = analyzeBtn.cloneNode(true);
    analyzeBtn.parentNode.replaceChild(freshBtn, analyzeBtn);
    freshBtn.addEventListener("click", runMedBuddyAnalysis);
    console.log("✅ MedBuddy AI fix loaded — OpenRouter connected!");
  } else {
    console.warn("⚠️ MedBuddy: Could not find analyze button. Add data-analyze to your button or update the selector in medbuddy-ai-fix.js.");
  }
});
