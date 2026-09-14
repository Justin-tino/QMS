// Temporary verification script: threshold-based Department Performance Rankings
// Extracts computeDepartmentRankings + getPerformanceSegment from server.js and tests them.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const start = src.indexOf('// Department Performance Rankings');
const end = src.indexOf('// ========== AUTH MIDDLEWARE ==========');
if (start === -1 || end === -1 || end <= start) {
  console.error('FAIL: could not locate computeDepartmentRankings in server.js');
  process.exit(1);
}
const factory = new Function(src.slice(start, end) + '\nreturn { computeDepartmentRankings, getPerformanceSegment };');
const { computeDepartmentRankings, getPerformanceSegment } = factory();

// Sample feedbacks (ratings are '1'-'5' or 'N/A', as stored by the form)
const mk = (name, vals) => {
  const f = { tanggapan: name };
  vals.forEach((v, i) => { f['sqd' + i] = String(v); });
  return f;
};

const feedbacks = [
  mk('All 5s Office', [5, 5, 5, 5, 5, 5, 5, 5, 5]),              // 5.00 -> Outstanding
  mk('All 4s Office', [4, 4, 4, 4, 4, 4, 4, 4, 4]),              // 4.00 -> Outstanding (boundary)
  mk('Mixed Office', [4, 4, 4, 4, 4, 4, 4, 3, 3]),               // 3.78 -> Satisfactory
  mk('All 3s Office', [3, 3, 3, 3, 3, 3, 3, 3, 3]),              // 3.00 -> Satisfactory (boundary)
  mk('Low Office', [2, 2, 2, 2, 2, 2, 2, 2, 2]),                 // 2.00 -> Needs Attention
  { tanggapan: 'No Ratings Office' },                            // neutral 3.0 defaults -> Satisfactory
  { sqd0: '5', sqd1: '5' },                                      // ignored (no tanggapan)
  mk('Partial Office', [5, 'N/A', 4, 'N/A', 4, 5, 4, 'N/A', 5])  // N/A -> neutral 3.0 => 4.00 -> Outstanding
];

const result = computeDepartmentRankings(feedbacks);
console.log(JSON.stringify(result, null, 2));

const expected = [
  ['All 5s Office', '5.00', 'Outstanding Performance (High Avg)'],
  ['All 4s Office', '4.00', 'Outstanding Performance (High Avg)'],
  ['Partial Office', '4.00', 'Outstanding Performance (High Avg)'],
  ['Mixed Office', '3.78', 'Satisfactory Performance (Mid Avg)'],
  ['All 3s Office', '3.00', 'Satisfactory Performance (Mid Avg)'],
  ['No Ratings Office', '3.00', 'Satisfactory Performance (Mid Avg)'],
  ['Low Office', '2.00', 'Needs Attention (Low Avg Ratings)']
];

let failed = 0;
if (result.length !== expected.length) {
  console.error('FAIL: expected 7 departments, got ' + result.length);
  failed++;
}
expected.forEach(([name, avg, seg], i) => {
  const r = result[i];
  if (!r || r.name !== name || r.avgScore !== avg || r.cluster !== seg) {
    console.error('FAIL row ' + i + ': got ' + JSON.stringify(r) + ', expected ' + name + ' ' + avg + ' ' + seg);
    failed++;
  }
});

if (computeDepartmentRankings([]).length !== 0) {
  console.error('FAIL: empty input should yield []');
  failed++;
}

[[4.01, 'Outstanding Performance (High Avg)'],
 [4.0, 'Outstanding Performance (High Avg)'],
 [3.95, 'Satisfactory Performance (Mid Avg)'],
 [3.5, 'Satisfactory Performance (Mid Avg)'],
 [3.0, 'Satisfactory Performance (Mid Avg)'],
 [2.99, 'Needs Attention (Low Avg Ratings)']
].forEach(([v, exp]) => {
  const got = getPerformanceSegment(v);
  if (got !== exp) {
    console.error('FAIL getPerformanceSegment(' + v + '): got "' + got + '", expected "' + exp + '"');
    failed++;
  }
});

if (failed) {
  console.error(failed + ' check(s) FAILED');
  process.exit(1);
}
console.log('ALL CHECKS PASSED');