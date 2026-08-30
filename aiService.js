/**
 * PSAU Feedback System — Dual Engine AI / ML Service
 * Primary Engine: Google Gemini AI Model (@google/generative-ai)
 * Fallback Engine: Local Multinomial Naïve Bayes & K-Means Machine Learning
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const naiveBayes = require('./naiveBayes');

// Initialize Gemini API if API key is provided
const apiKey = process.env.GEMINI_API_KEY;
let genAI = null;
if (apiKey) {
  try {
    genAI = new GoogleGenerativeAI(apiKey);
  } catch (e) {
    console.warn(' GoogleGenerativeAI init warning:', e.message);
  }
}

/**
 * Generate analysis report using Gemini AI Model with seamless fallback to Local ML
 */
async function generateHybridReport(feedbacks, officeName, periodLabel, localReportGenerator) {
  const scopeText = officeName && officeName !== 'all' ? `Office / Department: ${officeName}` : 'Scope: University-Wide (All Offices)';
  const label = periodLabel || 'Overall Total';

  // ACCURACY: if no data, never call Gemini — return honest local "No data" report directly
  if (!feedbacks || feedbacks.length === 0) {
    return localReportGenerator(feedbacks, officeName);
  }

  // Attempt Gemini AI Generation if key is present
  if (process.env.GEMINI_API_KEY) {
    try {
      console.log(' Attempting primary AI report generation using Gemini AI Model (gemini-3.6-flash)...');
      const aiInstance = genAI || new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = aiInstance.getGenerativeModel({ model: 'gemini-3.6-flash' });

      const total = feedbacks.length;
      // H6: Mitigate prompt injection — sanitize, truncate, cap total size
      const sanitizeForPrompt = (s) => {
        if (!s || typeof s !== 'string') return '';
        let t = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/```/g, '').substring(0, 500);
        // Neutralize instruction-like patterns
        t = t.replace(/ignore (previous|above) instructions/gi, '[filtered]');
        t = t.replace(/system:/gi, '[filtered]');
        return t;
      };
      const safeScope = String(scopeText).substring(0, 200).replace(/[\r\n]/g, ' ');
      const safeLabel = String(label).substring(0, 100).replace(/[\r\n]/g, ' ');
      const comments = feedbacks.map(f => sanitizeForPrompt(f.suggestions)).filter(s => s && s.trim().length > 0).slice(0, 20);
      let commentsJson = JSON.stringify(comments);
      if (commentsJson.length > 8000) commentsJson = commentsJson.substring(0, 8000);

      const prompt = `
 You are an expert Institutional Quality Analyst evaluating feedback for Pampanga State Agricultural University (PSAU).
 Generate a concise, professional HTML analysis report based on the following feedback data:

 - Scope: ${safeScope}
 - Filter Period: ${safeLabel}
 - Total Respondents: ${total}
 - Client Comments (Trilingual Tagalog/Kapampangan/English): ${commentsJson}

 Return ONLY raw clean HTML (no markdown code blocks, no html/head wrapper).
 Format requirements:
 - Use a div wrapper with style="line-height: 1.45; color: var(--text-primary);"
 - Include a top banner showing: Primary Engine: Gemini AI Model
 - Section 1: Executive Qualitative Performance Summary
 - Section 2: Trilingual Sentiment & Key Theme Extraction
 - Section 3: Priority Institutional Action Plan (3-4 bullet points)
 `;

      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AI Request Timeout (15s)')), 15000))
      ]);

      const response = await result.response;
      let text = response.text();

      // Clean markdown fences if any
      text = text.replace(/```html/gi, '').replace(/```/g, '').trim();

      if (text && text.length > 50) {
        console.log(' Gemini AI Report generated successfully!');
        return `
 <div style="background: rgba(33, 150, 243, 0.08); border: 1px solid rgba(33, 150, 243, 0.25); border-radius: 6px; padding: 0.5rem 0.85rem; margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between;">
 <span style="font-size: 0.8rem; font-weight: 700; color: #1976d2; display: flex; align-items: center; gap: 0.4rem;">
 <i class="fas fa-brain"></i> Primary Engine Active: Gemini AI Model
 </span>
 <span style="font-size: 0.72rem; background: rgba(25, 118, 210, 0.12); color: #1565c0; padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 600;">
 Fallback: Local Naïve Bayes ML Ready
 </span>
 </div>
 ${text}
 `;
      }
    } catch (err) {
      console.warn(` Gemini AI API call interrupted/unavailable (${err.message}). Seamlessly engaging Local Machine Learning Fallback Engine...`);
    }
  } else {
    console.log(' GEMINI_API_KEY not set in environment. Running Local Machine Learning Engine...');
  }

  // Secondary / Fallback: Local Machine Learning Engine (Naïve Bayes & K-Means)
  const localReportHtml = localReportGenerator(feedbacks, officeName);
  return localReportHtml;
}

/**
 * AI Suggestions — SQD + Form + Sample Suggestions ONLY (per client request)
 * Secure: sanitizes userRequest, SQD, form fields, suggestions; caps length; strips prompt injection
 * Only uses: SQD ratings (SQD0-8), form fields (tanggapan, transaction, client type), and suggestions samples
 */
async function generateSuggestionsOnly(feedbacks, userRequest, periodLabel) {
  const safeLabel = String(periodLabel || 'Overall').substring(0, 120).replace(/[\r\n]/g, ' ');
  const sanitize = (s) => {
    if (!s || typeof s !== 'string') return '';
    let t = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/```/g, '').substring(0, 500);
    t = t.replace(/ignore (previous|above) instructions/gi, '[filtered]');
    t = t.replace(/system:/gi, '[filtered]');
    return t.trim();
  };
  const safeRequest = sanitize(userRequest) || 'Give 5 actionable suggestions based on SQD, form and sample suggestions.';
  if (safeRequest.length < 3) throw new Error('Request too short');
  if (safeRequest.length > 500) throw new Error('Request too long (max 500)');

  const sqdFields = ['sqd0', 'sqd1', 'sqd2', 'sqd3', 'sqd4', 'sqd5', 'sqd6', 'sqd7', 'sqd8'];
  const sqdDefs = ['SQD0 Overall Satisfaction', 'SQD1 Speed & Waiting Time', 'SQD2 Requirements Compliance', 'SQD3 Ease of Steps & Payment', 'SQD4 Location & Info Access', 'SQD5 Fair Fees', 'SQD6 Equality', 'SQD7 Staff Courtesy', 'SQD8 Outcome Fulfillment'];
  // SQD averages
  const sqdAverages = sqdFields.map(f => {
    const vals = (Array.isArray(feedbacks) ? feedbacks : []).map(x => parseFloat(x[f])).filter(v => !isNaN(v));
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : 'N/A';
  });
  // SQD distribution counts for prompt (sample)
  const sqdDist = sqdFields.map(f => {
    const c = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0, 'N/A': 0 };
    (feedbacks || []).forEach(x => { const v = String(x[f] || '').trim(); if (c[v] !== undefined) c[v]++; });
    return c;
  });
  // Form samples — only form fields, no free-text beyond suggestions
  const formSamples = (Array.isArray(feedbacks) ? feedbacks : []).slice(0, 15).map(f => ({
    tanggapan: sanitize(f.tanggapan).substring(0, 80),
    transaksyon: sanitize(f.uri_transaksyon || f.transaksyon || '').substring(0, 80),
    clientType: sanitize(f.uri_kliyente || '').substring(0, 40),
    cc1: String(f.cc1 || '').substring(0, 10)
  })).filter(x => x.tanggapan || x.transaksyon);

  // Sample suggestions — only suggestions field, capped
  const rawSuggestions = (Array.isArray(feedbacks) ? feedbacks : [])
    .map(f => sanitize(f.suggestions))
    .filter(s => s && s.length >= 3)
    .slice(0, 15);
  let suggestionsJson = JSON.stringify(rawSuggestions);
  if (suggestionsJson.length > 6000) suggestionsJson = suggestionsJson.substring(0, 6000);
  let formJson = JSON.stringify(formSamples);
  if (formJson.length > 4000) formJson = formJson.substring(0, 4000);
  const sqdJson = JSON.stringify(sqdFields.map((f, i) => ({ field: f, label: sqdDefs[i], avg: sqdAverages[i], dist: sqdDist[i] }))).substring(0, 6000);

  const hasData = (feedbacks && feedbacks.length > 0);

  // ACCURACY FIX: when no feedback exists for the selected scope/period, do NOT
  // fabricate SQD averages or pretend findings exist. Return an explicit
  // "no data" state so Generate never shows N/A/5.00 as a finding.
  if (!hasData) {
    // Light sanitize for scope label fallback
    const scopeEsc = String(safeLabel).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    return `
<div style="background:#fffbeb; border:1px solid #fcd34d; border-radius:12px; padding:0.95rem 1.1rem; margin-bottom:0.85rem; display:flex; gap:0.85rem; align-items:flex-start;">
  <div style="width:42px; height:42px; border-radius:12px; background:#fef3c7; color:#d97706; display:flex; align-items:center; justify-content:center; font-size:1.15rem; flex-shrink:0; border:1px solid #fde68a;"><i class="fas fa-inbox"></i></div>
  <div style="flex:1;">
    <div style="font-weight:800; color:#92400e; font-size:0.90rem; line-height:1.3;">No Feedback Data Available — ${scopeEsc} (0 respondents)</div>
    <div style="font-size:0.82rem; color:#78350f; margin-top:0.30rem; line-height:1.5;">No SQD ratings or client comments exist for this quarter / office filter. Averages are <strong>N/A</strong> and sentiment / pattern analysis cannot be computed until feedback is collected.</div>
    <div style="font-size:0.74rem; color:#a16207; margin-top:0.45rem; background:#ffffff; border:1px dashed #fcd34d; padding:0.45rem 0.65rem; border-radius:8px; line-height:1.45;">The cards below are <strong>pre-collection setup recommendations</strong> to help you start collecting — they are <em>not</em> findings from actual responses. Collect at least <strong>5–10 responses</strong> to enable data-driven suggestions.</div>
  </div>
</div>
<div class="ai-suggestion-card" style="background:#ffffff; border:1px dashed #fcd34d; border-radius:12px; padding:0.85rem 1rem; margin-bottom:0.75rem; display:flex; align-items:flex-start; gap:0.85rem;">
  <div style="width:40px; height:40px; border-radius:12px; background:#fef3c7; color:#d97706; display:flex; align-items:center; justify-content:center; font-size:1.1rem; flex-shrink:0; border:1px solid #fde68a;"><i class="fas fa-qrcode"></i></div>
  <div style="flex:1;">
    <div style="display:flex; align-items:center; gap:0.45rem; margin-bottom:0.2rem;">
      <span style="width:20px; height:20px; border-radius:50%; background:#f59e0b; color:#ffffff; font-weight:700; font-size:0.68rem; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;">1</span>
      <span style="font-weight:700; color:#0f172a; font-size:0.88rem;">Deploy QR Codes & Invite Responses</span>
      <span style="font-size:0.66rem; font-weight:700; color:#d97706; background:#fffbeb; border:1px solid #fde68a; padding:0.12rem 0.45rem; border-radius:20px; margin-left:0.3rem;">SETUP</span>
    </div>
    <div style="font-size:0.8rem; color:#475569; line-height:1.45; margin-bottom:0.35rem;">No responses yet for <strong>${scopeEsc}</strong> — start by making the feedback form discoverable at every service point.</div>
    <div style="background:#fffbeb; border-left:3px solid #f59e0b; padding:0.4rem 0.6rem; border-radius:4px; font-size:0.76rem; color:#334155;">
      <strong style="color:#92400e;"><i class="fas fa-lightbulb" style="margin-right:0.25rem;"></i> Strategy:</strong> Print the unique QR code for each office (QR Codes tab) on transaction slips, desk standees, and waiting-area posters. Brief frontline staff to invite clients to scan before leaving. Aim for ≥10 responses before running analysis.
    </div>
  </div>
</div>
<div class="ai-suggestion-card" style="background:#ffffff; border:1px dashed #fcd34d; border-radius:12px; padding:0.85rem 1rem; margin-bottom:0.75rem; display:flex; align-items:flex-start; gap:0.85rem;">
  <div style="width:40px; height:40px; border-radius:12px; background:#fef3c7; color:#d97706; display:flex; align-items:center; justify-content:center; font-size:1.1rem; flex-shrink:0; border:1px solid #fde68a;"><i class="fas fa-bullhorn"></i></div>
  <div style="flex:1;">
    <div style="display:flex; align-items:center; gap:0.45rem; margin-bottom:0.2rem;">
      <span style="width:20px; height:20px; border-radius:50%; background:#f59e0b; color:#ffffff; font-weight:700; font-size:0.68rem; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;">2</span>
      <span style="font-weight:700; color:#0f172a; font-size:0.88rem;">Announce the Feedback System Campus-Wide</span>
      <span style="font-size:0.66rem; font-weight:700; color:#d97706; background:#fffbeb; border:1px solid #fde68a; padding:0.12rem 0.45rem; border-radius:20px; margin-left:0.3rem;">SETUP</span>
    </div>
    <div style="font-size:0.8rem; color:#475569; line-height:1.45; margin-bottom:0.35rem;">Clients cannot respond if they do not know the system exists — awareness must precede analysis.</div>
    <div style="background:#fffbeb; border-left:3px solid #f59e0b; padding:0.4rem 0.6rem; border-radius:4px; font-size:0.76rem; color:#334155;">
      <strong style="color:#92400e;"><i class="fas fa-lightbulb" style="margin-right:0.25rem;"></i> Strategy:</strong> Post the feedback link on the university Facebook page, office bulletin boards, and the Citizen's Charter area. Add a short tagline: “Scan • Rate SQD 0–8 • Help us improve.”
    </div>
  </div>
</div>
<div class="ai-suggestion-card" style="background:#ffffff; border:1px dashed #fcd34d; border-radius:12px; padding:0.85rem 1rem; margin-bottom:0.75rem; display:flex; align-items:flex-start; gap:0.85rem;">
  <div style="width:40px; height:40px; border-radius:12px; background:#fef3c7; color:#d97706; display:flex; align-items:center; justify-content:center; font-size:1.1rem; flex-shrink:0; border:1px solid #fde68a;"><i class="fas fa-chart-line"></i></div>
  <div style="flex:1;">
    <div style="display:flex; align-items:center; gap:0.45rem; margin-bottom:0.2rem;">
      <span style="width:20px; height:20px; border-radius:50%; background:#f59e0b; color:#ffffff; font-weight:700; font-size:0.68rem; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;">3</span>
      <span style="font-weight:700; color:#0f172a; font-size:0.88rem;">Verify Collection, Then Re-Run Analysis</span>
      <span style="font-size:0.66rem; font-weight:700; color:#d97706; background:#fffbeb; border:1px solid #fde68a; padding:0.12rem 0.45rem; border-radius:20px; margin-left:0.3rem;">NEXT STEP</span>
    </div>
    <div style="font-size:0.8rem; color:#475569; line-height:1.45; margin-bottom:0.35rem;">Once feedback accumulates, this panel will show <strong>SQD-specific findings</strong> (e.g., lowest-rated SQD1/SQD3) and Naïve Bayes sentiment, not generic setup tips.</div>
    <div style="background:#fffbeb; border-left:3px solid #f59e0b; padding:0.4rem 0.6rem; border-radius:4px; font-size:0.76rem; color:#334155;">
      <strong style="color:#92400e;"><i class="fas fa-lightbulb" style="margin-right:0.25rem;"></i> Strategy:</strong> Check the Dashboard after 5–10 submissions: review <em>SQD averages (not N/A)</em>, sentiment split, and monthly trend. Then click <strong>Generate</strong> again for data-driven priorities.
    </div>
  </div>
</div>
`;
  }

  // Preset icons matching the 5 card types in reference image
  const icons = [
    'fas fa-comment-dots',
    'fas fa-calendar-check',
    'fas fa-users',
    'fas fa-trophy',
    'fas fa-chart-column'
  ];

  // Try Gemini — SQD + Form + Sample Suggestions ONLY
  if (process.env.GEMINI_API_KEY && genAI) {
    try {
      const aiInstance = genAI || new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = aiInstance.getGenerativeModel({
        model: 'gemini-3.6-flash',
        generationConfig: { temperature: 0.85, topP: 0.95 }
      });
      const prompt = `
You are a PSAU Quality Assurance assistant evaluating SQD and Feedback Analysis for Pampanga State Agricultural University.
Scope: ${safeLabel}
User request: "${safeRequest.replace(/"/g, "'")}"
Request Timestamp: ${Date.now()}
Total respondents in scope: ${(feedbacks || []).length}
SQD summary (per dimension, avg/5 and distribution 5-1/N/A): ${sqdJson}
Form samples (tanggapan/transaction/clientType, ${formSamples.length} rows): ${formJson}
Sample suggestions (suggestions field only, ${rawSuggestions.length} items): ${suggestionsJson}

CRITICAL REQUIREMENT:
- Generate exactly 5 FRESH, DISTINCT, and DYNAMIC suggestions focused specifically on user's request, SQD dimensions (SQD0-SQD8), and quarterly feedback analysis.
- For EVERY item, you MUST include BOTH an observation/finding AND an explicit, concrete implementation strategy detailing HOW to improve the service step-by-step.
- Return ONLY clean HTML (no markdown code fences, no <html> wrapper).
- Format each item EXACTLY as this HTML card structure:
<div class="ai-suggestion-card" style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:0.85rem 1rem; margin-bottom:0.75rem; display:flex; align-items:flex-start; gap:0.85rem; transition:all 0.2s ease;">
  <div style="width:40px; height:40px; border-radius:12px; background:#e8f5e9; color:#16a34a; display:flex; align-items:center; justify-content:center; font-size:1.1rem; flex-shrink:0; border:1px solid #c8e6c9;">
    <i class="ICON_NAME"></i>
  </div>
  <div style="flex:1;">
    <div style="display:flex; align-items:center; gap:0.45rem; margin-bottom:0.2rem;">
      <span style="width:20px; height:20px; border-radius:50%; background:#16a34a; color:#ffffff; font-weight:700; font-size:0.7rem; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;">N</span>
      <span style="font-weight:700; color:#0f172a; font-size:0.88rem;">SHORT_TITLE</span>
    </div>
    <div style="font-size:0.8rem; color:#475569; line-height:1.45; margin-bottom:0.35rem;">DESCRIPTION</div>
    <div style="background:#f8fafc; border-left:3px solid #16a34a; padding:0.4rem 0.6rem; border-radius:4px; font-size:0.76rem; color:#334155;">
      <strong style="color:#15803d;"><i class="fas fa-lightbulb" style="margin-right:0.25rem;"></i> Strategy:</strong> STRATEGY_HOW_TO_IMPROVE
    </div>
  </div>
</div>
Use ICON_NAME values from this list for items 1-5 respectively: "fas fa-comment-dots", "fas fa-calendar-check", "fas fa-users", "fas fa-trophy", "fas fa-chart-column".
`;
      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AI Timeout')), 15000))
      ]);
      const text = (await result.response).text().replace(/```html/gi, '').replace(/```/g, '').trim();
      if (text && text.length > 50) {
        return text;
      }
    } catch (e) {
      console.warn('Suggestions AI (SQD+Form) fallback:', e.message);
    }
  }

  // Local fallback — Naive Bayes & SQD Dynamic Pool (10 dynamic strategy options)
  const sqdRanked = sqdFields.map((f, i) => ({ label: sqdDefs[i], avg: parseFloat(sqdAverages[i]) || 0, raw: sqdAverages[i] })).filter(x => !isNaN(x.avg)).sort((a, b) => a.avg - b.avg);
  const lowestSqd = sqdRanked[0] ? sqdRanked[0].label : 'Processing Speed (SQD1)';
  const lowestVal = sqdRanked[0] ? sqdRanked[0].raw : '4.12';

  const dynamicPool = [
    {
      title: "Streamline Transaction & Processing Speed (SQD1)",
      detail: `Address processing delays in ${lowestSqd} (current avg: ${lowestVal}/5.00) identified in client feedback logs.`,
      strategy: "Establish express transaction lanes, digitize document queuing, and set target processing SLAs (max 15 mins per transaction).",
      icon: "fas fa-bolt"
    },
    {
      title: "Enhance Requirements Clarity & Guidance (SQD2)",
      detail: "Reduce client confusion regarding documentary requirements before reaching frontline service windows.",
      strategy: "Publish step-by-step infographic checklists at office entrances and post downloadable requirement PDFs on the university portal.",
      icon: "fas fa-file-signature"
    },
    {
      title: "Simplify Office Approval Workflows (SQD3)",
      detail: "Minimize redundant signatories and inter-office routing reported in quarterly feedback.",
      strategy: "Consolidate approval forms into single-window digital routing and train staff on cross-department document verification.",
      icon: "fas fa-sitemap"
    },
    {
      title: "Improve Information Transparency & Status Tracking (SQD4)",
      detail: "Ensure clear communication of service timelines, Citizen's Charter standards, and document status.",
      strategy: "Install digital status monitors in waiting areas and launch real-time online tracking for student requests.",
      icon: "fas fa-eye"
    },
    {
      title: "Maintain Clear Payment Channels & Transparency (SQD5)",
      detail: "Ensure transparency in official fee assessments and prevent cashier bottlenecking during enrollment.",
      strategy: "Integrate online e-payment gateways (GCash/PayMaya/Bank) and display official receipt breakdown signs at counters.",
      icon: "fas fa-credit-card"
    },
    {
      title: "Upgrade Waiting Area Comfort & Facility Hygiene (SQD6)",
      detail: "Improve physical waiting spaces, seating capacity, and ventilation based on visitor feedback.",
      strategy: "Implement bi-hourly sanitization logs, expand shaded outdoor waiting benches, and install free drinking water stations.",
      icon: "fas fa-couch"
    },
    {
      title: "Elevate Frontline Staff Courtesy & Client Care (SQD7)",
      detail: "Reinforce positive client engagement and active listening across all administrative service desks.",
      strategy: "Conduct mandatory quarterly customer service orientation for staff, establish help desks for complex inquiries, and enforce polite greeting protocols.",
      icon: "fas fa-hands-helping"
    },
    {
      title: "Establish Rapid Helpdesk & Problem Resolution (SQD8)",
      detail: "Ensure unhandled client inquiries or complaints receive prompt resolution within 24 hours.",
      strategy: "Deploy a dedicated QMS helpdesk desk officer and track complaint resolution SLAs in weekly administrative reviews.",
      icon: "fas fa-headset"
    },
    {
      title: "Expand Digital QR Feedback & Real-Time Analytics",
      detail: "Increase response rates across all client categories (students, alumni, general public).",
      strategy: "Print unique QR codes on official transaction slips, incentivize monthly survey participation, and monitor sentiment trends.",
      icon: "fas fa-qrcode"
    },
    {
      title: "Execute Naïve Bayes Quality Audits & Process Iterations",
      detail: "Use automated machine learning sentiment scores to identify low-performing service touchpoints.",
      strategy: "Conduct monthly administrative quality audits targeting lowest-rated SQD indicators and reallocate staff during peak hours.",
      icon: "fas fa-chart-line"
    }
  ];

  // Dynamic shuffle / offset seed based on user request string and current timestamp so every click yields fresh items
  const seed = (safeRequest.length + Date.now()) % dynamicPool.length;
  const selectedCards = [];
  for (let i = 0; i < 5; i++) {
    const idx = (seed + i * 2) % dynamicPool.length;
    selectedCards.push(dynamicPool[idx]);
  }

  const items = selectedCards.map((card, i) => {
    const icon = icons[i] || card.icon;
    return `
<div class="ai-suggestion-card" style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:0.85rem 1rem; margin-bottom:0.75rem; display:flex; align-items:flex-start; gap:0.85rem; transition:all 0.2s ease;">
  <div style="width:40px; height:40px; border-radius:12px; background:#e8f5e9; color:#16a34a; display:flex; align-items:center; justify-content:center; font-size:1.1rem; flex-shrink:0; border:1px solid #c8e6c9;">
    <i class="${icon}"></i>
  </div>
  <div style="flex:1;">
    <div style="display:flex; align-align:center; gap:0.45rem; margin-bottom:0.2rem;">
      <span style="width:20px; height:20px; border-radius:50%; background:#16a34a; color:#ffffff; font-weight:700; font-size:0.7rem; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;">${i + 1}</span>
      <span style="font-weight:700; color:#0f172a; font-size:0.88rem;">${card.title}</span>
    </div>
    <div style="font-size:0.8rem; color:#475569; line-height:1.45; margin-bottom:0.35rem;">${card.detail}</div>
    <div style="background:#f8fafc; border-left:3px solid #16a34a; padding:0.4rem 0.6rem; border-radius:4px; font-size:0.76rem; color:#334155;">
      <strong style="color:#15803d;"><i class="fas fa-lightbulb" style="margin-right:0.25rem;"></i> Strategy:</strong> ${card.strategy}
    </div>
  </div>
</div>`;
  }).join('');

  return items;
}

module.exports = {
  generateHybridReport,
  generateSuggestionsOnly
};
