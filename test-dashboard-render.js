/**
 * Render test for views/dashboard.ejs — locks the /admin/dashboard locals contract.
 * Regression it guards: the quarter-filter rewrite replaced `clusteredDepartments,` with `availableYears,`
 * in the route's render locals, so the whole page died with
 *   "ReferenceError: dashboard.ejs:1594 ... clusteredDepartments is not defined".
 * Run: node test-dashboard-render.js
 */
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const templatePath = path.join(__dirname, 'views', 'dashboard.ejs');
const template = fs.readFileSync(templatePath, 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (extra ? '\n         -> ' + extra : '')); failures++; }
}

// ---------- 1. the dashboard route must pass every local the template reads ----------
console.log('\n[1] /admin/dashboard render locals');
const renderIdx = serverSrc.indexOf("res.render('dashboard', {");
check('dashboard route found', renderIdx !== -1);
const renderEnd = renderIdx === -1 ? -1 : serverSrc.indexOf('});', renderIdx);
const renderBlock = renderIdx === -1 ? '' : serverSrc.slice(renderIdx, renderEnd + 3);
const REQUIRED_LOCALS = [
  'welcomeRole', 'feedbacks', 'allFeedbacks', 'stats', 'chartData', 'categorizedSqd', 'demographics',
  'aiAnalysis', 'localAnalysis', 'availableOffices', 'selectedOffice', 'filterType', 'periodLabel',
  'monthVal', 'quarterVal', 'selectedYear', 'availableYears', 'clusteredDepartments', 'mlMetrics',
  'userRole', 'adminUser', 'managedUsers', 'dateFrom', 'dateTo'
];
const missing = REQUIRED_LOCALS.filter(k => !new RegExp('(^|[{\\s,])' + k + '\\s*[,:]', 'm').test(renderBlock));
check('every local the template needs is passed (' + REQUIRED_LOCALS.length + ' keys)', missing.length === 0, 'missing: ' + missing.join(', '));

// ---------- 2. real render of the page (same helpers the server uses) ----------
console.log('\n[2] full page render');
// Extract the top-level helpers by line (they close with a '}' at column 0), so we never
// execute neighbouring route registrations (which would need a live express app).
function functionSource(name) {
  const lines = serverSrc.split(/\r?\n/);
  const start = lines.findIndex(l => l.startsWith('function ' + name + '('));
  if (start === -1) return '';
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  return '';
}
const FN_NAMES = ['computeDashboardData', 'computeDepartmentRankings', 'getPerformanceSegment'];
const fnSrc = FN_NAMES.map(functionSource).join('\n\n');
check('dashboard helpers extracted (' + FN_NAMES.join(', ') + ')',
  FN_NAMES.every(n => fnSrc.includes('function ' + n + '(')));
const computed = new Function('require', fnSrc +
  '\nreturn { computeDashboardData, computeDepartmentRankings };')(require);

const DATASET = [
  { petsa: '2026-02-10', tanggapan: 'Cash Unit', sqd0: '5', sqd1: '5', sqd2: '4', sqd3: '5', sqd4: '4', sqd5: '5', sqd6: '5', sqd7: '5', sqd8: '5' },
  { petsa: '2026-02-11', tanggapan: 'Registrar', sqd0: '3', sqd1: '3', sqd2: '3', sqd3: '2', sqd4: '3', sqd5: '3', sqd6: '3', sqd7: '3', sqd8: '3' }
];

function buildLocals(opts) {
  const o = opts || {};
  const dataset = o.dataset || DATASET;
  const { stats, chartData, categorizedSqd, demographics } = computed.computeDashboardData(dataset, dataset);
  const locals = {
    welcomeRole: null,
    feedbacks: dataset,
    allFeedbacks: dataset,
    stats: stats,
    chartData: chartData,
    categorizedSqd: categorizedSqd,
    demographics: demographics,
    aiAnalysis: { summary: '', suggestions: [] },
    localAnalysis: { summary: '', suggestions: [] },
    availableOffices: ['Cash Unit', 'Registrar'],
    selectedOffice: o.selectedOffice || 'all',
    filterType: o.filterType || 'overall',
    periodLabel: o.periodLabel || 'Overall (All Time)',
    monthVal: '',
    quarterVal: o.quarterVal || 'all',
    selectedYear: o.selectedYear || new Date().getFullYear(),
    availableYears: [new Date().getFullYear(), new Date().getFullYear() - 1],
    mlMetrics: require('./naiveBayes').evaluateModel(),
    userRole: 'admin',
    adminUser: 'admin@example.com',
    managedUsers: [],
    dateFrom: '',
    dateTo: '',
    // Provided by middleware via res.locals (not part of the route's render locals)
    csrfToken: 'test-csrf-token'
  };
  if (o.withRankings !== false) locals.clusteredDepartments = computed.computeDepartmentRankings(dataset);
  return locals;
}

try {
  const html = ejs.render(template, buildLocals({}), { filename: templatePath, cache: false });
  check('dashboard renders with clusteredDepartments', true);
  check('office rankings table rendered', html.includes('id="kmeansTableContainer"') && html.includes('Cash Unit') && html.includes('Registrar'));
  check('badge + quarter filter markup present',
    html.includes('id="dashDateBadgeText"') && html.includes('id="dashDatePopover"') && html.includes('id="dashYearSelect"'));
} catch (err) {
  check('dashboard renders with clusteredDepartments', false, err.message);
}

try {
  const html = ejs.render(template, buildLocals({ selectedOffice: 'Cash Unit' }), { filename: templatePath, cache: false });
  check('comparative rank block rendered for a selected office', html.includes('Comparative standing:') && html.includes('Rank #1'));
} catch (err) {
  check('comparative rank block rendered for a selected office', false, err.message);
}

try {
  const html = ejs.render(template, buildLocals({ withRankings: false }), { filename: templatePath, cache: false });
  check('dashboard still renders when clusteredDepartments is missing (defensive guard)', true);
  check('rankings table degrades to the empty state instead of crashing', !html.includes('id="kmeansTableContainer"'));
} catch (err) {
  check('dashboard still renders when clusteredDepartments is missing (defensive guard)', false, err.message);
}

try {
  const y = new Date().getFullYear();
  const html = ejs.render(template, buildLocals({ filterType: 'quarter', quarterVal: 'Q1', selectedYear: y, periodLabel: '1st Quarter ' + y }), { filename: templatePath, cache: false });
  check('quarter filter renders the badge label, hidden inputs and selected year',
    html.includes('1st Quarter ' + y) && html.includes('id="quarterVal"') && html.includes('<option value="' + y + '" selected>'));
} catch (err) {
  check('quarter filter renders the badge label, hidden inputs and selected year', false, err.message);
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
