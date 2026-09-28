/**
 * Render + behaviour test for the AI Assistant page (views/quarterly-report.ejs).
 * Verifies the "Report date" calendar was replaced by the Quarter + Year picker
 * (same pattern as the dashboard filter): quarter buttons + year dropdown, no day picker.
 * Run: node test-quarterly-quarter-picker.js
 */
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const { processQuarterlyData, computeOfficeRankings, computeDimensionAnalysis } = require('./quarterlyReports');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (extra ? '\n         -> ' + extra : '')); failures++; }
}

const templatePath = path.join(__dirname, 'views', 'quarterly-report.ejs');
const template = fs.readFileSync(templatePath, 'utf8');

function buildLocals(overrides) {
  const quarterlyData = processQuarterlyData([], 2025, 'Q3');
  return {
    ...quarterlyData,
    availableOffices: [],
    selectedOffice: 'all',
    selectedQuarterDate: '',
    officeRankings: computeOfficeRankings([]),
    dimensionAnalysis: computeDimensionAnalysis([]),
    userRole: 'admin',
    adminUser: 'admin@gmail.com',
    ...overrides
  };
}

// ---------- 1. template source: no calendar / day picker left ----------
console.log('\n[1] views/quarterly-report.ejs source');
try {
  ejs.compile(template, { filename: templatePath });
  check('quarterly-report.ejs compiles', true);
} catch (err) {
  check('quarterly-report.ejs compiles', false, err.message);
}
check('no legacy day picker input (quarterDatePickerInput)', !template.includes('quarterDatePickerInput'));
check('no legacy report date input (aiReportDate)', !template.includes('aiReportDate'));
check('day-shift helpers removed', !template.includes('shiftQuarterDate') && !template.includes('applyQuarterDate') && !template.includes('isValidYMDQ'));
check('no type="date" calendar left on the page', !/type="date"/.test(template));
check('quarter picker helpers defined once', (template.match(/function toggleQuarterPicker\(/g) || []).length === 1);
check('dashboard mirror keeps the quarter-label branch', template.includes("gf.filterType==='quarter' && gf.badgeText"));

// ---------- 2. rendered markup: quarter + year picker ----------
console.log('\n[2] rendered AI Assistant header (Q3 2025)');
const html = ejs.render(template, buildLocals({}), { filename: templatePath });
check('badge shows the server-side quarter label', html.includes('>3rd Quarter 2025<'));
check('badge opens the picker', html.includes('id="quarterDateBadge"') && html.includes('onclick="toggleQuarterPicker()"'));
check('four quarter buttons rendered', ['Q1', 'Q2', 'Q3', 'Q4'].every(q => html.includes('data-quarter="' + q + '" onclick="selectQuarterPicker(\'' + q + '\')"')));
check('All (whole year) quarter button rendered', html.includes('data-quarter="all" onclick="selectQuarterPicker(\'all\')"'));
check('year dropdown rendered (no calendar)', html.includes('id="quarterYearSelect" onchange="syncQuarterPickerYear()"'));
check('selected year is marked in the dropdown', html.includes('<option value="2025" selected>2025</option>'));
check('server-supplied years are listed (newest-first)', (() => {
  const y26 = html.indexOf('<option value="2026"'), y24 = html.indexOf('<option value="2024"');
  return y26 !== -1 && y24 !== -1 && y26 < y24;
})());
const cyNow = new Date().getFullYear();
const noYearsHtml = ejs.render(template, buildLocals({ availableYears: undefined }), { filename: templatePath });
check('year dropdown falls back to current + previous 5 years',
  [0, 1, 2, 3, 4, 5].every(i => noYearsHtml.includes('<option value="' + (cyNow - i) + '"')));
check('hidden quarter/year mirrors rendered', html.includes('id="quarterVal"') && html.includes('id="yearVal"'));
check('popover apply/clear wired to the new helpers', html.includes('onclick="applyQuarterPicker()"') && html.includes('onclick="clearQuarterPicker()"'));

// ---------- 3. Generate Report follows the page quarter (single control, no separate date field) ----------
console.log('\n[3] Generate Report follows the page filter');
check('separate "Report period" control removed',
  !html.includes('id="aiReportQuarter"') && !html.includes('id="aiReportYear"') && !html.includes('Report period'));
check('report link targets /admin/report', html.includes('id="btnGenerateReport" href="/admin/report?'));
check('report link covers the page quarter range (Q3 2025 -> Jul 1 - Sep 30)', (() => {
  const link = (html.match(/id="btnGenerateReport" href="([^"]+)"/) || [])[1] || '';
  return link.includes('filterType=range') && link.includes('dateFrom=2025-07-01') && link.includes('dateTo=2025-09-30');
})(), (html.match(/id="btnGenerateReport" href="([^"]+)"/) || [])[1]);

// ---------- 4. inline script parses after rendering ----------
console.log('\n[4] inline <script> block');
const scriptBlocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const mainBlock = scriptBlocks.find(b => b.includes('function updateAiReportLink'));
check('quarter picker script block found', !!mainBlock);
if (mainBlock) {
  try {
    new Function(mainBlock);
    check('inline JS parses (after quarter-picker rewrite)', true);
  } catch (err) {
    check('inline JS parses (after quarter-picker rewrite)', false, err.message);
  }
}

// ---------- 5. simulated client behaviour ----------
console.log('\n[5] picker behaviour (simulated DOM)');
function makeEnv(values, href) {
  const els = {};
  Object.keys(values).forEach(id => {
    els[id] = {
      id: id,
      value: values[id],
      textContent: '',
      title: '',
      href: '',
      style: {},
      dataset: {},
      options: [],
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {},
      getAttribute() { return null; },
      appendChild() {},
      addEventListener() {}
    };
  });
  const documentStub = {
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, options: [] }),
    body: { style: {} }
  };
  const localStorageStub = { getItem: () => null, setItem() {} };
  const windowStub = { location: { href: href || 'http://localhost/admin/quarterly-reports?office=Cash+Unit' } };
  const api = new Function('document', 'window', 'localStorage', 'URL', 'URLSearchParams',
    mainBlock + '\nreturn { updateAiReportLink, getQuarterPickerState, getQuarterRangeQ, selectQuarterPicker, syncQuarterPickerYear, applyQuarterPicker, clearQuarterPicker, QRTERM_LABELS };'
  )(documentStub, windowStub, localStorageStub, URL, URLSearchParams);
  return { api, els, window: windowStub };
}

