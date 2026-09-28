/**
 * Render + logic test for the click-to-edit re-dating feature on views/report.ejs
 * (PSAU-QMS-SF-20 Customer Feedback Report — "fake the report date" support).
 *
 * Locks:
 *   - Revision No., Eff. Date, "Report generated", Covered Month-Year, MONTH rows and
 *     the signatory Date cells render as click-to-edit (.editable) values
 *   - the edit affordance is neutralised for print, the tip bar is screen-only
 *   - only those values are editable — no figure cell becomes contenteditable
 *   - the inline script parses and its helpers behave as specified
 *     (Covered Month-Year -> FIRST day of the period, month rows re-anchored)
 * Run: node test-report-edit.js
 */
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const templatePath = path.join(__dirname, 'views', 'report.ejs');
const template = fs.readFileSync(templatePath, 'utf8');

let pass = 0, fail = 0;
function check(label, condition) {
    if (condition) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label); }
}

// ---------- mock locals — mirrors what GET /admin/report passes to res.render('report') ----------
const months = [
    { name: 'July', year: 2026, counts: { '5': 7, '4': 3, '3': 1, '2': 0, '1': 0, 'N/A': 2 }, valid: 11, mean: 4.55, pct: 90.91, adj: 'Outstanding' },
    { name: 'August', year: 2026, counts: { '5': 6, '4': 4, '3': 1, '2': 0, '1': 1, 'N/A': 1 }, valid: 12, mean: 4.33, pct: 83.33, adj: 'Very Satisfactory' },
    { name: 'September', year: 2026, counts: { '5': 9, '4': 2, '3': 0, '2': 0, '1': 1, 'N/A': 0 }, valid: 12, mean: 4.58, pct: 91.67, adj: 'Outstanding' }
];
const overall = { counts: { '5': 22, '4': 9, '3': 2, '2': 0, '1': 2, 'N/A': 3 }, valid: 35, mean: 4.46, pct: 88.57, adj: 'Very Satisfactory', positive: 31, validForPct: 35, percentage: 88.57 };
const sqdSummary = ['SQD0', 'SQD1', 'SQD2', 'SQD3', 'SQD4', 'SQD5', 'SQD6', 'SQD7', 'SQD8'].map(function (code, i) {
    return {
        code, full: 'Dimension ' + i, desc: 'Description ' + i,
        counts: { '5': 4, '4': 5, '3': 0, '2': 0, '1': 0, 'N/A': 0 }, valid: 9, mean: 4.44, pct: 100, adj: 'Very Satisfactory', positive: 9
    };
});

const locals = {
    feedbacks: [],
    stats: { totalResponses: 36 },
    selectedOffice: 'all',
    filterType: 'range',
    periodLabel: '2026-07-01 to 2026-09-30',
    monthVal: '',
    dateFrom: '2026-07-01',
    dateTo: '2026-09-30',
    generatedAt: 'September 28, 2026 at 10:13 AM',
    effDate: 'September 28, 2026',
    todayShort: '09/28/2026',
    office: 'All',
    respondents: 36,
    months,
    overall,
    sqdSummary,
    sqdTotals: Object.assign({}, overall.counts),
    sqdOverallMean: overall.mean,
    sqdOverallPct: overall.pct,
    sqdOverallAdj: overall.adj,
    remarks: 'Very Satisfactory — Period rating 88.57%',
    preparedBy: 'Ma. Reena Rose P. Tayag', preparedPos: 'Assistant Quality Management Representative',
    reviewedBy: 'Glenda Marie T. Maniago', reviewedPos: 'Quality Management Representative',
    certifiedBy: 'Dexter Andrew O. Manalo', certifiedPos: 'Director, Office of Institutional Quality Assurance',
    preparedDate: '09/28/2026', reviewedDate: '09/28/2026', certifiedDate: '09/28/2026'
};

