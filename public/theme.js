// The colour theme: 'system' (follow the computer), 'light' or 'dark'. This runs before the page draws, so
// there is no flash of the other theme. The choice is kept in this browser, and other windows follow it.
(function () {
  var KEY = 'corkboard.theme';
  var mq = matchMedia('(prefers-color-scheme: dark)');
  function pref() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch (e) { return 'system'; }
  }
  function apply() {
    var p = pref();
    document.documentElement.dataset.theme = p === 'system' ? (mq.matches ? 'dark' : 'light') : p;
    window.dispatchEvent(new Event('themechange'));
  }
  mq.addEventListener('change', apply);
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });
  window.corkboardTheme = {
    get: pref,
    set: function (p) { try { localStorage.setItem(KEY, p); } catch (e) { /* storage unavailable */ } apply(); },
  };
  apply();
  // The system, for the styles and the key names: 'mac', 'win' or 'other'.
  var os = /Mac|iP(hone|ad|od)/.test(navigator.platform) ? 'mac' : /Win/.test(navigator.platform) ? 'win' : 'other';
  document.documentElement.dataset.os = os;
  // The page names the keys of a Mac. On other systems: Ctrl and Alt.
  if (os !== 'mac') {
    document.addEventListener('DOMContentLoaded', function () {
      var fix = function (t) { return t.replace(/⌘\+?/g, 'Ctrl+').replace(/⌥\+?/g, 'Alt+').replace(/\+(?=[\s)]|$)/g, ''); };
      document.querySelectorAll('kbd').forEach(function (k) { if (/[⌘⌥]/.test(k.textContent)) k.textContent = fix(k.textContent); });
      document.querySelectorAll('[title]').forEach(function (n) { if (/[⌘⌥]/.test(n.title)) n.title = fix(n.title); });
    });
  }
})();
