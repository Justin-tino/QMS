/**
 * Render test for views/print-feedback.ejs — the printable FILLED Customer Feedback Form
 * (opened from Detailed Feedback Review → "Print Filled Form").
 * Run: node test-feedback-print.js
 */
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const templatePath = path.join(__dirname, 'views', 'print-feedback.ejs');
const template = fs.readFileSync(templatePath, 'utf8');

// Sample respondent data — mirrors a real Firestore feedback document
const fb = {
    pangalan: 'jack',
    telepono: '09123456789',
    uri_kliyente: 'Gobyerno',
    petsa: '2026-09-23',
    kasarian: 'Lalaki',
    edad: '10',
    rehiyon: 'Region III',
    tanggapan: 'College of Veterinary Medicine',
    uri_transaksyon: 'none',
    cc1: '1',
    cc2: '2',
    cc3: 'N/A',
    sqd0: '3', sqd1: '3', sqd2: '3', sqd3: '3', sqd4: '5', sqd5: 'N/A', sqd6: '3', sqd7: '1', sqd8: '3',
    suggestions: 'Sana po mapabilis ang proseso <script>alert(1)</script>',
    email: 'dsicat313@iskwela.psau.edu.ph',
    avgSQD: '3.00',
    submittedAt: '2026-09-23T02:00:00.000Z'
};

const cc1Options = [
    { value: '1', label: 'Alam ko ang CC at nakita ko ito sa napuntahang opisina' },
    { value: '2', label: 'Alam ko ang CC pero hindi ko ito nakita sa napuntahang opisina' },
    { value: '3', label: 'Nalaman ko ang CC nang makita ko ito sa napuntahang opisina' },
    { value: '4', label: 'Hindi ko alam kung ano ang CC at wala akong nakita sa napuntahang opisina' }
];
const cc2Options = [
    { value: '1', label: 'Madaling makita' }, { value: '2', label: 'Medyo madaling makita' },
    { value: '3', label: 'Mahirap makita' }, { value: '4', label: 'Hindi makita' },
    { value: 'N/A', label: 'N/A' }
];
const cc3Options = [
    { value: '1', label: 'Sobrang nakatulong' }, { value: '2', label: 'Nakatulong naman' },
    { value: '3', label: 'Hindi nakatulong' }, { value: 'N/A', label: 'N/A' }
];
const sqdTexts = [
    'Nasiyahan ako sa serbisyo na aking natanggap sa napuntahan na tanggapan.',
    'Makatawiran ang oras na aking ginugol para sa pagproseso ng aking transaksyon.',
    'Ang opisina ay sumusunod sa mga kinakailangang dokumento at mga hakbang batay sa impormasyong ibinigay.',
    'Ang mga hakbang sa pagproseso, kasama na ang pagbayad ay madali at simple lamang.',
    'Mabilis at madali akong nakahanap ng impormasyon tungkol sa aking transaksyon mula sa opisina o sa website nito.',
    'Nagbayad ako ng makatwirang halaga para sa aking transaksyon. (Kung libre, N/A).',
    'Pakiramdam ko ay patas ang opisina sa lahat, o "walang palakasan".',
    'Magalang akong tinrato ng mga tauhan, at handang tumulong sa akin.',
    'Nakuha ko ang kinakailangan ko mula sa tanggapan ng gobyerno, kung tinanggihan man, ito ay sapat na ipinaliwanag sa akin.'
];
const sqdItems = sqdTexts.map((text, i) => ({ id: 'sqd' + i, code: 'SQD' + i, text }));
const ratingLabels = [
    { value: '1', emoji: '😡', text: 'Lubos na hindi sumasang-ayon' },
    { value: '2', emoji: '🙁', text: 'Hindi sumasang-ayon' },
    { value: '3', emoji: '😐', text: 'Walang kinikilingan' },
    { value: '4', emoji: '🙂', text: 'Sumasang-ayon' },
    { value: '5', emoji: '😍', text: 'Lubos na sumasang-ayon' },
    { value: 'N/A', emoji: '🚫', text: 'N/A' }
];

const html = ejs.render(template, {
    fb,
    feedbackId: 'abc123XYZ',
    officeCode: 'CVM',
    cc1Options, cc2Options, cc3Options, sqdItems, ratingLabels,
    printedBy: 'admin@psau.edu.ph',
    printedRole: 'admin',
    printedAt: 'September 27, 2026, 10:00 AM'
}, { filename: templatePath });

let pass = 0, fail = 0;
function check(label, condition) {
    if (condition) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label); }
}

const flat = html.replace(/\s+/g, ' ');

console.log('\n=== print-feedback.ejs render test ===\n');

check('renders without EJS errors', typeof html === 'string' && html.length > 3000);
check('paper-form look: header title', html.includes('CUSTOMER FEEDBACK FORM'));
check('paper-form look: university subtitle', html.includes('Pampanga State Agricultural University'));
check('paper-form look: control number + office code', html.includes('QMS-CFF-2026') && html.includes('CVM'));
check('respondent name filled', html.includes('value="jack"'));
check('respondent office filled', html.includes('College of Veterinary Medicine'));
check('respondent transaction filled', html.includes('value="none"'));
check('respondent email filled', html.includes('dsicat313@iskwela.psau.edu.ph'));
check('client type answer marked chosen', /radio-option is-chosen/.test(flat));
check('gender answer marked chosen', /radio-option is-chosen/.test(flat));
check('chosen radio options carry checked attribute', (html.match(/type="radio" checked/g) || []).length >= 3);
check('all 9 SQD items rendered', sqdTexts.every(t => html.includes(t.replace(/"/g, '&#34;').replace(/'/g, '&#39;'))));
check('SQD section title present', html.includes('Service Quality Dimensions (SQD 0-8)'));
check('emoji rating cards rendered (6 per SQD = 54)', (html.match(/<label class="emoji-card/g) || []).length === 54);
check('chosen emoji cards highlighted (9 respondents answers)', (html.match(/emoji-card is-chosen/g) || []).length === 9);
check('N/A answer (sqd5) highlighted too', (html.match(/emoji-card is-chosen/g) || []).length === 9);
check('suggestions text rendered', html.includes('Sana po mapabilis ang proseso'));
check('script tag in suggestion is escaped', !html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;'));
check('audit trail with feedback ID', html.includes('abc123XYZ'));
check('printed by / role shown', html.includes('admin@psau.edu.ph') && html.includes('admin'));
check('print stylesheet present', html.includes('@media print') && html.includes('window.print()'));
check('topbar + audit strip hidden when printing', html.includes('.pf-topbar,.audit-strip,.site-footer{display:none !important;}'));
check('uses shared public CSS (same look as form)', html.includes('href="/css/style.css"'));
check('no unrendered EJS tags left', !html.includes('<%') && !html.includes('%>'));

console.log('\n' + (fail === 0 ? 'ALL TESTS PASSED' : fail + ' TEST(S) FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
