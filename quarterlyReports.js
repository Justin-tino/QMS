/**
 * PSAU Feedback System — Automated Quarterly Report Processor
 * Groups, aggregates, and analyzes feedback data by academic/calendar quarters:
 * Q1: Jan 1 - Mar 31 | Q2: Apr 1 - Jun 30 | Q3: Jul 1 - Sep 30 | Q4: Oct 1 - Dec 31
 */

function getQuarterFromDate(dateInput) {
    if (!dateInput) return 'Q1';
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return 'Q1';
    const month = date.getMonth(); // 0-indexed
    if (month >= 0 && month <= 2) return 'Q1';
    if (month >= 3 && month <= 5) return 'Q2';
    if (month >= 6 && month <= 8) return 'Q3';
    return 'Q4';
}

function processQuarterlyData(allFeedbacks, selectedYear = new Date().getFullYear(), selectedQuarter = null) {
    const yearNum = parseInt(selectedYear) || new Date().getFullYear();

    // Filter feedbacks for the target year
    const yearFeedbacks = allFeedbacks.filter(f => {
        const dateStr = f.petsa || f.submittedAt;
        if (!dateStr) return true; // Include if date missing default
        const d = new Date(dateStr);
        return isNaN(d.getTime()) || d.getFullYear() === yearNum;
    });

    // Bucket feedbacks into quarters
    const quarters = {
        Q1: { label: 'Quarter 1 (Jan - Mar)', period: `Jan 1 - Mar 31, ${yearNum}`, items: [] },
        Q2: { label: 'Quarter 2 (Apr - Jun)', period: `Apr 1 - Jun 30, ${yearNum}`, items: [] },
        Q3: { label: 'Quarter 3 (Jul - Sep)', period: `Jul 1 - Sep 30, ${yearNum}`, items: [] },
        Q4: { label: 'Quarter 4 (Oct - Dec)', period: `Oct 1 - Dec 31, ${yearNum}`, items: [] }
    };

    yearFeedbacks.forEach(f => {
        const dateStr = f.petsa || f.submittedAt;
        const qKey = getQuarterFromDate(dateStr);
        quarters[qKey].items.push(f);
    });

    // Helper to calculate summary stats for a list of feedbacks
    const summarizeQuarter = (items) => {
        const total = items.length;
        if (total === 0) {
            return {
                totalResponses: 0,
                avgSQD: '0.00',
                sqdAverages: new Array(9).fill(0),
                positivePct: 0,
                sentimentCounts: { positive: 0, neutral: 0, negative: 0, mixed: 0 },
                ccAwarenessPct: 0,
                topDepartment: 'N/A',
                needsAttentionDept: 'N/A'
            };
        }

        const sqdFields = ['sqd0', 'sqd1', 'sqd2', 'sqd3', 'sqd4', 'sqd5', 'sqd6', 'sqd7', 'sqd8'];
        const sqdAverages = sqdFields.map(field => {
            const vals = items.map(f => parseFloat(f[field])).filter(v => !isNaN(v));
            return vals.length > 0 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : 0;
        });

        // ACCURACY FIX: overall = TRUE MEAN of all individual valid ratings (not mean of dimension means)
        let sumAll = 0, countAll = 0;
        sqdFields.forEach(field => {
            items.forEach(f => {
                const v = parseFloat(f[field]);
                if (!isNaN(v)) { sumAll += v; countAll++; }
            });
        });
        const avgSQD = countAll > 0 ? (sumAll / countAll).toFixed(2) : '0.00';

        // Sentiment — only over responses WITH comments (empty comments are not 'Neutral')
        const sentimentCounts = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
        items.forEach(f => {
            const hasComment = f.suggestions && String(f.suggestions).trim().length > 0;
            if (!hasComment) return;
            const s = (f.sentiment || 'neutral').toLowerCase();
            if (sentimentCounts[s] !== undefined) sentimentCounts[s]++;
            else sentimentCounts.neutral++;
        });
        const commentedTotal = sentimentCounts.positive + sentimentCounts.neutral + sentimentCounts.negative + sentimentCounts.mixed;

        const positivePct = commentedTotal > 0 ? Math.round((sentimentCounts.positive / commentedTotal) * 100) : 0;

        // Citizen's Charter awareness (CC1 = 1 or 2 or 3)
        const ccAwareCount = items.filter(f => ['1', '2', '3'].includes(f.cc1)).length;
        const ccAwarenessPct = Math.round((ccAwareCount / total) * 100);

        // Top & bottom performing departments
        const deptScores = {};
        items.forEach(f => {
            if (!f.tanggapan) return;
            const d = f.tanggapan.trim();
            const score = parseFloat(f.avgSQD);
            if (!isNaN(score)) {
                if (!deptScores[d]) deptScores[d] = [];
                deptScores[d].push(score);
            }
        });

        const deptAvgs = Object.keys(deptScores).map(name => ({
            name,
            avg: deptScores[name].reduce((a, b) => a + b, 0) / deptScores[name].length
        })).sort((a, b) => b.avg - a.avg);

        const topDepartment = deptAvgs.length > 0 ? `${deptAvgs[0].name} (${deptAvgs[0].avg.toFixed(2)})` : 'N/A';
        const needsAttentionDept = deptAvgs.length > 0 ? `${deptAvgs[deptAvgs.length - 1].name} (${deptAvgs[deptAvgs.length - 1].avg.toFixed(2)})` : 'N/A';

        return {
            totalResponses: total,
            avgSQD,
            sqdAverages,
            positivePct,
            sentimentCounts,
            ccAwarenessPct,
            topDepartment,
            needsAttentionDept
        };
    };

    // Calculate analytics for each quarter
    const quarterlySummaries = {};
    Object.keys(quarters).forEach(qKey => {
        quarterlySummaries[qKey] = {
            ...quarters[qKey],
            stats: summarizeQuarter(quarters[qKey].items)
        };
    });

    // Target quarter report detail if selected
    const activeQuarter = selectedQuarter && quarters[selectedQuarter] ? selectedQuarter : getQuarterFromDate(new Date());
    const activeReport = quarterlySummaries[activeQuarter];

    // anchor the year dropdown to the REAL current year (not the selected year),
    // so selecting an older year never hides newer years. Always shows the last 3 calendar years,
    // PLUS every year that actually contains feedback data (derived from all feedbacks),
    // PLUS the selected year — so no year is ever unreachable from the dropdown.
    const currentYear = new Date().getFullYear();
    const yearSet = new Set();
    for (let y = currentYear; y >= currentYear - 2; y--) yearSet.add(y);
    allFeedbacks.forEach(f => {
        const d = new Date(f.petsa || f.submittedAt || '');
        if (!isNaN(d.getTime())) yearSet.add(d.getFullYear());
    });
    yearSet.add(yearNum);
    const availableYears = [...yearSet].sort((a, b) => b - a);

    return {
        selectedYear: yearNum,
        activeQuarter,
        activeReport,
        quarterlySummaries,
        availableYears
    };
}