console.log('\n=== report.ejs click-to-edit re-dating test ===\n');
console.log('[1] render + click-to-edit markup');
let html = '';
try {
    html = ejs.render(template, locals, { filename: templatePath, cache: false });
    check('renders cleanly with the route locals', typeof html === 'string' && html.length > 5000);
} catch (err) {
    check('renders cleanly with the route locals', false);
    console.log('         -> ' + err.message);
}
if (!html) {
    console.log('\n' + fail + ' TEST(S) FAILED\n');
    process.exit(1);
}
const flat = html.replace(/\s+/g, ' ');
check('no unrendered EJS tags left', !html.includes('<%') && !html.includes('%>'));

check('Revision No. value is click-to-edit and pre-filled with 08',
    /Revision No\.: <span id="editRevision" class="editable" data-edit="revision" contenteditable="true"[^>]*>08<\/span>/.test(flat));
check('Eff. Date is click-to-edit and pre-filled',
    /id="editEffDate"[^>]*data-edit="date-long"[^>]*>September 28, 2026<\/span>/.test(flat));
check('"Report generated" stamp is click-to-edit and pre-filled',
    /id="editGeneratedAt"[^>]*data-edit="generated"[^>]*>September 28, 2026 at 10:13 AM<\/span>/.test(flat));
check('Covered Month-Year is click-to-edit and pre-filled',
    /id="editPeriod"[^>]*data-edit="period"[^>]*>2026-07-01 to 2026-09-30<\/strong>/.test(flat));
check('every MONTH row label is click-to-edit',
    (html.match(/class="editable month-label"/g) || []).length === months.length);
check('MONTH rows keep their rendered labels',
    ['July 2026', 'August 2026', 'September 2026'].every(function (m) { return flat.includes('>' + m + '</span>'); }));
check('all 3 signatory dates are click-to-edit and pre-filled',
    ['Prepared by', 'Reviewed by', 'Certified by'].every(function (who) {
        return new RegExp('data-edit="date-short" contenteditable="true" spellcheck="false" role="textbox" aria-label="' + who + ' date"[^>]*> 09/28/2026 <').test(flat);
    }));
check('exactly the intended values are editable (no figure cell)',
    (html.match(/contenteditable="true"/g) || []).length === 4 + months.length + 3);
check('Reset edits button + screen-only tip bar present',
    flat.includes('onclick="resetReportEdits()"') && flat.includes('class="edit-tip"'));
check('report header left intact', flat.includes('PSAU-QMS-SF-20') && flat.includes('Page 1 of 1') && flat.includes('CUSTOMER FEEDBACK REPORT'));

console.log('\n[2] print safety + figures untouched');
check('edit affordance is neutralised for print',
    /\.editable,\s*\.editable:hover,\s*\.editable:focus\s*\{[^}]*border-bottom: 0 !important[^}]*background: transparent !important/.test(flat));
check('button bar + tip bar are hidden when printing',
    /\.btn-bar,\s*\.edit-tip\s*\{\s*display: none !important;/.test(flat));
check('monthly count cells beside the label are unchanged',
    /September 2026<\/span> <\/td> <td> 9 <\/td> <td> 2 <\/td> <td> 0 <\/td> <td> 0 <\/td> <td> 1 <\/td> <td> 0 <\/td> <td> 91\.67% <\/td> <td> Outstanding <\/td>/.test(flat));
check('period totals + rating rows still rendered',
    flat.includes('FREQUENCY DIST. FOR THE PERIOD') && flat.includes('PERIOD RATING') &&
    flat.includes('88.57%') && flat.includes('Very Satisfactory'));
check('SQD summary table still rendered', flat.includes('SQD RATINGS SUMMARY') && flat.includes('SQD8'));
check('respondent totals still rendered', flat.includes('Total Respondents') && flat.includes('> 36 <'));

console.log('\n[3] inline edit engine');
const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
const script = scriptMatch ? scriptMatch[1] : '';
check('report script block found', script.length > 2000);
try { new Function(script); check('inline script parses as valid JavaScript', true); }
catch (err) { check('inline script parses as valid JavaScript', false); console.log('         -> ' + err.message); }
check('editor writes text only (no innerHTML)', !script.includes('innerHTML'));

const helperBlock = /\/\* -- report-edit helpers:start -- \*\/([\s\S]*?)\/\* -- report-edit helpers:end -- \*\//.exec(script);
check('helper block is extractable for unit tests', !!helperBlock);
let H = null;
if (helperBlock) {
    H = new Function(helperBlock[1] + '\nreturn { reParseDate: reParseDate, reParsePeriod: reParsePeriod,' +
        ' reFmtLong: reFmtLong, reFmtShort: reFmtShort, reSplitStamp: reSplitStamp,' +
        ' reParseMonthLabel: reParseMonthLabel, reShiftAbsMonth: reShiftAbsMonth,' +
        ' reMonthLabelFromAbs: reMonthLabelFromAbs };')();
}
const pad = function (n) { return String(n).padStart(2, '0'); };
const ymd = function (d) { return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) : 'null'; };
const per = function (input) {
    if (!H) return 'no-helpers';
    const p = H.reParsePeriod(input);
    return p ? ymd(p.start) + '..' + ymd(p.end) : 'null';
};

