/**
 * PSAU Feedback System — Admin UI Engine
 * Language translation layer (English Standard) + Dark/Light theme persistence.
 * Admin pages only — the public feedback form is never affected.
 */
(function () {
  var I18N = {
    en: {
      'nav.dashboard': 'Dashboard',
      'nav.feedback': 'Feedback',
      'nav.qr': 'QR Codes',
      'nav.quarterly': 'AI & Report',
      'nav.users': 'Users',
      'nav.settings': 'Settings',
      'side.logout': 'Logout',
      'role.admin': 'Administrator',
      'role.staff': 'Staff Viewer',
      'dash.title': 'Quality Management System',
      'dash.sub': '',
      'fb.title': 'Customer Feedback Management',
      'fb.sub': 'Review, filter, and manage submitted feedback responses for audit compliance',
      'qr.title': 'Office QR Code Generator',
      'qr.sub': 'Generate unique QR codes for each office feedback form',
      'users.title': 'User Management',
      'users.sub': 'Create and manage employee (staff) accounts',
      'settings.title': 'Settings',
      'settings.sub': 'Backup, security, appearance, and administrative preferences',
      'filter.by': 'Filter by:',
      'filter.all': 'All Offices / Departments (Overall)',
      'filter.overall': 'Overall Total (All Time)',
      'filter.month': 'Specific Month',
      'filter.range': 'Custom Date Range',
      'btn.apply': 'Apply',
      'btn.generateReport': 'Generate Report',
      'btn.showReport': 'Show Report',
      'btn.downloadDocx': 'Download Report (DOCX)',
      'btn.close': 'Close',
      'quick.label': 'Quick period:',
      'quick.7': 'Last 7 days',
      'quick.30': 'Last 30 days',
      'quick.90': 'Last 90 days',
      'quick.year': 'This Year',
      'kpi.responses': 'Total Responses',
      'kpi.avgsqd': 'Average SQD Rating',
      'kpi.positive': 'Positive Sentiment',
      'kpi.cc': 'CC Awareness',
      'kpi.suggestions': 'Suggestions Received',
      'chart.sqd': 'SQD Average Ratings (SQD0 - SQD8)',
      'chart.sentiment': 'Sentiment Distribution',
      'chart.trend': 'Satisfaction Trend by Month',
      'chart.cc1': "CC1 — Citizen's Charter Awareness",
      'chart.cc23': 'CC2 / CC3 — Charter Visibility & Helpfulness',
      'chart.gender': 'Gender Distribution',
      'q.title': 'Automated Quarterly Customer Feedback Report',
      'q.sub': 'ISO 9001:2015 QMS • Quarterly Segmentation Q1-Q4 • Comparative Annual Evaluation',
      'q.summary': 'Quarterly Summary',
      'q.insight': 'Quarterly Insight',
      'q.matrix': 'Annual Comparative Matrix',
      'btn.print': 'Print / PDF',
      'q.quarter': 'Quarter',
      'q.year': 'Year',
      'users.managed': 'Managed Accounts',
      'set.backup.title': 'Data Backup',
      'set.backup.desc': 'Download a full backup of the Firestore database — one structured JSON file per collection, plus a manifest and README. For security, a one-time PIN is sent to your email before every download.',
      'set.backup.send': 'Send Code to Email',
      'set.backup.pin': '6-digit code from your email',
      'set.backup.verify': 'Verify & Download (ZIP)',
      'set.backup.note': 'The download link is single-use and expires in 10 minutes.',
      'set.pw.title': 'Change Password',
      'set.pw.desc': 'Verify your current password, then we email you a secure reset link.',
      'set.pw.current': 'Current password',
      'set.pw.send': 'Send Reset Password Link',
      'set.lang.title': 'Language',
      'set.lang.desc': 'Interface language for the admin panel. The public feedback form is unaffected.',
      'set.theme.title': 'Appearance',
      'set.theme.desc': 'Switch between light and dark mode. Preference is saved on this device.',
      'theme.dark': 'Dark',
      'theme.light': 'Light'
    }
  };

  function getLang() {
    return 'en';
  }
  function t(key) {
    var v = I18N.en[key];
    return v === undefined ? key : v;
  }
  function applyI18n() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var v = t(nodes[i].getAttribute('data-i18n'));
      if (v && v !== nodes[i].getAttribute('data-i18n')) nodes[i].textContent = v;
    }
    var phs = document.querySelectorAll('[data-i18n-placeholder]');
    for (var j = 0; j < phs.length; j++) {
      var pv = t(phs[j].getAttribute('data-i18n-placeholder'));
      if (pv) phs[j].setAttribute('placeholder', pv);
    }
  }
  function setLanguage(lang) {
    try { localStorage.setItem('psau_lang', 'en'); } catch (e) { }
    applyI18n();
    syncButtons();
    try { document.dispatchEvent(new CustomEvent('psau:languagechange', { detail: { lang: 'en' } })); } catch (e) { }
  }
  function getTheme() {
    try { var th = localStorage.getItem('psau_theme'); return th === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; }
  }
  function applyTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') theme = 'light';
    try { localStorage.setItem('psau_theme', theme); } catch (e) { }
    document.documentElement.setAttribute('data-theme', theme);
  }
  function setTheme(theme) {
    applyTheme(theme);
    syncButtons();
  }
  function syncButtons() {
    var langs = document.querySelectorAll('[data-set-lang]');
    for (var i = 0; i < langs.length; i++) langs[i].classList.toggle('active', langs[i].getAttribute('data-set-lang') === 'en');
    var themes = document.querySelectorAll('[data-set-theme]');
    for (var j = 0; j < themes.length; j++) themes[j].classList.toggle('active', themes[j].getAttribute('data-set-theme') === getTheme());
    var isDark = getTheme() === 'dark';
    var icons = document.querySelectorAll('[data-theme-icon]');
    for (var k = 0; k < icons.length; k++) {
      var prevClass = icons[k].className;
      var nextClass = isDark ? 'fas fa-moon' : 'fas fa-sun';
      // keep data-theme-icon attribute, add switching animation if changed
      if (prevClass.indexOf(isDark ? 'fa-moon' : 'fa-sun') === -1) {
        icons[k].classList.add('theme-icon-switching');
        (function (icon) { setTimeout(function () { icon.classList.remove('theme-icon-switching'); }, 520); })(icons[k]);
      }
      icons[k].className = nextClass + (icons[k].classList.contains('theme-icon-switching') ? ' theme-icon-switching' : '');
      // preserve data attribute
      icons[k].setAttribute('data-theme-icon', '');
    }
    var labels = document.querySelectorAll('[data-theme-label]');
    for (var l = 0; l < labels.length; l++) {
      var newText = isDark ? 'Dark Mode' : 'Light Mode';
      if (labels[l].textContent.trim() !== newText) {
        labels[l].classList.add('theme-label-switching');
        (function (el, txt) {
          setTimeout(function () { el.textContent = txt; }, 140);
          setTimeout(function () { el.classList.remove('theme-label-switching'); }, 340);
        })(labels[l], newText);
      } else {
        labels[l].textContent = newText;
      }
    }
    var cards = document.querySelectorAll('.side-theme-card');
    for (var c = 0; c < cards.length; c++) {
      cards[c].classList.add('theme-card-switching');
      (function (card) { setTimeout(function () { card.classList.remove('theme-card-switching'); }, 460); })(cards[c]);
    }
  }
  // Apply saved theme immediately (before first paint of body content)
  applyTheme(getTheme());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applyI18n(); syncButtons(); });
  } else {
    applyI18n(); syncButtons();
  }
  window.PSAU_UI = { t: t, getLang: getLang, setLanguage: setLanguage, applyI18n: applyI18n, getTheme: getTheme, setTheme: setTheme, toggleTheme: function () { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); } };
})();