// ===== Office Performance Ranking (Low Performing + Top 3) =====
// SQD dimension labels (mirror server.js / aiService.js definitions)
const SQD_DIMENSIONS = [
    { field: 'sqd0', code: 'SQD0', name: 'Overall Satisfaction' },
    { field: 'sqd1', code: 'SQD1', name: 'Speed & Waiting Time' },
    { field: 'sqd2', code: 'SQD2', name: 'Requirements Compliance' },
    { field: 'sqd3', code: 'SQD3', name: 'Ease of Steps & Payment' },
    { field: 'sqd4', code: 'SQD4', name: 'Location & Info Access' },
    { field: 'sqd5', code: 'SQD5', name: 'Fairness of Fees' },
    { field: 'sqd6', code: 'SQD6', name: 'Equality of Treatment' },
    { field: 'sqd7', code: 'SQD7', name: 'Staff Courtesy' },
    { field: 'sqd8', code: 'SQD8', name: 'Outcome Fulfillment' }
];

// Data-driven improvement strategies, keyed by the weakest SQD dimension
const SQD_TIPS = {
    sqd0: [
        'Review the end-to-end service experience and address the most common complaints raised in feedback comments.',
        'Set a target overall satisfaction score and monitor it monthly with the office team.'
    ],
    sqd1: [
        'Streamline queue management: display estimated processing times and add numbering at service counters.',
        'Reassign or add staff during peak hours to cut down waiting time.'
    ],
    sqd2: [
        'Post a clear checklist of required documents at the entrance and online so clients come prepared.',
        'Allow pre-validation of requirements (online or via phone) to avoid repeat visits.'
    ],
    sqd3: [
        'Reduce the number of steps per transaction and combine related windows into a single service lane.',
        'Offer clear step-by-step guides for payment and form filling.'
    ],
    sqd4: [
        'Improve directional signage and publish office location, hours, and contact details online.',
        'Provide a visible Citizen\u2019s Charter and information board near the entrance.'
    ],
    sqd5: [
        'Display the official schedule of fees prominently and issue official receipts for every payment.',
        'Review charges against the approved fee matrix and remove unnecessary add-on costs.'
    ],
    sqd6: [
        'Conduct a staff re-orientation on equal treatment of all clients (no favoritism, no discrimination).',
        'Install a feedback and grievance channel that clients can use without fear.'
    ],
    sqd7: [
        'Hold regular customer-care and courtesy training for frontline personnel.',
        'Recognize and reward staff who receive positive client feedback to reinforce good behavior.'
    ],
    sqd8: [
        'Track and resolve the root causes of unfulfilled or delayed requests; follow up pending transactions weekly.',
        'Give clients clear timelines and status updates until the transaction is fully completed.'
    ]
};
/**
 * Ranks offices/departments by average SQD (ascending — worst first).
 * Returns the full list plus the "low performing" subset and the top 3.
 * Low performing = offices averaging below 4.00; if none qualify, the bottom 3
 * offices are returned so the section is never empty when data exists.
 */
