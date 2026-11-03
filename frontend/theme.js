// Loaded in <head> before first paint so the saved theme applies without a flash.
(function () {
  "use strict";
  var KEY = "shield_theme";
  var MODES = ["light", "dark", "system"];
  var PALETTES = [
    { id: "teal", name: "Slate Teal" },
    { id: "crimson", name: "Harvard Crimson" },
    { id: "ocean", name: "Ocean Blue" },
    { id: "forest", name: "Forest Sage" },
  ];
  var root = document.documentElement;
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  var listeners = [];

  function valid(s) {
    return s && MODES.indexOf(s.mode) !== -1 && PALETTES.some(function (p) { return p.id === s.palette; });
  }

  var state = { mode: "system", palette: "teal" };
  try {
    var saved = JSON.parse(localStorage.getItem(KEY));
    if (valid(saved)) state = saved;
  } catch (e) { /* storage unavailable or corrupt: keep defaults */ }

  function resolved() {
    return state.mode === "dark" || (state.mode === "system" && mq.matches) ? "dark" : "light";
  }

  function apply() {
    root.setAttribute("data-theme", resolved());
    root.setAttribute("data-palette", state.palette);
    listeners.forEach(function (fn) { fn(state, resolved()); });
  }

  function set(patch) {
    var next = { mode: patch.mode || state.mode, palette: patch.palette || state.palette };
    if (!valid(next)) return;
    state = next;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode: applies for this page only */ }
    apply();
  }

  var onSystemChange = function () { if (state.mode === "system") apply(); };
  if (mq.addEventListener) mq.addEventListener("change", onSystemChange);
  else if (mq.addListener) mq.addListener(onSystemChange);

  window.ShieldTheme = {
    palettes: PALETTES,
    get: function () { return { mode: state.mode, palette: state.palette, resolved: resolved() }; },
    set: set,
    onChange: function (fn) { listeners.push(fn); },
  };
  apply();
})();
