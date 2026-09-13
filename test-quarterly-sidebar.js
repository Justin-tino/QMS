/**
 * Render test for views/quarterly-report.ejs (AI Assistant page).
 * Verifies the sidebar "Settings" link is present for BOTH admin and staff roles,
 * and "Users" remains admin-only — matching the dashboard sidebar behavior.
 * Run: node test-quarterly-sidebar.js
 */
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const { processQuarterlyData, computeOfficeRankings, computeDimensionAnalysis } = require('./quarterlyReports');

const template = fs.readFileSync(path.join(__dirname, 'views', 'quarterly-report.ejs'), 'utf8');

function buildLocals(userRole) {
  const quarterlyData = processQuarterlyData([], new Date().getFullYear(), null);
  return {
    ...quarterlyData,
    availableOffices: [],
    selectedOffice: 'all',
    selectedQuarterDate: '',
    officeRankings: computeOfficeRankings([]),
    dimensionAnalysis: computeDimensionAnalysis([]),
    userRole,
    adminUser: userRole === 'staff' ? 'staff@gmail.com' : 'admin@gmail.com'
  };
}

function extractSidebar(html) {
  const start = html.indexOf('<nav class="side-nav"');
  const end = html.indexOf('</nav>', start);
  return html.slice(start, end);
}

let failures = 0;
function check(name, cond) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name); failures++; }
}

['staff', 'admin'].forEach(role => {
  console.log('\n=== Role: ' + role + ' ===');
  const html = ejs.render(template, buildLocals(role), { filename: path.join(__dirname, 'views', 'quarterly-report.ejs') });
  const nav = extractSidebar(html).replace(/\s+/g, ' ');
  const count = (needle) => (nav.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

  check('Dashboard link present', count('>Dashboard<') === 1);
  check('Feedback link present', count('>Feedback<') === 1);
  check('QR Codes link present', count('>QR Codes<') === 1);
  check('AI Assistant link present', count('>AI Assistant<') === 1);
  check('Settings link present', count('>Settings<') === 1);
  check('Users link ' + (role === 'admin' ? 'present' : 'ABSENT'), role === 'admin' ? count('>Users<') === 1 : count('>Users<') === 0);
  check('Settings not admin-gated (always rendered)', count('psauTab\',\'settings\'') === 1);
});

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