check('date: 09/30/2026', H && ymd(H.reParseDate('09/30/2026')) === '2026-09-30');
check('date: September 30, 2026', H && ymd(H.reParseDate('September 30, 2026')) === '2026-09-30');
check('date: Sept 30 2026', H && ymd(H.reParseDate('Sept 30 2026')) === '2026-09-30');
check('date: 30 September 2026', H && ymd(H.reParseDate('30 September 2026')) === '2026-09-30');
check('date: impossible day is rejected (02/30/2026)', H && H.reParseDate('02/30/2026') === null);

check('period: "2026-07-01 to 2026-09-30"', per('2026-07-01 to 2026-09-30') === '2026-07-01..2026-09-30');
check('period: "October 2026" (whole month)', per('October 2026') === '2026-10-01..2026-10-31');
check('period: "Oct 2026" (abbreviation)', per('Oct 2026') === '2026-10-01..2026-10-31');
check('period: "2026-10" (ISO month)', per('2026-10') === '2026-10-01..2026-10-31');
check('period: "October-December 2026"', per('October-December 2026') === '2026-10-01..2026-12-31');
check('period: "Q3 2026"', per('Q3 2026') === '2026-07-01..2026-09-30');
check('period: "3rd Quarter 2026"', per('3rd Quarter 2026') === '2026-07-01..2026-09-30');
check('period: "2026" (whole year)', per('2026') === '2026-01-01..2026-12-31');
check('period: "From 2026-07-01"', per('From 2026-07-01') === '2026-07-01..2026-07-01');
check('period: unparseable text changes nothing', per('Overall Total (All Time)') === 'null' && per('') === 'null');

check('anchor rule: dates use the FIRST day of the entered period', per('2026-10-01 to 2026-12-31').split('..')[0] === '2026-10-01');
check('formats: long + short dates', H && H.reFmtLong(new Date(2026, 8, 30)) === 'September 30, 2026' && H.reFmtShort(new Date(2026, 8, 30)) === '09/30/2026');
check('"Report generated" keeps its time when re-dated',
    H && H.reSplitStamp('September 28, 2026 at 10:13 AM').datePart === 'September 28, 2026' &&
    H.reSplitStamp('September 28, 2026 at 10:13 AM').timePart === ' at 10:13 AM' &&
    H.reFmtLong(new Date(2026, 9, 1)) + H.reSplitStamp('September 28, 2026 at 10:13 AM').timePart === 'October 1, 2026 at 10:13 AM');
check('MONTH row labels parse (September 2026)',
    H && H.reParseMonthLabel('September 2026').monthIndex === 8 && H.reParseMonthLabel('September 2026').year === 2026);
check('MONTH rows re-anchor to the period: Jul-Sep 2026 -> Oct-Dec 2026',
    H && [[2026, 6], [2026, 7], [2026, 8]].map(function (row) {
        return H.reMonthLabelFromAbs(H.reShiftAbsMonth(row[0] * 12 + row[1], 2026 * 12 + 6, 2026 * 12 + 9));
    }).join(', ') === 'October 2026, November 2026, December 2026');

