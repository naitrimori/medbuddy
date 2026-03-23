# 🏥 MedBuddy — AI Medical Document Simplifier

> Upload a prescription or discharge summary and instantly get a plain-language explanation, medication schedule, side effect alerts, and follow-up checklist.

---

## 🌐 Live Demo
👉 https://medbuddy.onrender.com

---

## 💡 What is MedBuddy?

In India, doctor consultations average under 2 minutes. Patients leave hospitals with zero clarity about their diagnosis or medicines. MedBuddy solves this by letting patients upload their prescription and instantly understanding it in simple language — in Hindi or English.

---

## ✨ Features

- 📄 Upload PDF, JPG, PNG, or paste text directly
- 🏥 Plain-language diagnosis explanation
- 💊 Medication schedule table (name, dosage, timing, duration)
- ⚠️ Side effect alerts with emergency warnings
- ✅ Follow-up checklist (tests, diet, activity)
- 🔄 Medical jargon vs plain language comparison
- 📤 One-line summary to share with family
- 🇮🇳 Hindi and English support

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, Vanilla JavaScript |
| Backend | Node.js + Express.js |
| Database | Excel (.xlsx) parsed with xlsx library |
| AI | OpenRouter API (Llama model) |
| File Upload | Multer |
| Deployment | Render.com |

---

## 📁 Project Structure

```
medbuddy/
├── server.js              ← Backend (Node.js + Express)
├── package.json           ← Dependencies
├── public/
│   └── index.html         ← Frontend (UI)
└── data/
    └── MedBuddy_Database.xlsx  ← Medical database
```

---

## 🗄️ Database

Custom Excel database with 7 sheets:

| Sheet | Contents |
|---|---|
| 💊 Medicines | 56 common Indian medicines |
| ⚠️ Side Effects | Side effects by drug category |
| 🏥 Conditions | 25 diagnoses with plain-language explanations |
| 📋 Medical Terms | 50 jargon terms → plain English + Hindi |
| 📅 Dosage Timing | 20 timing codes (OD, BD, TDS...) |
| 🥗 Diet & Activity | Diet rules per condition |
| 🔬 Lab Tests | 25 common tests explained |

---

## ⚙️ How It Works

```
User uploads prescription
        ↓
Frontend sends file to backend
        ↓
Backend loads Excel medical database
        ↓
Backend calls OpenRouter AI with database context
        ↓
AI returns structured JSON
        ↓
Frontend displays results beautifully
```