if (mainBlock) {
  const env = makeEnv({ quarterVal: 'Q2', yearVal: '2024', quarterYearSelect: '2024', btnGenerateReport: '', quarterOfficeFilter: 'all' });
  const st = env.api.getQuarterPickerState();
  check('picker state reads quarter + visible year', st.quarter === 'Q2' && st.year === '2024' && st.label === '2nd Quarter 2024', JSON.stringify(st));
  check('Q2 range is Apr 1 - Jun 30', st.dateFrom === '2024-04-01' && st.dateTo === '2024-06-30', st.dateFrom + ' .. ' + st.dateTo);
  check('Q4 range is Oct 1 - Dec 31', (() => { const r = env.api.getQuarterRangeQ('Q4', 2025); return r.from === '2025-10-01' && r.to === '2025-12-31'; })());
  check('All (Q1-Q4) range is the whole year', (() => { const r = env.api.getQuarterRangeQ('all', 2023); return r.from === '2023-01-01' && r.to === '2023-12-31'; })());
  check('unknown quarter falls back to the whole year', (() => { const r = env.api.getQuarterRangeQ('', 2023); return r.from === '2023-01-01' && r.to === '2023-12-31'; })());
  check('All label matches the dashboard wording', env.api.QRTERM_LABELS.all === 'All Quarters (Q1-Q4)');

  env.api.updateAiReportLink();
  check('report link follows the page quarter (Q2 2024 -> Apr 1 - Jun 30)',
    env.els.btnGenerateReport.href.includes('dateFrom=2024-04-01') && env.els.btnGenerateReport.href.includes('dateTo=2024-06-30'),
    env.els.btnGenerateReport.href);
  check('report link keeps the quarter filter type + office',
    env.els.btnGenerateReport.href.includes('filterType=range') && env.els.btnGenerateReport.href.includes('office=all'),
    env.els.btnGenerateReport.href);

  // picking a quarter / changing the year updates the report link immediately (one control only)
  env.api.selectQuarterPicker('Q4');
  check('picking 4th Quarter updates the report link (Oct 1 - Dec 31)',
    env.els.btnGenerateReport.href.includes('dateFrom=2024-10-01') && env.els.btnGenerateReport.href.includes('dateTo=2024-12-31'),
    env.els.btnGenerateReport.href);
  env.els.quarterYearSelect.value = '2023';
  env.api.syncQuarterPickerYear();
  check('changing the year updates the report link (Q4 2023)',
    env.els.btnGenerateReport.href.includes('dateFrom=2023-10-01') && env.els.btnGenerateReport.href.includes('dateTo=2023-12-31'),
    env.els.btnGenerateReport.href);
  env.api.selectQuarterPicker('all');
  check('All (whole year) report link covers Jan 1 - Dec 31',
    env.els.btnGenerateReport.href.includes('dateFrom=2023-01-01') && env.els.btnGenerateReport.href.includes('dateTo=2023-12-31'),
    env.els.btnGenerateReport.href);

  const env2 = makeEnv({ quarterVal: 'Q3', yearVal: '2026', quarterYearSelect: '2023', btnGenerateReport: '', quarterOfficeFilter: 'all' });
  env2.api.selectQuarterPicker('Q4');
  check('selectQuarterPicker writes the hidden quarter', env2.els.quarterVal.value === 'Q4');
  env2.api.applyQuarterPicker();
  check('Apply navigates with quarter + year (no day param)',
    env2.window.location.href.includes('quarter=Q4') && env2.window.location.href.includes('year=2023') && !env2.window.location.href.includes('date='),
    env2.window.location.href);
  check('Apply preserves the office scope', env2.window.location.href.includes('office=Cash+Unit'), env2.window.location.href);

  const env3 = makeEnv({ quarterVal: 'Q1', yearVal: '2026', quarterYearSelect: '2026', btnGenerateReport: '', quarterOfficeFilter: 'all' });
  env3.api.clearQuarterPicker();
  check('Clear drops quarter/year but keeps the office scope',
    !env3.window.location.href.includes('quarter=') && !env3.window.location.href.includes('year=') && env3.window.location.href.includes('office=Cash+Unit'),
    env3.window.location.href);

  const env4 = makeEnv({ quarterVal: 'Q1', yearVal: '2026', quarterYearSelect: '2019', btnGenerateReport: '', quarterOfficeFilter: 'all' });
  env4.api.syncQuarterPickerYear();
  check('visible year dropdown drives the hidden year mirror', env4.els.yearVal.value === '2019');

  // "All (whole year)" must survive the hidden mirror (regression: it used to upper-case to ALL)
  const env5 = makeEnv({ quarterVal: 'Q3', yearVal: '2026', quarterYearSelect: '2025', btnGenerateReport: '', quarterOfficeFilter: 'all' });
  env5.api.selectQuarterPicker('all');
  const allState = env5.api.getQuarterPickerState();
  check('All button keeps the quarter state ("all", not Q1)',
    allState.quarter === 'all' && allState.label === 'All Quarters (Q1-Q4) 2025' && allState.dateFrom === '2025-01-01' && allState.dateTo === '2025-12-31',
    JSON.stringify(allState));
  env5.api.applyQuarterPicker();
  check('Apply with All sends quarter=all + year (whole year)',
    env5.window.location.href.includes('quarter=all') && env5.window.location.href.includes('year=2025') && !env5.window.location.href.includes('date='),
    env5.window.location.href);

  // Deep link with quarter=all must show the whole-year label (not the server's active quarter)
  const env6 = makeEnv(
    { quarterVal: 'Q3', yearVal: '2025', quarterYearSelect: '2025', btnGenerateReport: '', quarterOfficeFilter: 'all', quarterDateBadge: '', quarterDateBadgeText: '' },
    'http://localhost/admin/quarterly-reports?quarter=all&year=2025'
  );
  check('quarter=all deep link shows the whole-year badge label',
    env6.els.quarterDateBadgeText.textContent === 'All Quarters (Q1-Q4) 2025',
    env6.els.quarterDateBadgeText.textContent);
  check('quarter=all deep link keeps the All state in the hidden mirror', env6.els.quarterVal.value === 'all');
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
