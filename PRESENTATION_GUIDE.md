# PSAU QMS Feedback System — Presentation Guide
### How I Developed This System, Step by Step
*(Speaker script + slide outline + demo flow + Q&A prep)*

---

## 30-Second Elevator Pitch (memorize this)

> "I developed a web-based Quality Management System for Pampanga State Agricultural
> University. Clients scan a QR code and fill out the Citizen's Charter feedback form
> online — in English, Tagalog, or Kapampangan. The system automatically classifies the
> sentiment of every comment using a hybrid AI engine I built: a Naïve Bayes model I
> trained myself, backed by Google Gemini for hard cases. Administrators then get a
> real-time dashboard, office rankings, AI-generated improvement suggestions, and
> one-click printable quarterly reports with DOCX export. The whole thing is deployed
> on Render with Firebase as the database, and it even works offline."

---

## SLIDE 1 — Title
**On slide:** PSAU Quality Management System — Digital Client Feedback & Sentiment Analysis Platform
**Say:**
> "Good day. My project is the PSAU Quality Management System — a platform that
> digitizes how the university collects, analyzes, and acts on client feedback."

---

## SLIDE 2 — The Problem
**On slide:** 3 bullets — Manual paper collection · Slow manual analysis · No Kapampangan/Tagalog sentiment tools
**Say:**
> "PSAU is required by the ARTA Citizen's Charter to measure client satisfaction using
> the CC1 form with SQD rating dimensions. Before my system, this was done on paper:
> forms were collected manually, tallies were computed by hand, reports took days,
> and the written comments — often written in Tagalog or Kapampangan — were never
> analyzed at scale. No existing sentiment tool understands Kapampangan."

**Talking point:** Lead with the *language* problem — it's your differentiator and it
justifies why you built your own ML model instead of using an existing API.

---

## SLIDE 3 — Proposed Solution & Objectives
**On slide:** One diagram: QR → Feedback Form → Hybrid AI Engine → Dashboard → Reports → Office Improvement
**Say:**
> "My solution closes the full quality loop: collect digitally, classify automatically,
> visualize instantly, report quarterly, and recommend improvements with AI.
> The objectives map directly to our paper: centralized Firestore storage (TIMO 8.8),
> automated analysis, and a sustainability plan with data backups."

---

## SLIDE 4 — Technology Stack (and WHY)
**On slide:** Node.js + Express · EJS · Firebase (Firestore + Auth) · Gemini API · Render · Git/GitHub
**Say:**
> "I chose server-rendered Node.js with Express and EJS for simplicity and speed of
> development. Firebase gives me managed authentication and a centralized cloud
> database on a free tier — important for a university project. Crucially, I access
> Firestore only through the Firebase **Admin SDK** on the server, and I locked the
> Firestore security rules to `read/write: false` — meaning no client can ever touch
> the database directly. Every request must pass through my server's validation,
> CSRF protection, and rate limiting. And I deployed on Render using a Blueprint file
> so the infrastructure is version-controlled in Git."

**Talking point:** The "why" for each choice: free-tier friendly, no server maintenance,
security by architecture (deny-all rules), reproducible deployment.


---

## SLIDE 6 — Phase 2: The Machine Learning Core (your highlight — slow down here)
**On slide:** Naïve Bayes diagram + 4 classes + "Trilingual corpus" + metrics table
**Say:**
> "The heart of the system is a **Multinomial Naïve Bayes sentiment classifier that I
> implemented from scratch** — no pre-trained library. I trained it on a seed corpus I
> built myself in **three languages: English, Tagalog, and Kapampangan**, covering the
> phrases clients actually use — like 'mabilis ang serbisyo' or 'mayap ing opisina
> pero malwat ing pila'.
>
> It classifies comments into four sentiments — Positive, Negative, Neutral, and
> Mixed — where 'Mixed' matters because a client can praise the staff but complain
> about the line in the same sentence.
>
> Three design decisions I'm proud of:
> 1. **Model versioning** — the trained model state is persisted in Firestore with a
>    version number (currently v5); older, stale versions are automatically discarded
>    so poisoned legacy data can never override the current corpus.
> 2. **Online incremental learning** — the model keeps learning from real submissions,
>    so accuracy improves over time.
> 3. **Built-in self-validation** — I wrote a validation module that tests the model
>    against a held-out set and computes **Accuracy, Precision, Recall, F1-score, and
>    a full Confusion Matrix per category**. So I can *prove* the model works with
>    numbers, not claims."

**Talking point:** Have your actual accuracy/F1 numbers ready to state out loud —
panels respect measured results more than architecture diagrams.

---

## SLIDE 7 — Phase 3: The Hybrid Dual-Engine AI
**On slide:** Flow: Comment → Naïve Bayes → (confident? yes → done / no → Gemini → fallback NB)
**Say:**
> "Pure machine learning fails on words it has never seen. So instead of choosing
> between 'my model' and 'a big AI', I designed a **hybrid pipeline**:
>
> 1. Every comment first goes through my local Naïve Bayes engine — free and instant.
> 2. I measure two things: the model's **confidence** (must be ≥ 0.65) and its
>    **vocabulary coverage** — how many of the comment's words it was actually
>    trained on (must be ≥ 0.55). If both pass, the verdict is final. No API call,
>    no cost.
> 3. If the model is unsure, the comment **escalates to Google Gemini**, which truly
>    understands the three languages. I sanitize the input first to block prompt
>    injection, with a 7-second timeout.
> 4. If Gemini is down or the API key is missing, the Naïve Bayes verdict is used —
>    so **classification never blocks a submission**.
>
> This gives me the cost profile of a local model with the language power of a large
> AI model, and graceful degradation when either one fails."

**Talking point:** This is your best systems-design story — say the thresholds out
loud; specific numbers signal you actually engineered it, not generated it.

---

## SLIDE 8 — Phase 4: Security & Hardening
**On slide:** Checklist: RBAC · CSRF · Rate limiting · Sanitization · Audit trail · Deny-all Firestore rules
**Say:**
> "Because this stores citizen data, security was a phase of its own, not an
> afterthought. I implemented: role-based access control with the role decided
> **server-side only**; CSRF protection on every state-changing route; rate limiting
> on login and submissions; strict email validation that even blocks typo domains
> like 'gmai.com' using a Levenshtein distance check; full HTML sanitization; a
> password policy; an **audit trail** persisted to Firestore; and deny-all Firestore
> rules so the database is only reachable through my server. I also fail **closed**
> in production — if Firestore reports a security error, the app refuses to fall
> back to any unsafe state."

---

## SLIDE 9 — Phase 5: The Administrator Side
**On slide:** Dashboard screenshots: sentiment gauge · office rankings · SQD analysis · quarterly report · AI suggestions
**Say:**
> "For administrators and staff, I built session-based authentication with two roles,
> full staff account management through Firebase Authentication, and the analytics
> layer: a real-time dashboard, **office rankings** that flag low performers below a
> 4.0 threshold plus a Top 3, and **SQD dimension analysis** that automatically
> identifies each office's weakest and strongest dimension.
>
> Reports are fully automated: the system buckets all feedback into calendar
> quarters Q1–Q4, computes true-mean satisfaction scores, and generates a printable
> report — PSAU-QMS-SF-20 — with saved signatories and **one-click DOCX export**.
> There's also an AI Suggestions panel that turns the data into concrete improvement
> strategies per SQD dimension, and an **OTP-protected backup vault** that exports
> the entire database as a ZIP for the sustainability plan."
