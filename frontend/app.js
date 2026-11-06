(function () {
  "use strict";

  var cfg = window.SHIELD_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var loginView = $("login-view"), appView = $("app-view");
  var loginForm = $("login-form"), loginBtn = $("login-btn"), loginStatus = $("login-status");
  var invite = $("invite"), summary = $("summary"), form = $("form"), submit = $("submit");
  var statusEl = $("status"), results = $("results"), empty = $("empty"), loading = $("loading"), side = $("side");
  var turnstileToken = "", turnstileId = null, turnstileReady = false;
  var KEY = "shield_invite";
  $("version").textContent = "Version " + cfg.appVersion + (cfg.releaseDate ? " (" + cfg.releaseDate + ")" : "");

  // All dynamic text goes through text nodes; never innerHTML.
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") el.className = attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
    [].concat(children === undefined ? [] : children).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  function setStatus(el, msg, isError) {
    el.textContent = msg || "";
    el.className = "status" + (isError ? " error" : "");
  }

  function api(path, payload) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body.message || "Request failed (" + res.status + ").");
          err.code = body.error;
          throw err;
        }
        return body;
      });
    });
  }

  /* ---------- Settings (theme) ---------- */

  var settings = $("settings"), palettesEl = $("palettes");
  var cogs = [].slice.call(document.querySelectorAll(".cog"));
  var theme = window.ShieldTheme;

  theme.palettes.forEach(function (p) {
    var btn = h("button", { type: "button", class: "pal", "data-palette-id": p.id, "aria-pressed": "false" }, [
      h("span", { class: "swatch", "data-palette": p.id }, [
        h("i", { class: "s1" }), h("i", { class: "s2" }), h("i", { class: "s3" }), h("i", { class: "s4" }),
      ]),
      h("span", {}, p.name),
    ]);
    btn.addEventListener("click", function () { theme.set({ palette: p.id }); });
    palettesEl.appendChild(btn);
  });
  [].forEach.call(settings.querySelectorAll("[data-mode]"), function (btn) {
    btn.addEventListener("click", function () { theme.set({ mode: btn.getAttribute("data-mode") }); });
  });

  function syncSettings(state, resolved) {
    [].forEach.call(settings.querySelectorAll("[data-mode]"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-mode") === state.mode));
    });
    [].forEach.call(palettesEl.querySelectorAll(".pal"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-palette-id") === state.palette));
      b.querySelector(".swatch").setAttribute("data-theme", resolved);
    });
  }
  theme.onChange(syncSettings);
  syncSettings(theme.get(), theme.get().resolved);

  function setSettingsOpen(open) {
    settings.hidden = !open;
    cogs.forEach(function (c) { c.setAttribute("aria-expanded", String(open)); });
  }
  cogs.forEach(function (c) {
    c.addEventListener("click", function (ev) { ev.stopPropagation(); setSettingsOpen(settings.hidden); });
  });
  document.addEventListener("click", function (ev) {
    if (!settings.hidden && !settings.contains(ev.target)) setSettingsOpen(false);
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !settings.hidden) {
      setSettingsOpen(false);
      var open = cogs.filter(function (c) { return c.offsetParent !== null; })[0];
      if (open) open.focus();
    }
  });

  /* ---------- Views ---------- */

  var toggleCode = $("toggle-code");
  function setCodeVisible(visible) {
    invite.type = visible ? "text" : "password";
    toggleCode.setAttribute("aria-pressed", String(visible));
    toggleCode.setAttribute("aria-label", visible ? "Hide access code" : "Show access code");
  }
  toggleCode.addEventListener("click", function () {
    setCodeVisible(invite.type === "password");
    invite.focus();
  });

  function showLogin(message) {
    sessionStorage.removeItem(KEY);
    appView.hidden = true;
    loginView.hidden = false;
    invite.value = "";
    setCodeVisible(false);
    setStatus(loginStatus, message || "", !!message);
    invite.focus();
  }

  // Daily analyses left for this access code; the counter resets at 00:00 UTC.
  var quotaLimit = 0;
  function setQuota(limit, used) {
    var el = $("quota");
    quotaLimit = limit || 0;
    if (!limit) { el.hidden = true; return; }
    el.hidden = false;
    if (typeof used !== "number") {
      $("q-num").textContent = limit + " / day";
      el.setAttribute("data-level", "10");
      el.setAttribute("data-state", "ok");
      el.querySelector(".q-text").hidden = true;
      return;
    }
    var left = Math.max(limit - used, 0);
    var now = new Date();
    var reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    var msg = left + " of " + limit + " analyses left today. Resets at " +
      reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + " your time.";
    $("q-num").textContent = left + " / " + limit;
    el.querySelector(".q-text").hidden = false;
    el.setAttribute("data-level", String(left > 0 ? Math.max(1, Math.round(left / limit * 10)) : 0));
    el.setAttribute("data-state", left === 0 ? "empty" : left / limit <= 0.2 ? "low" : "ok");
    el.title = msg;
    $("q-sr").textContent = msg;
  }

  function showApp(info) {
    loginView.hidden = true;
    appView.hidden = false;
    setQuota(info && info.daily_quota, info && info.used_today);
    renderTurnstile();
    summary.focus();
  }

  function onTurnstileLoad() {
    turnstileReady = true;
    if (!appView.hidden) renderTurnstile();
  }
  window.onTurnstileLoad = onTurnstileLoad;

  function renderTurnstile() {
    if (!cfg.turnstileSiteKey || !turnstileReady || turnstileId !== null) return;
    turnstileId = window.turnstile.render("#turnstile", {
      sitekey: cfg.turnstileSiteKey,
      callback: function (token) { turnstileToken = token; },
      "expired-callback": function () { turnstileToken = ""; },
    });
  }

  if (cfg.turnstileSiteKey) {
    var s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit";
    s.async = true;
    document.head.appendChild(s);
  }

  /* ---------- Login ---------- */

  loginForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var code = invite.value.trim();
    if (!code) return;
    loginBtn.disabled = true;
    setStatus(loginStatus, "Checking access code...");
    api(cfg.loginPath, { invite_code: code })
      .then(function (info) {
        sessionStorage.setItem(KEY, code);
        setStatus(loginStatus, "");
        showApp(info);
      })
      .catch(function (err) { setStatus(loginStatus, err.message || "Sign-in failed.", true); })
      .then(function () { loginBtn.disabled = false; });
  });

  $("signout").addEventListener("click", function () {
    results.replaceChildren();
    results.hidden = true;
    empty.hidden = false;
    resetSide();
    summary.value = "";
    $("count").textContent = "0";
    setStatus(statusEl, "");
    showLogin();
  });

  // Resume a session after a refresh, or fall back to the login page if the code no longer works.
  var saved = sessionStorage.getItem(KEY);
  if (saved) {
    api(cfg.loginPath, { invite_code: saved }).then(showApp).catch(function () { showLogin(); });
  } else {
    invite.focus();
  }

  /* ---------- Input ---------- */

  summary.addEventListener("input", function () { $("count").textContent = summary.value.length; });
  summary.addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") form.requestSubmit();
  });
  [].forEach.call(document.querySelectorAll("[data-example]"), function (btn) {
    btn.addEventListener("click", function () {
      summary.value = btn.getAttribute("data-example");
      $("count").textContent = summary.value.length;
      summary.focus();
    });
  });

  /* ---------- Rendering ---------- */

  var PENDING = function () { return h("span", { class: "pending" }, "Pending: to be defined"); };

  function isPending(obj, key) { return !!(obj && obj.pending_fields && obj.pending_fields.indexOf(key) !== -1); }
  function isEmpty(v) { return Array.isArray(v) ? v.length === 0 : !v; }

  // A label/value row; shows "Pending" for playbook cells that are still undefined.
  function row(label, value, obj, key, cls) {
    var pending = isPending(obj, key);
    if (isEmpty(value) && !pending) return null;
    var body;
    if (pending) body = PENDING();
    else if (Array.isArray(value)) body = h("div", { class: "pills" }, value.map(function (v) { return h("span", { class: "pill" }, v); }));
    else body = cls ? h("span", { class: cls }, value) : value;
    return h("div", { class: "row" }, [h("dt", {}, label), h("dd", {}, body)]);
  }

  function rows(list) { return h("dl", { class: "rows" }, list.filter(Boolean)); }

  // Collapsible block for long text; skipped when there is nothing to show.
  function more(title, value, obj, key) {
    var pending = isPending(obj, key);
    if (isEmpty(value) && !pending) return null;
    var body;
    if (pending) body = h("div", {}, PENDING());
    else if (Array.isArray(value)) body = h("ul", {}, value.map(function (v) { return h("li", {}, v); }));
    else body = h("div", {}, value);
    return h("details", {}, [h("summary", {}, title), body]);
  }

  function triggerCard(t) {
    var ch = t.channels || {};
    var backup = ["alternate", "contingency", "emergency"].filter(function (k) { return ch[k]; }).map(function (k) {
      return k.charAt(0).toUpperCase() + k.slice(1) + ": " + ch[k];
    });
    return h("article", { class: "card", "data-tone": "internal" }, [
      h("div", { class: "card-head" }, [
        h("span", { class: "id" }, t.id),
        h("div", { class: "card-title" }, t.activates || t.situation || ""),
        t.confidence ? h("span", { class: "badge " + t.confidence }, t.confidence) : null,
      ]),
      t.activates && t.situation ? h("p", { class: "sub" }, t.situation) : null,
      t.evidence ? h("p", { class: "quote" }, "\u201C" + t.evidence + "\u201D") : null,
      rows([
        row("Communication Owner", t.communication_owner, t, "communication_owner"),
        row("Stakeholders", t.stakeholders, t, "stakeholders"),
        row("Channel", ch.primary, t, "channels"),
      ]),
      more("Roles and actions", t.roles_and_actions, t, "roles_and_actions"),
      more("What must be communicated", t.communication_content, t, "communication_content"),
      more("Backup channels", backup),
      more("External communication", t.external_note),
    ]);
  }

  function labelCard(r, tone) {
    return h("article", { class: "card", "data-tone": tone }, [
      h("div", { class: "card-head" }, [
        h("span", { class: "id" }, r.id),
        h("div", { class: "card-title" }, r.external_party || ""),
      ]),
      r.reason ? h("p", { class: "quote" }, r.reason) : null,
      rows([
        row("When", r.trigger, r, "trigger"),
        row("Owner", r.communication_owner, r, "communication_owner"),
        row("Deadline", r.deadline, r, "deadline", "deadline"),
      ]),
      more("What is communicated", r.what_is_communicated, r, "what_is_communicated"),
      more("Legal / policy basis", r.legal_basis, r, "legal_basis"),
    ]);
  }

  function group(id, tone, title, desc, count, content, open) {
    var d = h("details", { class: "group", id: id, "data-tone": tone }, [
      h("summary", {}, [h("h2", {}, title), h("span", { class: "desc" }, desc), h("span", { class: "n" }, String(count))]),
      content,
    ]);
    if (open !== false) d.open = true;
    return d;
  }

  function cardGroup(id, tone, title, desc, items, build) {
    if (!items.length) return null;
    return group(id, tone, title, desc, items.length, h("div", { class: "cards" }, items.map(build)));
  }

  var HORIZONS = [
    { key: "0-1h", title: "First hour", span: "0 to 1 h", icon: "bolt" },
    { key: "1-24h", title: "First 24 hours", span: "1 to 24 h", icon: "calendar" },
    { key: "24-72h", title: "24 to 72 hours", span: "1 to 3 days", icon: "flag" },
  ];
  var ICONS = {
    bolt: ["M13 2 4 14h7l-1 8 9-12h-7l1-8z"],
    calendar: ["M7 3v3M17 3v3M4 9h16", "M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"],
    flag: ["M5 21V4", "M5 4h12l-2.5 4L17 12H5"],
  };

  function icon(name) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    [["viewBox", "0 0 24 24"], ["width", "22"], ["height", "22"], ["fill", "none"], ["stroke", "currentColor"],
      ["stroke-width", "1.8"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]]
      .forEach(function (a) { svg.setAttribute(a[0], a[1]); });
    ICONS[name].forEach(function (d) {
      var p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    });
    return svg;
  }

  function initials(owner) {
    var words = String(owner || "").match(/[A-Za-z]+/g) || [];
    if (!words.length) return "";
    return (words.length > 1 ? words[0].charAt(0) + words[1].charAt(0) : words[0].slice(0, 2)).toUpperCase();
  }

  // Visual timeline of the AI-generated next steps, one stage per time horizon.
  function timeline(data) {
    var steps = data.next_steps || [];
    if (!steps.length) return null;
    var note = data.playbook_coverage === "full" ? "Based on the matched playbook triggers" : "Not part of the playbook";
    var stages = HORIZONS.map(function (hz, i) {
      var items = steps.filter(function (st) { return st.horizon === hz.key; });
      var list = items.length ? h("ul", { class: "tl-steps" }, items.map(function (st) {
        return h("li", {}, [
          h("span", { class: "avatar", title: st.owner || "" }, initials(st.owner) || "\u2022"),
          h("div", {}, [h("span", { class: "a" }, st.action), st.owner ? h("span", { class: "o" }, st.owner) : null]),
        ]);
      })) : h("p", { class: "tl-none" }, "No actions listed for this window.");
      return h("li", { class: "tl-stage", "data-stage": String(i + 1) }, [
        h("div", { class: "tl-nodewrap" }, [
          h("span", { class: "tl-node" }, icon(hz.icon)),
          i < HORIZONS.length - 1 ? h("span", { class: "tl-rail" }) : null,
        ]),
        h("div", { class: "tl-title" }, [
          h("strong", {}, hz.title),
          h("span", { class: "tl-sub" }, hz.span),
          h("span", { class: "tl-n" }, String(items.length)),
        ]),
        list,
      ]);
    });
    return h("section", { class: "timeline", id: "sec-timeline", "data-tone": "steps" }, [
      h("header", { class: "tl-head" }, [
        h("h2", {}, "Response timeline"),
        h("span", { class: "badge ai" }, "AI-generated"),
        h("span", { class: "desc" }, note),
      ]),
      h("ol", { class: "tl-stages" }, stages),
    ]);
  }

  function questionsGroup(data) {
    var qs = data.clarifying_questions || [];
    if (!qs.length) return null;
    var body = h("article", { class: "card", "data-tone": "steps" }, [
      h("ul", { class: "questions" }, qs.map(function (q) { return h("li", {}, q); })),
    ]);
    return group("sec-questions", "steps", "Questions to answer next", "Details that would sharpen the analysis", qs.length, body);
  }

  function alsoLinkedGroup(data) {
    var al = data.also_linked || {};
    var items = [];
    [["phi", "phi"], ["ransom", "ransom"], ["general", "general"]].forEach(function (p) {
      (al[p[0]] || []).forEach(function (r) { items.push(labelCard(r, p[1])); });
    });
    if (!items.length) return null;
    return group("sec-linked", "general", "Also linked in the playbook", "Related to matched triggers, not selected by the analysis",
      items.length, h("div", { class: "cards" }, items), false);
  }

  function factsGrid(facts) {
    var keys = Object.keys(facts || {}).filter(function (k) { return facts[k]; });
    if (!keys.length) return null;
    return h("div", { class: "facts" }, keys.map(function (k) {
      return h("div", { class: "fact" }, [h("span", { class: "k" }, k.replace(/_/g, " ")), h("span", { class: "v" }, String(facts[k]).replace(/_/g, " "))]);
    }));
  }

  function resetSide() {
    side.setAttribute("data-empty", "true");
    side.replaceChildren(h("p", { class: "muted side-hint" }, "Section counts and view options appear here after an analysis."));
  }

  function renderInsufficient() {
    resetSide();
    results.replaceChildren(h("div", { class: "notice" }, [
      h("strong", {}, "No ransomware or cyber incident could be identified in this text. "),
      "Describe what happened in a few sentences: which systems are affected, whether data was stolen, whether there is a ransom demand, and the impact on patient care. No playbook guidance or next steps are shown until then.",
    ]));
  }

  // Right pane: section counts that jump to each section, view controls and analysis details.
  function renderSide(data, entries) {
    var counts = h("ul", { class: "counts" }, entries.map(function (e) {
      var b = h("button", { type: "button", class: "count-row", "data-tone": e.tone }, [
        h("span", { class: "dot" }), h("span", { class: "label" }, e.title), h("span", { class: "n" }, String(e.count)),
      ]);
      b.addEventListener("click", function () {
        if (e.el.tagName === "DETAILS") e.el.open = true;
        e.el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return h("li", {}, b);
    }));

    function tool(label, fn) {
      var b = h("button", { type: "button", class: "tool" }, label);
      b.addEventListener("click", fn);
      return b;
    }
    function setAll(selector, open) {
      [].forEach.call(results.querySelectorAll(selector), function (d) { d.open = open; });
    }

    side.setAttribute("data-empty", "false");
    side.replaceChildren(
      h("h2", {}, "Overview"),
      h("p", { class: "cov" }, ["Playbook coverage ", h("span", { class: "badge " + data.playbook_coverage }, data.playbook_coverage)]),
      h("h3", {}, "Jump to"),
      counts,
      h("h3", {}, "View"),
      h("div", { class: "tools" }, [
        tool("Collapse All", function () { setAll("details.group", false); }),
        tool("Collapse Details", function () { setAll(".card details", false); }),
        tool("Expand All", function () { setAll("details.group", true); }),
        tool("Expand Details", function () { setAll(".card details", true); }),
        tool("Print / Save as PDF", function () { window.print(); }),
      ]),
      h("p", { class: "meta" }, "Analysis " + data.id + (data.playbook_generated_at ? " | playbook generated " + data.playbook_generated_at : ""))
    );
  }

  function render(data) {
    if (data.report_status === "insufficient") return renderInsufficient();

    var tl = timeline(data);
    var sections = [
      cardGroup("sec-internal", "internal", "Internal crisis triggers", "Who to activate and what to communicate inside the organization",
        data.internal_triggers || [], triggerCard),
      cardGroup("sec-phi", "phi", "PHI notifications", "Notification obligations for protected health information",
        data.phi || [], function (r) { return labelCard(r, "phi"); }),
      cardGroup("sec-ransom", "ransom", "Ransom and extortion", "External parties tied to the ransom demand",
        data.ransom || [], function (r) { return labelCard(r, "ransom"); }),
      cardGroup("sec-general", "general", "General external communications", "Other outside parties to inform",
        data.general || [], function (r) { return labelCard(r, "general"); }),
      questionsGroup(data),
      alsoLinkedGroup(data),
    ].filter(Boolean);

    var coverageNote = {
      partial: "The playbook covers only part of this situation. Review the AI-generated next steps for the rest.",
      none: "No playbook trigger matches this situation. The guidance below is AI-generated and is not from the playbook.",
    }[data.playbook_coverage];

    var entries = sections.map(function (sec) {
      return { el: sec, tone: sec.getAttribute("data-tone"), title: sec.querySelector("h2").textContent, count: sec.querySelector(".n").textContent };
    });
    if (tl) entries.unshift({ el: tl, tone: "steps", title: "Response timeline", count: (data.next_steps || []).length });
    renderSide(data, entries);

    var nodes = [
      tl,
      h("article", { class: "panel summary-card" }, [
        h("div", {}, [
          h("h3", {}, "Situation"),
          h("p", {}, data.situation_summary || ""),
        ]),
        factsGrid(data.facts),
      ]),
      coverageNote ? h("div", { class: "notice" }, coverageNote) : null,
      (data.warnings || []).length ? h("div", { class: "notice" }, data.warnings.join(" ")) : null,
    ].concat(sections);
    results.replaceChildren.apply(results, nodes.filter(Boolean));
  }

  window.addEventListener("beforeprint", function () {
    [].forEach.call(results.querySelectorAll("details"), function (d) { d.open = true; });
  });

  /* ---------- Analyze ---------- */

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (cfg.turnstileSiteKey && !turnstileToken) {
      setStatus(statusEl, "Please complete the verification challenge.", true);
      return;
    }
    submit.disabled = true;
    submit.textContent = "Analyzing...";
    setStatus(statusEl, "This can take up to 30 seconds.");
    empty.hidden = true;
    results.hidden = true;
    loading.hidden = false;

    api(cfg.apiPath, {
      summary: summary.value,
      invite_code: sessionStorage.getItem(KEY) || "",
      turnstile_token: turnstileToken,
    })
      .then(function (data) {
        render(data);
        if (data.quota) setQuota(data.quota.limit, data.quota.used);
        loading.hidden = true;
        results.hidden = false;
        setStatus(statusEl, "");
        results.scrollIntoView({ behavior: "smooth", block: "start" });
      })
      .catch(function (err) {
        loading.hidden = true;
        if (err.code === "invalid_invite") return showLogin(err.message);
        if (err.code === "rate_limited" && /access code/i.test(err.message)) setQuota(quotaLimit, quotaLimit);
        results.hidden = results.childNodes.length === 0;
        empty.hidden = !results.hidden;
        setStatus(statusEl, err.message || "Request failed.", true);
      })
      .then(function () {
        submit.disabled = false;
        submit.textContent = "Analyze Incident";
        turnstileToken = "";
        if (turnstileId !== null) window.turnstile.reset(turnstileId);
      });
  });
})();
