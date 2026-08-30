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

module.exports = { getQuarterFromDate, processQuarterlyData };