function computeOfficeRankings(items) {
    const offices = {};
    (items || []).forEach(f => {
        if (!f || typeof f.tanggapan !== 'string') return;
        const name = f.tanggapan.trim();
        if (!name) return;
        if (!offices[name]) {
            offices[name] = { name, total: 0, ratings: [], sqdSums: {}, sqdCounts: {}, positive: 0, negative: 0, neutral: 0 };
        }
        offices[name].total++;
        const score = parseFloat(f.avgSQD);
        if (!isNaN(score)) offices[name].ratings.push(score);
        SQD_DIMENSIONS.forEach(dim => {
            const v = parseFloat(f[dim.field]);
            if (!isNaN(v)) {
                offices[name].sqdSums[dim.field] = (offices[name].sqdSums[dim.field] || 0) + v;
                offices[name].sqdCounts[dim.field] = (offices[name].sqdCounts[dim.field] || 0) + 1;
            }
        });
        const hasComment = f.suggestions && String(f.suggestions).trim().length > 0;
        if (hasComment) {
            const s = String(f.sentiment || 'neutral').toLowerCase();
            if (s === 'positive') offices[name].positive++;
            else if (s === 'negative') offices[name].negative++;
            else offices[name].neutral++;
        }
    });

    const ranked = Object.values(offices).map(o => {
        const avg = o.ratings.length > 0
            ? Math.round((o.ratings.reduce((a, b) => a + b, 0) / o.ratings.length) * 100) / 100
            : null;

        // ALL SQD dimension averages for THIS office — the basis of its own suggestions
        const dimAverages = SQD_DIMENSIONS
            .map(dim => ({ dim, count: o.sqdCounts[dim.field] || 0 }))
            .filter(x => x.count > 0)
            .map(x => ({
                code: x.dim.code,
                name: x.dim.name,
                count: x.count,
                avg: Math.round((o.sqdSums[x.dim.field] / x.count) * 100) / 100
            }))
            .sort((a, b) => a.avg - b.avg || a.code.localeCompare(b.code));

        // Problem areas = the 2 lowest-rated dimensions of THIS office (not of other offices)
        const weakAreas = dimAverages.slice(0, Math.min(2, dimAverages.length));
        const weakest = weakAreas.length ? weakAreas[0] : null;

        // Dynamic, office-specific suggestions — composed from THIS office's actual scores,
        // rating counts, written comments and response volume. Two offices with the same
        // weakest dimension still get different text because their numbers differ.
        const suggestions = [];
        weakAreas.forEach((wa, i) => {
            const actions = SQD_TIPS[wa.code.toLowerCase()] || [];
            if (!actions.length) return;
            // Vary the action pick between offices that share the same weak dimension
            const action = actions[(o.name.length + o.total + i) % actions.length];
            const severity = wa.avg <= 2.5 ? 'lowest-rated area'
                : (wa.avg <= 3.5 ? 'weak area' : 'area to watch');
            suggestions.push(
                `${wa.code} ${wa.name} is this office's ${severity}: ${wa.avg.toFixed(2)}/5.00 across ${wa.count} client${wa.count === 1 ? '' : 's'} — ${action}`
            );
        });

        // Comment-driven line — depends on THIS office's own sentiment mix
        const commented = o.positive + o.negative + o.neutral;
        if (commented >= 3 && o.negative > 0 && (o.negative / commented) >= 0.25) {
            suggestions.push(
                `${o.negative} of ${commented} written comments here were negative — read them in the Feedback page and resolve the most repeated complaint first.`
            );
        }

        // Low-sample line — depends on THIS office's response volume
        if (o.ratings.length > 0 && o.ratings.length < 3) {
            suggestions.push(
                `Only ${o.ratings.length} rated response${o.ratings.length === 1 ? '' : 's'} so far — the score may not yet reflect the office; display the QR feedback card at its counter to gather more.`
            );
        }

        return {
            name: o.name,
            total: o.total,
            responses: o.ratings.length,
            avg,
            avgDisplay: avg !== null ? avg.toFixed(2) : 'N/A',
            weakest,
            weakAreas,
            suggestions: suggestions.slice(0, 3),
            positive: o.positive,
            negative: o.negative,
            neutral: o.neutral
        };
    }).sort((a, b) => {
        if (a.avg === null && b.avg === null) return a.name.localeCompare(b.name);
        if (a.avg === null) return 1;
        if (b.avg === null) return -1;
        return a.avg - b.avg || a.name.localeCompare(b.name);
    });

    const withScores = ranked.filter(o => o.avg !== null);
    const LOW_THRESHOLD = 4.0;
    let lowPerformers = withScores.filter(o => o.avg < LOW_THRESHOLD);
    if (lowPerformers.length === 0 && withScores.length > 0) {
        lowPerformers = withScores.slice(0, Math.min(3, withScores.length));
    }
    const top3 = withScores.slice(-3).reverse();

    return { all: ranked, lowPerformers, top3, lowThreshold: LOW_THRESHOLD };
}