console.log('\n[4] DOM behaviour (fake-DOM run of the engine)');
const textWrites = [];
function fakeNode(id, text, attrs, cls) {
    const listeners = {};
    let value = text;
    function fire(type, evt) {
        (listeners[type] || []).forEach(function (fn) {
            fn(evt || { key: '', preventDefault: function () { }, stopPropagation: function () { } });
        });
    }
    const node = {
        id: id, dataset: {},
        classList: { contains: function (c) { return (cls || '').split(' ').indexOf(c) !== -1; } },
        getAttribute: function (name) { return attrs && attrs[name] !== undefined ? attrs[name] : null; },
        addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        blur: function () { fire('blur'); },
        fire: fire
    };
    Object.defineProperty(node, 'textContent', {
        get: function () { return value; },
        set: function (v) { value = String(v); textWrites.push(node); }
    });
    return node;
}
const domNodes = [
    fakeNode('editRevision', '08', { 'data-edit': 'revision' }),
    fakeNode('editEffDate', 'September 28, 2026', { 'data-edit': 'date-long' }),
    fakeNode('editGeneratedAt', 'September 28, 2026 at 10:13 AM', { 'data-edit': 'generated' }),
    fakeNode('editPeriod', '2026-07-01 to 2026-09-30', { 'data-edit': 'period' }),
    fakeNode('', 'July 2026', null, 'month-label'),
    fakeNode('', 'August 2026', null, 'month-label'),
    fakeNode('', 'September 2026', null, 'month-label'),
    fakeNode('sigPreparedDate', '09/28/2026', { 'data-edit': 'date-short' }),
    fakeNode('sigReviewedDate', '09/28/2026', { 'data-edit': 'date-short' }),
    fakeNode('sigCertifiedDate', '09/28/2026', { 'data-edit': 'date-short' })
];
const domById = {};
domNodes.forEach(function (n) { if (n.id) domById[n.id] = n; });
const fakeWindow = {};
const idRequests = [];
const selectors = [];
const fakeDocument = {
    readyState: 'complete',
    getElementById: function (id) { idRequests.push(id); return domById[id] || null; },
    querySelectorAll: function (sel) { selectors.push(sel); return sel === '.editable' ? domNodes : []; },
    addEventListener: function () { },
    execCommand: function () { }
};
try {
    new Function('window', 'document', script)(fakeWindow, fakeDocument);
    check('engine initialises against the report DOM', typeof fakeWindow.resetReportEdits === 'function');
} catch (err) {
    check('engine initialises against the report DOM', false);
    console.log('         -> ' + err.message);
}
const labelText = function (i) { return domNodes[i].textContent; };
const period = domById.editPeriod;

// --- clicking a value and clicking away (no typing) must be a strict no-op: the
// --- generated/realtime date stays exactly what the server rendered.
period.fire('focus');
period.blur();
check('just clicking the Covered Month-Year keeps the generated realtime date',
    domById.editEffDate.textContent === 'September 28, 2026' &&
    domById.editGeneratedAt.textContent === 'September 28, 2026 at 10:13 AM' &&
    domById.sigPreparedDate.textContent === '09/28/2026' && domById.sigCertifiedDate.textContent === '09/28/2026' &&
    labelText(4) === 'July 2026');
const effClick = domById.editEffDate;
effClick.fire('focus');
effClick.blur();
check('just clicking the Eff. Date keeps it as generated', effClick.textContent === 'September 28, 2026');

// --- a real edit (typed by hand) re-dates the sheet
textWrites.length = 0;
period.fire('focus');
period.textContent = '2026-10-01 to 2026-12-31';
period.fire('input');
period.blur();
check('typed Covered Month-Year re-dates Eff. Date (FIRST day)', domById.editEffDate.textContent === 'October 1, 2026');
check('typed Covered Month-Year re-dates "Report generated" and keeps the time',
    domById.editGeneratedAt.textContent === 'October 1, 2026 at 10:13 AM');
check('typed Covered Month-Year re-dates all 3 signatory dates',
    domById.sigPreparedDate.textContent === '10/01/2026' && domById.sigReviewedDate.textContent === '10/01/2026' &&
    domById.sigCertifiedDate.textContent === '10/01/2026');
