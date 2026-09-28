/**
 * Verification script for the Quarter + Year date filter (dashboard date filter).
 * Run: node test-quarter-filter.js
 *
 * Covers:
 *  1) server.js getFilterParams() — quarter/year handling (Q1-Q4 + "all" = whole year),
 *     and backwards compatibility for overall / month / range filters.
 *  2) views/dashboard.ejs — template compiles, and the new quarter popover + badge
 *     render the expected labels/markup for a quarter filter.
 *  3) Inline dashboard JS (the main script block) still parses after the rewrite.
 *  4) views/quarterly-report.ejs — read-only mirror of the dashboard filter.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); failures++; }
}
function iso(d) {
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ---------- 1. getFilterParams (server-side quarter filter) ----------
console.log('\n[1] server.js getFilterParams()');
const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const start = serverSrc.indexOf('function getFilterParams(');
const end = serverSrc.indexOf('function matchesOffice(');
if (start === -1 || end === -1 || end <= start) {
  console.error('FAIL: could not locate getFilterParams in server.js');
  process.exit(1);
}
const { getFilterParams } = new Function(serverSrc.slice(start, end) + '\nreturn { getFilterParams };')();

const cases = [
  { q: { filterType: 'quarter', quarter: 'Q1', year: '2026' }, from: '2026-01-01', to: '2026-03-31', label: '1st Quarter 2026' },
  { q: { filterType: 'quarter', quarter: 'Q2', year: '2026' }, from: '2026-04-01', to: '2026-06-30', label: '2nd Quarter 2026' },
  { q: { filterType: 'quarter', quarter: 'Q3', year: '2026' }, from: '2026-07-01', to: '2026-09-30', label: '3rd Quarter 2026' },
  { q: { filterType: 'quarter', quarter: 'Q4', year: '2026' }, from: '2026-10-01', to: '2026-12-31', label: '4th Quarter 2026' },
  { q: { filterType: 'quarter', quarter: 'all', year: '2025' }, from: '2025-01-01', to: '2025-12-31', label: 'All Quarters (Q1-Q4) 2025' }
];
cases.forEach(c => {
  const fp = getFilterParams(c.q);
  check('quarter ' + c.q.quarter + ' ' + c.q.year + ' -> ' + c.from + ' .. ' + c.to,
    iso(fp.dateFrom).startsWith(c.from) && iso(fp.dateTo).startsWith(c.to) && fp.periodLabel === c.label,
    'got ' + iso(fp.dateFrom) + ' .. ' + iso(fp.dateTo) + ' | ' + fp.periodLabel);
  check('  full-day bounds (00:00 / 23:59) for ' + c.q.quarter + ' ' + c.q.year,
    fp.dateFrom && fp.dateTo && fp.dateFrom.getHours() === 0 && fp.dateFrom.getMinutes() === 0 &&
    fp.dateTo.getHours() === 23 && fp.dateTo.getMinutes() === 59,
    iso(fp.dateFrom) + ' .. ' + iso(fp.dateTo));
});

const autoDetect = getFilterParams({ quarter: 'Q3', year: '2026' });
check('auto-detects quarter filter without explicit filterType', autoDetect.filterType === 'quarter' && autoDetect.quarterVal === 'Q3');

const allDefault = getFilterParams({ filterType: 'quarter', year: '2026' });
check('missing quarter = All (whole year)', allDefault.quarterVal === 'all' && iso(allDefault.dateFrom).startsWith('2026-01-01') && iso(allDefault.dateTo).startsWith('2026-12-31'));

const badQuarter = getFilterParams({ filterType: 'quarter', quarter: 'Q9', year: '2026' });
check('invalid quarter falls back to All', badQuarter.quarterVal === 'all' && badQuarter.periodLabel === 'All Quarters (Q1-Q4) 2026');

const badYear = getFilterParams({ filterType: 'quarter', quarter: 'Q1', year: '9999' });
check('out-of-range year falls back to the current year', badYear.selectedYear === new Date().getFullYear());

const nanYear = getFilterParams({ filterType: 'quarter', quarter: 'Q1', year: 'abc' });
check('non-numeric year falls back to the current year', nanYear.selectedYear === new Date().getFullYear());

const noFilter = getFilterParams({});
check('no filter = overall (unchanged)', noFilter.filterType === 'overall' && noFilter.periodLabel === 'Overall Total (All Time)' && !noFilter.dateFrom);

const rangeFilter = getFilterParams({ filterType: 'range', dateFrom: '2026-07-01', dateTo: '2026-07-31' });
check('range filter still works (legacy deep links)', rangeFilter.filterType === 'range' && rangeFilter.periodLabel === '2026-07-01 to 2026-07-31' && iso(rangeFilter.dateFrom).startsWith('2026-07-01'));

const monthFilter = getFilterParams({ filterType: 'month', month: '2026-08' });
check('month filter still works (legacy deep links)', monthFilter.filterType === 'month' && monthFilter.periodLabel === 'August 2026');

const quarterDates = getFilterParams({ filterType: 'quarter', quarter: 'Q3', year: '2026' });
check('quarter filter exposes ISO date strings for report/print From-To', quarterDates.dateFromStr === '2026-07-01' && quarterDates.dateToStr === '2026-09-30');
check('quarter filter keeps a concrete date range for filtering', quarterDates.dateFrom instanceof Date && quarterDates.dateTo instanceof Date);
check('server year list covers the 5 previous years', serverSrc.includes('y >= currentYear - 5'));
const viaQuarterWithDates = getFilterParams({ filterType: 'quarter', quarter: 'Q1', year: '2026', dateFrom: '2026-01-01', dateTo: '2026-03-31' });
check('quarter branch wins over safety-net dates (label stays "1st Quarter 2026")', viaQuarterWithDates.periodLabel === '1st Quarter 2026' && viaQuarterWithDates.dateFromStr === '2026-01-01' && viaQuarterWithDates.dateToStr === '2026-03-31');

// ---------- 2. dashboard.ejs — template + quarter popover UI ----------
console.log('\n[2] views/dashboard.ejs');
const dashPath = path.join(__dirname, 'views', 'dashboard.ejs');
const dashSrc = fs.readFileSync(dashPath, 'utf8');
try {
  ejs.compile(dashSrc, { filename: dashPath });
  check('dashboard.ejs compiles', true);
} catch (err) {
  check('dashboard.ejs compiles', false, err.message);
}

const badgeStart = dashSrc.indexOf('<button type="button" id="dashDateBadge"');
const markerTxt = 'filters dashboard data by quarter</div>';
const markerIdx = dashSrc.indexOf(markerTxt);
if (badgeStart === -1 || markerIdx === -1) {
  check('quarter popover markup present in dashboard.ejs', false);
} else {
  check('quarter popover markup present in dashboard.ejs', true);
  const snippet = dashSrc.slice(badgeStart, markerIdx + markerTxt.length) + '\n</div>';

  const quarterlyLocals = { filterType: 'quarter', dateFrom: '2026-07-01', dateTo: '2026-09-30', periodLabel: '3rd Quarter 2026', availableYears: [2026, 2025, 2024], selectedYear: 2026, quarterVal: 'Q3' };
  const html = ejs.render(snippet, quarterlyLocals);
  check('badge shows the quarter label ("3rd Quarter 2026")', html.includes('>3rd Quarter 2026<'));
  check('renders the four quarter buttons', ['data-quarter="Q1"', 'data-quarter="Q2"', 'data-quarter="Q3"', 'data-quarter="Q4"'].every(s => html.includes(s)));
  check('renders the All (whole year) button', html.includes('All (1st - 4th Quarter)'));
  check('renders the year-only dropdown with the selected year', html.includes('id="dashYearSelect"') && html.includes('<option value="2026" selected>2026</option>') && html.includes('<option value="2025">2025</option>'));
  check('renders Apply (quarter) + Clear actions', html.includes('onclick="applyDashQuarter()"') && html.includes('onclick="clearDashDate()"'));
  check('no legacy calendar input remains in the popover', !html.includes('dashDatePickerInput') && !html.includes('Prev day') && !html.includes('Next day'));

  const overallHtml = ejs.render(snippet, { filterType: 'overall', availableYears: [2026], selectedYear: null, quarterVal: '', periodLabel: 'Overall Total (All Time)' });
  check('badge shows "Overall (All Time)" when no filter is set', overallHtml.includes('>Overall (All Time)<'));

  const allHtml = ejs.render(snippet, { filterType: 'quarter', dateFrom: '2025-01-01', dateTo: '2025-12-31', periodLabel: 'All Quarters (Q1-Q4) 2025', availableYears: [2025, 2026], selectedYear: 2025, quarterVal: 'all' });
  check('badge shows "All Quarters (Q1-Q4) 2025" for the All option', allHtml.includes('>All Quarters (Q1-Q4) 2025<'));

  // Year list must still offer the previous years even when the server did not supply availableYears
  const cy = new Date().getFullYear();
  const expectedYears = [0, 1, 2, 3, 4, 5].map(i => cy - i);
  const noYearsHtml = ejs.render(snippet, { filterType: 'quarter', periodLabel: '3rd Quarter ' + cy, selectedYear: cy, quarterVal: 'Q3' });
  check('year dropdown falls back to current + previous 5 years', expectedYears.every(y => noYearsHtml.includes('<option value="' + y + '"')));
  check('fallback year list is newest-first', noYearsHtml.indexOf('value="' + cy + '"') < noYearsHtml.indexOf('value="' + (cy - 5) + '"'));

  const oldYearHtml = ejs.render(snippet, { filterType: 'quarter', periodLabel: '3rd Quarter 2019', availableYears: [cy], selectedYear: 2019, quarterVal: 'Q3' });
  check('selected year is always present in the dropdown', oldYearHtml.includes('<option value="2019" selected>2019</option>'));

  const manyYears = ejs.render(snippet, { filterType: 'quarter', periodLabel: '3rd Quarter 2026', availableYears: [2026, 2025, 2024, 2023, 2022, 2021], selectedYear: 2026, quarterVal: 'Q3' });
  check('server-supplied years (incl. previous years) are listed', ['2026', '2025', '2024', '2023', '2022', '2021'].every(y => manyYears.includes('<option value="' + y + '"')));
}

check('hidden quarter/year filter inputs exist', dashSrc.includes('id="quarterVal"') && dashSrc.includes('id="yearVal"'));
check('visible year dropdown drives the hidden year mirror', dashSrc.includes('id="dashYearSelect" onchange="syncDashYear()"') && dashSrc.includes('function syncDashYear(){'));
check('quarter state reads the visible year dropdown first', dashSrc.includes("getElementById('dashYearSelect')"));
check('popover highlight is re-healed from the URL on load', dashSrc.includes('healQuarterStateFromUrl()'));
check('report modal highlight follows the dashboard filter mode', dashSrc.includes("id=\"modalBtnQuarter\" onclick=\"setModalFilterMode('quarter')\"") && dashSrc.includes("filterType === 'quarter') ? ' active'"));
check('applyFilters sends quarter + year params', dashSrc.includes("params.set('quarter', st.quarter)") && dashSrc.includes("params.set('year', st.year)"));
check('localStorage payload carries quarter/year (AI Assistant follow)', dashSrc.includes('quarter:qv,year:yv'));
check('AI Assistant link honours quarter + year', dashSrc.includes("if(quarter && !u.searchParams.has('quarter'))"));
check('report modal has a Quarter & Year mode', dashSrc.includes('id="modalBtnQuarter"') && dashSrc.includes('id="modalQuarterSelect"') && dashSrc.includes('id="modalQuarterYear"'));
check('quarter Apply also sends the concrete range (works on an un-restarted server)', dashSrc.includes("params.set('dateFrom', st.dateFrom)") && dashSrc.includes("params.set('dateTo', st.dateTo)"));

// ---------- 3. inline dashboard JS still parses ----------
console.log('\n[3] inline dashboard <script> block');
const scriptBlocks = [...dashSrc.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const mainBlock = scriptBlocks.find(b => b.includes('function applyFilters()'));
if (!mainBlock) {
  check('main dashboard script block found', false);
} else {
  check('main dashboard script block found', true);
  // Only EJS output tags live inside scripts (verified) -> neutral placeholder value
  const stripped = mainBlock.replace(/<%[-=][\s\S]*?%>/g, '0');
  try {
    new Function(stripped);
    check('dashboard inline JS parses (after quarter-filter rewrite)', true);
  } catch (err) {
    check('dashboard inline JS parses (after quarter-filter rewrite)', false, err.message);
  }
  check('quarter helpers defined once', (mainBlock.match(/function getQuarterFilterState\(/g) || []).length === 1);
  check('dead day-picker helpers removed', !mainBlock.includes('shiftDashDate') && !mainBlock.includes('applyDashDate') && !mainBlock.includes('dashDatePickerInput'));
}

// ---------- 4. quarterly-report.ejs mirror ----------
console.log('\n[4] views/quarterly-report.ejs');
const qPath = path.join(__dirname, 'views', 'quarterly-report.ejs');
const qSrc = fs.readFileSync(qPath, 'utf8');
try {
  ejs.compile(qSrc, { filename: qPath });
  check('quarterly-report.ejs compiles', true);
} catch (err) {
  check('quarterly-report.ejs compiles', false, err.message);
}
check('quarterly badge mirrors the quarter label from the dashboard filter', qSrc.includes("gf.filterType==='quarter' && gf.badgeText"));

// ---------- 5. end-to-end filtering: does a quarter actually narrow the data? ----------
console.log('\n[5] quarter filter narrows the dataset (getFilterParams + filterFeedbacksByParams)');
const fstart = serverSrc.indexOf('function matchesOffice(');
const fend = serverSrc.indexOf('// Admin: ML Status API');
if (fstart === -1 || fend === -1 || fend <= fstart) {
  check('could not locate filterFeedbacksByParams in server.js', false);
} else {
  const { getFilterParams: gfp, filterFeedbacksByParams } = new Function(
    serverSrc.slice(start, end) + '\n' + serverSrc.slice(fstart, fend) + '\nreturn { getFilterParams, filterFeedbacksByParams };'
  )();
  const mk = (petsa, office) => ({ petsa, tanggapan: office || 'Office of the President', sqd0: '5' });
  const dataset = [
    mk('2025-02-10'), mk('2025-05-10'), mk('2025-08-10'), mk('2025-11-10'),          // 4 x 2025
    mk('2026-02-10'), mk('2026-05-10'), mk('2026-08-10'), mk('2026-11-10'),          // 4 x 2026
    mk('2026-03-15', 'Cash Unit')                                                   // 1 x Q1 2026 (other office)
  ];
  const run = (query) => filterFeedbacksByParams(dataset, gfp(query));

  check('1st Quarter 2026 keeps only Q1 2026 feedback', run({ filterType: 'quarter', quarter: 'Q1', year: '2026' }).length === 2);
  check('2nd Quarter 2026 keeps only Q2 2026 feedback', run({ filterType: 'quarter', quarter: 'Q2', year: '2026' }).length === 1);
  check('3rd Quarter 2026 keeps only Q3 2026 feedback', run({ filterType: 'quarter', quarter: 'Q3', year: '2026' }).length === 1);
  check('4th Quarter 2026 keeps only Q4 2026 feedback', run({ filterType: 'quarter', quarter: 'Q4', year: '2026' }).length === 1);
  check('All (Q1-Q4) 2026 keeps the whole year', run({ filterType: 'quarter', quarter: 'all', year: '2026' }).length === 5);
  check('All (Q1-Q4) 2025 keeps the whole previous year', run({ filterType: 'quarter', quarter: 'all', year: '2025' }).length === 4);
  check('1st Quarter 2025 keeps only Q1 2025 feedback', run({ filterType: 'quarter', quarter: 'Q1', year: '2025' }).length === 1);
  check('quarter + office scope combine', run({ filterType: 'quarter', quarter: 'Q1', year: '2026', office: 'Cash Unit' }).length === 1);
  check('quarter filter never leaks other years', run({ filterType: 'quarter', quarter: 'Q4', year: '2025' }).every(f => String(f.petsa).startsWith('2025-')));
  check('undated feedback is still kept (pre-existing rule)', filterFeedbacksByParams([{ tanggapan: 'Cash Unit', sqd0: '4' }], gfp({ filterType: 'quarter', quarter: 'Q1', year: '2026' })).length === 1);
}

// ---------- 6. simulated "Apply to dashboard" click (client side) ----------
console.log('\n[6] "Apply to dashboard" click path (simulated DOM)');
const hStart = dashSrc.indexOf('// ===== QUARTER FILTER HELPERS');
const hEnd = dashSrc.indexOf('// Shared localStorage payload');
const pEnd = dashSrc.indexOf('function toggleFilterTypeControls()');
const aStart = dashSrc.indexOf('function applyFilters()');
const aEnd = dashSrc.indexOf('// ===== GLOBAL DATE FOLLOWER');
if (hStart === -1 || hEnd === -1 || pEnd === -1 || aStart === -1 || aEnd === -1) {
  check('could not slice the client-side filter functions', false);
} else {
  const clientCode = dashSrc.slice(hStart, hEnd) + '\n' + dashSrc.slice(hEnd, pEnd) + '\n' + dashSrc.slice(aStart, aEnd);
  function simulate(opts) {
    const els = {};
    ['filterTypeSelect', 'quarterVal', 'yearVal', 'dateFrom', 'dateTo', 'monthFilter', 'officeFilter', 'headerOfficeFilter', 'dashDateBadgeText'].forEach(id => {
      els[id] = { id, value: '', textContent: '', style: {}, getAttribute: () => null };
    });
    els.filterTypeSelect.value = opts.filterType || 'overall';
    els.quarterVal.value = opts.quarter || 'all';
    els.yearVal.value = String(opts.year || new Date().getFullYear());
    els.officeFilter.value = opts.office || 'all';
    els.headerOfficeFilter.value = opts.office || 'all';
    const store = {};
    const documentStub = { getElementById: (id) => els[id] || null, querySelectorAll: () => [] };
    const localStorageStub = { setItem: (k, v) => { store[k] = v; }, getItem: (k) => (store[k] || null) };
    const windowStub = { location: { href: '' } };
    const api = new Function('document', 'window', 'localStorage', 'toggleFilterTypeControls', 'showGlobalTimer', 'setTimeout',
      clientCode + '\nreturn { applyDashQuarter, selectDashQuarter, getQuarterFilterState };'
    )(documentStub, windowStub, localStorageStub, () => {}, () => {}, (cb) => cb()); // setTimeout fires immediately
    if (opts.selectedQuarter) api.selectDashQuarter(opts.selectedQuarter);
    api.applyDashQuarter();
    return { url: windowStub.location.href, payload: JSON.parse(store['psau_global_dateFilter'] || '{}') };
  }

  const q1 = simulate({ selectedQuarter: 'Q1', year: 2026 });
  check('"1st Quarter" + Apply navigates as a quarter filter (not Overall)', q1.url.includes('filterType=quarter') && !q1.url.includes('overall'), q1.url);
  check('Apply sends quarter + year', q1.url.includes('quarter=Q1') && q1.url.includes('year=2026'), q1.url);
  check('Apply sends the concrete Q1 range (safety net for older servers)', q1.url.includes('dateFrom=2026-01-01') && q1.url.includes('dateTo=2026-03-31'), q1.url);
  check('follower payload stores the 1st Quarter filter', q1.payload.filterType === 'quarter' && q1.payload.quarter === 'Q1' && q1.payload.year === '2026' && q1.payload.badgeText === '1st Quarter 2026', JSON.stringify(q1.payload));

  const q4 = simulate({ selectedQuarter: 'Q4', year: 2023 });
  check('4th Quarter 2023 -> Oct 1 - Dec 31, 2023', q4.url.includes('quarter=Q4') && q4.url.includes('year=2023') && q4.url.includes('dateFrom=2023-10-01') && q4.url.includes('dateTo=2023-12-31'), q4.url);

  const allQ = simulate({ selectedQuarter: 'all', year: 2026 });
  check('All (Q1-Q4) -> whole-year range', allQ.url.includes('quarter=all') && allQ.url.includes('dateFrom=2026-01-01') && allQ.url.includes('dateTo=2026-12-31'), allQ.url);

  const withOffice = simulate({ selectedQuarter: 'Q3', year: 2026, office: 'Cash Unit' });
  check('office scope is preserved with the quarter', withOffice.url.includes('office=Cash+Unit') && withOffice.url.includes('quarter=Q3'), withOffice.url);
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);