/**
 * Analyzes SQD dimensions (SQD0-SQD8) across ALL responses in scope.
 * Finds the WEAKEST and STRONGEST dimension so the UI can give targeted,
 * data-driven improvement suggestions instead of fixed generic ones.
 */
function computeDimensionAnalysis(items) {
    const sums = {};
    const counts = {};
    let responses = 0;
    (items || []).forEach(f => {
        if (!f) return;
        let hasAny = false;
        SQD_DIMENSIONS.forEach(dim => {
            const v = parseFloat(f[dim.field]);
            if (!isNaN(v)) {
                sums[dim.field] = (sums[dim.field] || 0) + v;
                counts[dim.field] = (counts[dim.field] || 0) + 1;
                hasAny = true;
            }
        });
        if (hasAny) responses++;
    });

    const dims = SQD_DIMENSIONS
        .map(dim => ({
            code: dim.code,
            name: dim.name,
            count: counts[dim.field] || 0,
            avg: counts[dim.field] ? Math.round((sums[dim.field] / counts[dim.field]) * 100) / 100 : null
        }))
        .filter(d => d.count > 0)
        .sort((a, b) => a.avg - b.avg || a.code.localeCompare(b.code));

    if (!dims.length) {
        return { hasData: false, responses: 0, dims: [], weakest: null, strongest: null, tips: [] };
    }

    const weakest = dims[0];
    const strongest = dims[dims.length - 1];
    const tips = SQD_TIPS[weakest.code.toLowerCase()] || [];

    return { hasData: true, responses, dims, weakest, strongest, tips };
}

module.exports = { getQuarterFromDate, processQuarterlyData, computeOfficeRankings, computeDimensionAnalysis, SQD_DIMENSIONS, SQD_TIPS };