check('typed Covered Month-Year re-anchors the MONTH rows (first row = period start)',
    labelText(4) === 'October 2026' && labelText(5) === 'November 2026' && labelText(6) === 'December 2026');
check('the engine only ever writes to editable values — no figure cell can change',
    textWrites.length > 0 && textWrites.every(function (n) { return domNodes.indexOf(n) !== -1; }));
check('the engine only ever targets editable values (never a figure cell)',
    idRequests.length > 0 && selectors.every(function (s) { return s === '.editable'; }) &&
    idRequests.every(function (id) { return domNodes.some(function (n) { return n.id === id; }); }));

period.fire('focus');
period.textContent = 'Overall Total (All Time)';
period.fire('input');
period.blur();
check('unparseable Covered Month-Year changes no dates',
    domById.editEffDate.textContent === 'October 1, 2026' && labelText(4) === 'October 2026');
const eff = domById.editEffDate;
eff.fire('focus');
eff.textContent = '01/01/2030';
eff.fire('input');
eff.fire('keydown', { key: 'Escape', preventDefault: function () { }, stopPropagation: function () { } });
check('Escape cancels an in-progress date edit', eff.textContent === 'October 1, 2026');
const rev = domById.editRevision;
rev.fire('focus');
rev.textContent = '9';
rev.fire('input');
rev.blur();
check('revision typed as "9" commits as "09"', rev.textContent === '09');
fakeWindow.resetReportEdits();
check('Reset edits restores every generated value',
    rev.textContent === '08' && domById.editEffDate.textContent === 'September 28, 2026' &&
    domById.editGeneratedAt.textContent === 'September 28, 2026 at 10:13 AM' && labelText(4) === 'July 2026' &&
    domById.sigPreparedDate.textContent === '09/28/2026');

console.log('\n[5] generation contract (quarter picker -> realtime date + quarter data)');
const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
function functionSource(name) {
    const lines = serverSrc.split(/\r?\n/);
    const start = lines.findIndex(function (l) { return l.startsWith('function ' + name + '('); });
    if (start === -1) return '';
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}
const FN = ['getFilterParams', 'matchesOffice', 'filterFeedbacksByParams'];
const fnSrc = FN.map(functionSource).join('\n\n');
check('server filter helpers extracted (' + FN.join(', ') + ')', FN.every(function (n) { return fnSrc.includes('function ' + n + '('); }));
const S = new Function('require', fnSrc +
    '\nreturn { getFilterParams: getFilterParams, filterFeedbacksByParams: filterFeedbacksByParams };')(require);

// The exact params the Quarterly Reports page sends for "3rd Quarter 2026".
const fp = S.getFilterParams({ filterType: 'range', office: 'all', dateFrom: '2026-07-01', dateTo: '2026-09-30' });
check('quarter picker Q3 2026 -> period label "2026-07-01 to 2026-09-30"', fp.periodLabel === '2026-07-01 to 2026-09-30');
check('quarter picker Q3 2026 -> filter bounds cover the full quarter',
    fp.dateFrom.getFullYear() === 2026 && fp.dateFrom.getMonth() === 6 && fp.dateFrom.getDate() === 1 &&
    fp.dateTo.getFullYear() === 2026 && fp.dateTo.getMonth() === 8 && fp.dateTo.getDate() === 30);

const DATASET = [
    { petsa: '2026-06-15', submittedAt: '2026-06-15T02:00:00.000Z', tanggapan: 'Registrar', comment: 'june decoy' },
    { petsa: '2026-07-05', submittedAt: '2026-07-05T02:00:00.000Z', tanggapan: 'Registrar', comment: 'july q3' },
    { petsa: '2026-08-20', submittedAt: '2026-08-20T02:00:00.000Z', tanggapan: 'Cash Unit', comment: 'august q3' },
    { petsa: '2026-09-30', submittedAt: '2026-09-30T02:00:00.000Z', tanggapan: 'Cash Unit', comment: 'september q3' },
    { petsa: '2026-10-01', submittedAt: '2026-10-01T10:00:00.000Z', tanggapan: 'Registrar', comment: 'october decoy' }
];
const q3 = S.filterFeedbacksByParams(DATASET, fp);
check('Q3 2026 generation keeps exactly the quarter data (June / October excluded)',
    q3.length === 3 && q3.map(function (f) { return f.comment; }).join(', ') === 'july q3, august q3, september q3');

// Render the report exactly like the route does when that quarter is generated.
const now = new Date();
const realtimeLong = now.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
const realtimeShort = now.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
const q3Months = ['July', 'August', 'September'].map(function (name, i) {
    const count = i + 1;
    return { name: name, year: 2026, counts: { '5': count, '4': 0, '3': 0, '2': 0, '1': 0, 'N/A': 0 }, valid: count, mean: 5, pct: 100, adj: 'Outstanding' };
});
const q3Overall = { counts: { '5': 3, '4': 0, '3': 0, '2': 0, '1': 0, 'N/A': 0 }, valid: 3, mean: 5, pct: 100, adj: 'Outstanding', positive: 3, validForPct: 3, percentage: 100 };
const q3Html = ejs.render(template, Object.assign({}, locals, {
    months: q3Months,
    overall: q3Overall,
    sqdTotals: Object.assign({}, q3Overall.counts),
    sqdOverallMean: 5, sqdOverallPct: 100, sqdOverallAdj: 'Outstanding',
    respondents: q3.length,
    periodLabel: fp.periodLabel,
    dateFrom: '2026-07-01', dateTo: '2026-09-30',
    effDate: realtimeLong, todayShort: realtimeShort,
    generatedAt: realtimeLong + ' at 10:13 AM',
    preparedDate: realtimeShort, reviewedDate: realtimeShort, certifiedDate: realtimeShort
}), { filename: templatePath, cache: false });
const flatQ3 = q3Html.replace(/\s+/g, ' ');

check('default Eff. Date is the realtime (generation) date',
    new RegExp('id="editEffDate"[^>]*>' + realtimeLong + '</span>').test(flatQ3));
check('default signatory dates are the realtime date',
    (flatQ3.match(new RegExp(realtimeShort.replace(/\//g, '\\/'), 'g')) || []).length >= 3);
check('default Covered Month-Year is the picked quarter',
    /id="editPeriod"[^>]*>2026-07-01 to 2026-09-30<\/strong>/.test(flatQ3));
const respondentsRe = new RegExp('Total Respondents<\\/td> <td style="width:12%; text-align:center; font-weight:800;"> ' + q3.length + ' <\\/td>');
check('default data is the quarter data (respondents + months only)',
    respondentsRe.test(flatQ3) &&
    flatQ3.includes('>July 2026</span>') && flatQ3.includes('>August 2026</span>') &&
    flatQ3.includes('>September 2026</span>') && !flatQ3.includes('>June 2026</span>') &&
    !flatQ3.includes('>October 2026</span>'));

// The route itself must keep filtering + stamping the realtime clock.
const routeStart = serverSrc.indexOf("app.get('/admin/report'");
const routeEnd = serverSrc.indexOf("app.get('/admin/quarterly-reports'", routeStart);
const routeBlock = routeStart === -1 ? '' : serverSrc.slice(routeStart, routeEnd);
check('/admin/report applies the quarter filter before rendering',
    /getFilterParams\(req\.query\)/.test(routeBlock) &&
    /filterFeedbacksByParams\(allFeedbacks, filterParams\)/.test(routeBlock) &&
    /periodLabel: filterParams\.periodLabel/.test(routeBlock));
check('/admin/report stamps the realtime clock as the default dates',
    /const effDate = now\.toLocaleDateString\('en-PH'/.test(routeBlock) &&
    /const generatedAt = now\.toLocaleString\('en-PH'/.test(routeBlock) &&
    /const preparedDate = todayShort/.test(routeBlock));

console.log('\n' + (fail === 0 ? 'ALL TESTS PASSED' : fail + ' TEST(S) FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
