"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => (s == null ? "" : String(s)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let PROFILE = null, REGIONS = [], PLATFORMS = [], CUR_REGION = null, PICK = {};

function toast(t) { const e = $("toast"); e.textContent = t; e.classList.add("show"); clearTimeout(window.__tt); window.__tt = setTimeout(() => e.classList.remove("show"), 2200); }

async function api(path, body) {
  const opt = { credentials: "same-origin" };
  if (body !== undefined) { opt.method = "POST"; opt.headers = { "Content-Type": "application/json" }; opt.body = JSON.stringify(body); }
  const r = await fetch("/api/" + path, opt).catch(() => null);
  if (!r) return { ok: false, error: "нет связи" };
  if (r.status === 401) { showLogin(); return { ok: false, error: "нужен вход" }; }
  return r.json().catch(() => ({ ok: false }));
}

/* ---------- вход ---------- */
function showLogin() { $("login").classList.remove("hidden"); $("app").classList.add("hidden"); }
async function doLogin() {
  const email = $("li-email").value.trim(), password = $("li-pass").value;
  $("li-err").textContent = "";
  const r = await api("auth/login", { email, password });
  if (!r.ok) { $("li-err").textContent = r.error || "Не удалось войти"; return; }
  await boot();
}
async function doLogout() { await api("auth/logout", {}); location.reload(); }

async function boot() {
  const me = await api("auth/me");
  if (!me.ok) { showLogin(); return; }
  PROFILE = me.profile;
  $("login").classList.add("hidden"); $("app").classList.remove("hidden");
  $("whoami").textContent = (PROFILE.name || PROFILE.email) + (PROFILE.role === "owner" ? " · владелец" : "");
  if (PROFILE.role === "owner") { $("tab-team").classList.remove("hidden"); $("tab-mod").classList.remove("hidden"); }
  const [rg, pl, ru] = await Promise.all([api("regions"), api("platforms"), api("rubrics")]);
  REGIONS = (rg.regions || []); PLATFORMS = (pl.platforms || []); window.RUBRICS = (ru.rubrics || []);
  const sel = $("regionSel"); sel.innerHTML = REGIONS.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  CUR_REGION = REGIONS.length ? REGIONS[0].id : null;
  if (REGIONS.length <= 1) sel.classList.add("hidden");
  switchTab("viral");
}
function onRegionChange() { CUR_REGION = Number($("regionSel").value); renderCurrent(); }

/* ---------- вкладки ---------- */
let TAB = "viral";
function switchTab(t) {
  TAB = t;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  document.querySelectorAll(".pane").forEach((p) => p.classList.add("hidden"));
  $("pane-" + t).classList.remove("hidden");
  renderCurrent();
}
function renderCurrent() {
  if (TAB === "viral") renderViral();
  else if (TAB === "scout") renderScout();
  else if (TAB === "plan") renderPlan();
  else if (TAB === "mod") renderModeration();
  else renderTeam();
}
const ST_NAME = { draft: "Черновик", pending: "На согласовании", approved: "Одобрено", rejected: "Отклонено", published: "Опубликовано" };
function rubName(id) { const r = (window.RUBRICS || []).find((x) => x.id === id); return r ? r.title : ""; }

/* ---------- Вирусное ---------- */
async function renderViral() {
  $("pane-viral").innerHTML = `
    <div class="card">
      <h2>Разбор вирусного ролика</h2>
      <div class="hint">Вставьте ссылку на ролик конкурента (VK / OK / др.) и/или короткое описание. Аналитик разберёт механику, предложит перенос на ваши направления и проверит по ст.24 ФЗ «О рекламе».</div>
      <input id="v-url" placeholder="Ссылка на ролик" style="width:100%;margin-bottom:8px">
      <textarea id="v-note" placeholder="Описание: о чём ролик, что цепляет (по желанию)" style="width:100%;min-height:64px;margin-bottom:8px"></textarea>
      <button class="btn primary" onclick="doAnalyze()">Анализировать</button>
    </div>
    <div class="card">
      <h2>Найденные идеи</h2>
      <div id="ideaList"><div class="empty">Загружаю…</div></div>
    </div>`;
  loadIdeas();
}
async function doAnalyze() {
  const url = $("v-url").value.trim(), note = $("v-note").value.trim();
  if (!url && !note) { toast("Дайте ссылку или описание"); return; }
  toast("Анализирую… 10–20 сек");
  const r = await api("analyze", { region_id: CUR_REGION, url, note });
  if (!r.ok) { toast(r.error || "Не удалось"); return; }
  $("v-url").value = ""; $("v-note").value = "";
  toast("Готово ✓"); loadIdeas();
}
async function loadIdeas() {
  const r = await api("ideas?region_id=" + CUR_REGION);
  const box = $("ideaList"); if (!box) return;
  const list = (r.ideas || []);
  box.innerHTML = list.length ? list.map(ideaCard).join("") : `<div class="empty">Пока пусто. Разберите первый ролик выше ↑</div>`;
}
function ideaCard(row) {
  const c = row.data || {}, cm = c.compliance || {};
  const ok = cm.art24_ok !== false;
  const cbadge = ok ? `<span class="badge ok">ст.24 ок</span>` : `<span class="badge bad">ст.24: ${esc((cm.flags || []).join("; "))}</span>`;
  const ebadge = cm.needs_erid ? `<span class="badge ad">реклама · нужен erid</span>` : `<span class="badge org">органика</span>`;
  const apps = (c.applicability || []).map((a) => `<div>• <b>${esc(a.direction)}:</b> ${esc(a.idea)}</div>`).join("");
  const src = row.source_url ? ` · <a href="${esc(row.source_url)}" target="_blank" rel="noopener">источник</a>` : "";
  return `<div class="idea">
    <div class="theme">${esc(c.theme || "—")}</div>
    <div class="meta">${cbadge} ${ebadge} · ${esc(c.verdict || "")}${src}</div>
    <div class="line"><b>Хук:</b> ${esc(c.hook || "")}</div>
    <div class="line"><b>Структура:</b> ${esc(c.structure || "")}</div>
    ${c.why_viral ? `<div class="line"><b>Почему зашло:</b> ${esc(c.why_viral)}</div>` : ""}
    ${apps ? `<div class="apps"><b>Перенос на направления:</b>${apps}</div>` : ""}
    <div class="actions">
      <button class="btn ghost sm" onclick='toPlan(${row.id})'>→ В контент-план</button>
      <button class="link" onclick="delIdea(${row.id})">Удалить</button>
    </div>
  </div>`;
}
async function delIdea(id) { const r = await api("ideas/delete", { id }); toast(r.ok ? "Удалено ✓" : "Не удалось"); loadIdeas(); }

/* ---------- Разведка (мультиплатформа) ---------- */
let SCOUT_PLATS = [], SCOUT_READY = {};
async function renderScout() {
  const pr = await api("scout/platforms");
  SCOUT_PLATS = pr.platforms || []; SCOUT_READY = pr.ready || {};
  const opts = SCOUT_PLATS.map((p) => `<option value="${p.key}">${esc(p.name)}${p.auto ? "" : " — вручную"}</option>`).join("");
  const auto = SCOUT_PLATS.filter((p) => p.auto).map((p) => p.name + (SCOUT_READY[p.key] === false ? " (нет ключа)" : "")).join(", ");
  $("pane-scout").innerHTML = `
    <div class="card">
      <h2>Источники — аккаунты и каналы конкурентов</h2>
      <div class="hint">Добавляй любые публичные аккаунты/каналы из любой сети. Авто-сбор роликов сейчас: <b>${esc(auto)}</b>. Для остальных сетей (Instagram, TikTok, Telegram, OK) добавляй сам источник, а конкретные ролики разбирай по ссылке во вкладке «Вирусное» — смотреть чужой контент не запрещено.</div>
      <div class="row">
        <select id="s-plat" style="flex:1">${opts}</select>
        <input id="s-url" placeholder="Ссылка на аккаунт / канал / сообщество" style="flex:3">
        <button class="btn ghost" onclick="addSource()">Добавить</button>
      </div>
      <div id="srcList" style="margin-top:10px"><div class="empty">Загружаю…</div></div>
      <div style="margin-top:12px"><button class="btn primary" onclick="runScout()">🔎 Собрать свежие ролики</button>
        <span id="scoutHint" class="hint" style="margin-left:10px"></span></div>
    </div>
    <div class="card">
      <h2>Найденные ролики (по вовлечённости)</h2>
      <div id="scoutList"><div class="empty">Загружаю…</div></div>
    </div>`;
  loadSources(); loadScout();
}
function platName(k) { const p = SCOUT_PLATS.find((x) => x.key === k); return p ? p.name : k; }
async function loadSources() {
  const r = await api("sources?region_id=" + CUR_REGION);
  const box = $("srcList"); if (!box) return;
  const list = (r.sources || []);
  box.innerHTML = list.length ? list.map((s) =>
    `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--line)">
      <span class="badge org">${esc(platName(s.platform))}</span>
      <b>${esc(s.name || s.url)}</b>
      <span style="color:var(--muted);font-size:13px">${esc(s.url)}</span>
      <button class="link" style="margin-left:auto" onclick="delSource(${s.id})">убрать</button>
    </div>`).join("") : `<div class="empty">Источников пока нет.</div>`;
}
async function addSource() {
  const url = $("s-url").value.trim(), platform = $("s-plat").value;
  if (!url) { toast("Вставь ссылку"); return; }
  const r = await api("sources/add", { region_id: CUR_REGION, url, platform });
  if (!r.ok) { toast(r.error || "Не удалось"); return; }
  $("s-url").value = ""; toast("Добавлено ✓"); loadSources();
}
async function delSource(id) { const r = await api("sources/delete", { id }); toast(r.ok ? "Убрано ✓" : "Не удалось"); loadSources(); }
async function runScout() {
  toast("Собираю ролики… это может занять минуту");
  const r = await api("scout/run", { region_id: CUR_REGION });
  if (!r.ok) { toast(r.error || "Не удалось"); return; }
  toast(`Собрано роликов: ${r.found}`);
  const sk = (r.skipped || []);
  $("scoutHint").textContent = sk.length ? "Авто-сбор не поддержан для: " + sk.join(", ") + " — эти ролики добавляй по ссылке во «Вирусном»." : "";
  loadScout();
}
async function loadScout() {
  const r = await api("scout?region_id=" + CUR_REGION);
  const box = $("scoutList"); if (!box) return;
  const list = (r.scout || []);
  if (!list.length) { box.innerHTML = `<div class="empty">Пока пусто. Добавь источники и нажми «Собрать».</div>`; return; }
  box.innerHTML = list.map((v) =>
    `<div class="idea">
      <div class="meta"><span class="badge org">${esc(platName(v.platform))}</span> <b>ER ${v.er}%</b> · 👍 ${v.likes} · 🔁 ${v.reposts} · 💬 ${v.comments}${v.views ? " · 👁 " + v.views : ""} · ${esc(v.source_name)} · ${esc(v.post_date)}</div>
      <div class="line">${esc((v.text || "").slice(0, 200)) || "<span style='color:var(--muted)'>без текста</span>"}</div>
      <div class="actions">
        <a class="btn ghost sm" href="${esc(v.post_url)}" target="_blank" rel="noopener">Открыть</a>
        <button class="btn primary sm" onclick="analyzeScout(${v.id})" ${v.analyzed ? "disabled" : ""}>${v.analyzed ? "разобрано ✓" : "Разобрать → идея"}</button>
        <button class="link" onclick="delScout(${v.id})">удалить</button>
      </div>
    </div>`).join("");
}
async function analyzeScout(id) {
  toast("Разбираю ролик… 10–20 сек");
  const r = await api("scout/analyze", { id });
  if (!r.ok) { toast(r.error || "Не удалось"); return; }
  toast("Идея создана ✓ — смотри вкладку «Вирусное»"); loadScout();
}
async function delScout(id) { const r = await api("scout/delete", { id }); toast(r.ok ? "Удалено ✓" : "Не удалось"); loadScout(); }

/* ---------- Контент-план ---------- */
async function toPlan(ideaId) {
  const r = await api("ideas?region_id=" + CUR_REGION);
  const row = (r.ideas || []).find((x) => x.id === ideaId);
  const c = row ? row.data : {};
  switchTab("plan");
  setTimeout(() => {
    if ($("p-title")) $("p-title").value = (c && c.theme) || "";
    if ($("p-text")) $("p-text").value = (c && c.applicability && c.applicability[0] ? c.applicability[0].idea : "");
    window.__planCompliance = c && c.compliance || {};
    window.__planIdeaId = ideaId;
    toast("Идея перенесена в форму плана ↓");
  }, 60);
}
async function renderPlan() {
  PICK = {};
  const plats = PLATFORMS.map((p) => `<div class="plat ${p.active ? "" : "dis"}" data-k="${p.key}" onclick="${p.active ? `togglePlat('${p.key}',this)` : ""}">
      ${esc(p.name)}${p.active ? "" : ` <small>· ${esc(p.note)}</small>`}</div>`).join("");
  $("pane-plan").innerHTML = `
    <div class="card">
      <h2>Подключение соцсетей (автопостинг)</h2>
      <div class="hint">Подключи сообщества VK/OK, чтобы платформа публиковала по расписанию. VK: токен сообщества с правом «Управление» + ID группы. OK: токен приложения + ID группы (нужны OK_APP_KEY/OK_APP_SECRET на сервере).</div>
      <div id="socialBox"><div class="empty">Загружаю…</div></div>
      <div class="row" style="margin-top:8px">
        <select id="sc-plat"><option value="vk">VK</option><option value="ok">OK</option></select>
        <input id="sc-token" placeholder="Токен доступа" style="flex:2">
        <input id="sc-gid" placeholder="ID группы (число)" style="flex:1">
        <button class="btn ghost" onclick="connectSocial()">Подключить</button>
      </div>
    </div>
    <div class="card">
      <h2>Запланировать публикацию</h2>
      <div class="hint">Собери пост, выбери площадки и дату/время — платформа опубликует автоматически (VK; OK после настройки приложения). Пока публикуется текст; медиа/видео во вложении — следующий шаг.</div>
      <input id="p-title" placeholder="Заголовок / тема" style="width:100%;margin-bottom:8px">
      <textarea id="p-text" placeholder="Текст поста / сценарий" style="width:100%;min-height:90px;margin-bottom:8px"></textarea>
      <div class="row" style="margin-bottom:8px">
        <select id="p-rubric" style="flex:1"><option value="">Рубрика (по желанию)</option>${(window.RUBRICS || []).map((r) => `<option value="${r.id}">${esc(r.title)}</option>`).join("")}</select>
      </div>
      <div class="plats">${plats}</div>
      <div class="row">
        <input id="p-date" type="date">
        <input id="p-time" type="time">
        <select id="p-status"><option value="draft">Черновик</option><option value="pending">Отправить на согласование</option></select>
      </div>
      <div style="margin-top:10px"><button class="btn primary" onclick="addPlan()">Добавить в план</button></div>
    </div>
    <div class="card">
      <h2>Контент-план региона</h2>
      <div id="planList"><div class="empty">Загружаю…</div></div>
    </div>`;
  loadSocial(); loadPlan();
}
async function loadSocial() {
  const r = await api("social?region_id=" + CUR_REGION);
  const box = $("socialBox"); if (!box) return;
  const list = (r.social || []);
  box.innerHTML = list.length ? list.map((s) =>
    `<div style="display:flex;align-items:center;gap:8px;padding:4px 0">
      <span class="badge st-ready">${esc(s.platform.toUpperCase())} подключён</span>
      <span style="color:var(--muted);font-size:13px">группа ${esc(s.group_id || "—")}</span>
      <button class="link" style="margin-left:auto" onclick="disconnectSocial('${esc(s.platform)}')">отключить</button>
    </div>`).join("") : `<div class="empty">Ничего не подключено.</div>`;
}
async function connectSocial() {
  const platform = $("sc-plat").value, token = $("sc-token").value.trim(), group_id = $("sc-gid").value.trim();
  if (!token || !group_id) { toast("Нужны токен и ID группы"); return; }
  const r = await api("social/connect", { region_id: CUR_REGION, platform, token, group_id });
  if (!r.ok) { toast(r.error || "Не удалось"); return; }
  $("sc-token").value = ""; $("sc-gid").value = ""; toast("Подключено ✓"); loadSocial();
}
async function disconnectSocial(platform) {
  const r = await api("social/disconnect", { region_id: CUR_REGION, platform });
  toast(r.ok ? "Отключено ✓" : "Не удалось"); loadSocial();
}
async function publishNow(id) {
  toast("Публикую…");
  const r = await api("plan/publish", { id });
  toast(r.ok ? "Опубликовано ✓" : (r.error || "Не удалось")); loadPlan();
}
function togglePlat(k, elx) { PICK[k] = !PICK[k]; elx.classList.toggle("on", !!PICK[k]); }
async function addPlan() {
  const title = $("p-title").value.trim(), text = $("p-text").value.trim();
  const platforms = Object.keys(PICK).filter((k) => PICK[k]);
  if (!title) { toast("Добавьте заголовок"); return; }
  if (!platforms.length) { toast("Выберите хотя бы одну площадку"); return; }
  const r = await api("plan/add", {
    region_id: CUR_REGION, title, text, platforms,
    date: $("p-date").value, time: $("p-time").value, status: $("p-status").value,
    rubric_id: ($("p-rubric") && $("p-rubric").value) ? Number($("p-rubric").value) : null,
    idea_id: window.__planIdeaId || null, compliance: window.__planCompliance || {}
  });
  if (!r.ok) { toast(r.error || "Не удалось"); return; }
  $("p-title").value = ""; $("p-text").value = ""; window.__planIdeaId = null; window.__planCompliance = null;
  toast("В плане ✓"); loadPlan();
}
async function loadPlan() {
  const r = await api("plan?region_id=" + CUR_REGION);
  const box = $("planList"); if (!box) return;
  const list = (r.plan || []);
  if (!list.length) { box.innerHTML = `<div class="empty">План пуст. Добавьте публикацию выше ↑</div>`; return; }
  const isOwner = PROFILE.role === "owner";
  box.innerHTML = `<table><thead><tr><th>Дата</th><th>Тема</th><th>Площадки</th><th>Статус</th><th></th></tr></thead><tbody>${
    list.map((p) => {
      const pl = (p.platforms || []).map((k) => (PLATFORMS.find((x) => x.key === k) || { name: k }).name).join(", ");
      const when = (p.plan_date || "—") + (p.plan_time ? " " + p.plan_time : "");
      const rub = p.rubric_id ? `<div style="font-size:12px;color:var(--muted);margin-top:2px">рубрика: ${esc(rubName(p.rubric_id))}</div>` : "";
      const pub = p.published_url ? `<div style="font-size:12px;margin-top:3px"><a href="${esc(p.published_url)}" target="_blank" rel="noopener">опубликовано ↗</a></div>` : "";
      const perr = p.publish_error ? `<div style="font-size:12px;color:var(--red);margin-top:3px">${esc(p.publish_error)}</div>` : "";
      const note = (p.status === "rejected" && p.review_note) ? `<div style="font-size:12px;color:var(--red);margin-top:3px">причина: ${esc(p.review_note)}</div>` : "";
      let act = "";
      if (isOwner) {
        if (p.status === "pending") act += `<button class="btn primary sm" onclick="approvePlan(${p.id})">Одобрить</button> <button class="btn ghost sm" onclick="rejectPlan(${p.id})">Отклонить</button> `;
        if (p.status !== "published") act += `<button class="btn ghost sm" onclick="publishNow(${p.id})">Опубликовать</button> `;
      } else {
        if (p.status === "draft" || p.status === "rejected") act += `<button class="btn primary sm" onclick="submitPlan(${p.id})">На согласование</button> `;
        else if (p.status === "pending") act += `<span style="color:var(--muted);font-size:13px">ждёт одобрения</span> `;
        else if (p.status === "approved") act += `<button class="btn ghost sm" onclick="publishNow(${p.id})">Опубликовать</button> `;
      }
      return `<tr>
        <td>${esc(when)}</td>
        <td><b>${esc(p.title)}</b>${p.text ? `<div style="color:var(--muted);font-size:13px;margin-top:2px">${esc(p.text).slice(0, 120)}</div>` : ""}${rub}</td>
        <td>${esc(pl)}</td>
        <td><span class="badge st-${p.status}">${ST_NAME[p.status] || p.status}</span>${pub}${perr}${note}</td>
        <td>${act}<button class="link" onclick="delPlan(${p.id})">Удалить</button></td>
      </tr>`;
    }).join("")}</tbody></table>`;
}
async function submitPlan(id) { const r = await api("plan/status", { id, status: "pending" }); toast(r.ok ? "Отправлено на согласование ✓" : (r.error || "Не удалось")); loadPlan(); }
async function approvePlan(id) { const r = await api("plan/status", { id, status: "approved" }); toast(r.ok ? "Одобрено ✓" : (r.error || "Не удалось")); loadPlan(); if (TAB === "mod") renderModeration(); }
async function rejectPlan(id) { const note = prompt("Причина отклонения (необязательно):", ""); if (note === null) return; const r = await api("plan/status", { id, status: "rejected", note }); toast(r.ok ? "Отклонено" : (r.error || "Не удалось")); loadPlan(); if (TAB === "mod") renderModeration(); }
async function delPlan(id) { const r = await api("plan/delete", { id }); toast(r.ok ? "Удалено ✓" : "Не удалось"); loadPlan(); }

/* ---------- Модерация (владелец) ---------- */
async function renderModeration() {
  if (PROFILE.role !== "owner") { $("pane-mod").innerHTML = ""; return; }
  $("pane-mod").innerHTML = `<div class="card"><h2>На согласовании</h2><div class="hint">Посты регионов ждут вашего решения. Одобренные уходят в публикацию (по расписанию или вручную). Пока не одобрено — ничего не публикуется.</div><div id="modList"><div class="empty">Загружаю…</div></div></div>`;
  const r = await api("moderation");
  const box = $("modList"); if (!box) return;
  const list = (r.items || []);
  if (!list.length) { box.innerHTML = `<div class="empty">Пусто — новых постов на согласование нет.</div>`; return; }
  box.innerHTML = list.map((p) => {
    const pl = (p.platforms || []).map((k) => (PLATFORMS.find((x) => x.key === k) || { name: k }).name).join(", ");
    const when = (p.plan_date || "—") + (p.plan_time ? " " + p.plan_time : "");
    const rub = p.rubric_id ? ` · рубрика: ${esc(rubName(p.rubric_id))}` : "";
    return `<div class="card" style="border:1px solid var(--line);margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <b>${esc(p.region || "—")}</b><span style="color:var(--muted);font-size:13px">${esc(when)} · ${esc(pl)}${rub}</span>
      </div>
      <div style="font-weight:600;margin-top:6px">${esc(p.title)}</div>
      <div style="white-space:pre-wrap;color:var(--muted);font-size:13px;margin-top:4px">${esc(p.text || "")}</div>
      ${complianceLine(p.compliance)}
      <div style="margin-top:8px">
        <button class="btn primary sm" onclick="approvePlan(${p.id})">Одобрить</button>
        <button class="btn ghost sm" onclick="rejectPlan(${p.id})">Отклонить</button>
      </div>
    </div>`;
  }).join("");
}
function complianceLine(c) {
  if (!c || typeof c !== "object") return "";
  const bad = c.ok === false || c.violation || c.risk || (Array.isArray(c.violations) && c.violations.length) || c.status === "bad" || c.compliant === false;
  if (!bad) return "";
  const txt = c.note || c.reason || (Array.isArray(c.violations) ? c.violations.join("; ") : "") || "проверьте на соответствие ст. 24 ФЗ «О рекламе»";
  return `<div style="margin-top:6px;color:var(--red);font-size:13px">⚠ Комплаенс: ${esc(String(txt)).slice(0, 240)}</div>`;
}

/* ---------- Команда (владелец) ---------- */
async function renderTeam() {
  if (PROFILE.role !== "owner") { $("pane-team").innerHTML = ""; return; }
  const opts = REGIONS.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  $("pane-team").innerHTML = `
    <div class="card">
      <h2>Добавить менеджера региона</h2>
      <div class="hint">Менеджер видит только свой регион.</div>
      <div class="row">
        <input id="u-name" placeholder="Имя">
        <input id="u-email" type="email" placeholder="E-mail">
      </div>
      <div class="row" style="margin-top:8px">
        <input id="u-pass" placeholder="Пароль">
        <select id="u-region">${opts}</select>
        <button class="btn primary" onclick="addUser()">Добавить</button>
      </div>
    </div>
    <div class="card"><h2>Пользователи</h2><div id="userList"><div class="empty">Загружаю…</div></div></div>
    <div class="card">
      <h2>Фирменный стиль</h2>
      <div class="hint">Единый стиль для всех регионов: тон, дисклеймер, хэштеги, подпись, цвета. Ориентир при подготовке контента.</div>
      <div id="brandBox"><div class="empty">Загружаю…</div></div>
    </div>
    <div class="card">
      <h2>Рубрики</h2>
      <div class="hint">Готовые темы, из которых регионы выбирают при планировании поста.</div>
      <div id="rubBox"><div class="empty">Загружаю…</div></div>
      <div class="row" style="margin-top:8px">
        <input id="rb-title" placeholder="Название рубрики" style="flex:1">
        <input id="rb-hint" placeholder="Подсказка — о чём рубрика" style="flex:2">
        <button class="btn ghost" onclick="addRubric()">Добавить</button>
      </div>
    </div>`;
  loadUsers(); loadBrand(); loadRubricsAdmin();
}
async function loadBrand() {
  const r = await api("brand"); const b = r.brand || {}; const box = $("brandBox"); if (!box) return;
  const f = (id, label, val) => `<label style="display:block;margin-bottom:6px"><span style="font-size:12px;color:var(--muted)">${label}</span><input id="${id}" value="${esc(val || "")}" style="width:100%"></label>`;
  box.innerHTML = `
    ${f("br-name", "Название", b.name)}
    <label style="display:block;margin-bottom:6px"><span style="font-size:12px;color:var(--muted)">Тон общения</span><textarea id="br-tone" style="width:100%;min-height:52px">${esc(b.tone || "")}</textarea></label>
    ${f("br-disc", "Дисклеймер (противопоказания)", b.disclaimer)}
    ${f("br-tags", "Хэштеги", b.hashtags)}
    ${f("br-sign", "Подпись", b.signature)}
    <div class="row">${f("br-primary", "Основной цвет", b.primary_color)}${f("br-accent", "Акцент", b.accent_color)}</div>
    ${f("br-logo", "URL логотипа", b.logo_url)}
    <div style="margin-top:8px"><button class="btn primary" onclick="saveBrand()">Сохранить стиль</button></div>`;
}
async function saveBrand() {
  const g = (id) => ($(id) ? $(id).value : "");
  const r = await api("brand", { name: g("br-name"), tone: g("br-tone"), disclaimer: g("br-disc"), hashtags: g("br-tags"), signature: g("br-sign"), primary_color: g("br-primary"), accent_color: g("br-accent"), logo_url: g("br-logo") });
  toast(r.ok ? "Стиль сохранён ✓" : (r.error || "Не удалось"));
}
async function loadRubricsAdmin() {
  const r = await api("rubrics"); window.RUBRICS = r.rubrics || []; const box = $("rubBox"); if (!box) return;
  box.innerHTML = window.RUBRICS.length ? window.RUBRICS.map((x) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--line)"><b>${esc(x.title)}</b><span style="color:var(--muted);font-size:13px">${esc(x.hint || "")}</span><button class="link" style="margin-left:auto" onclick="delRubric(${x.id})">убрать</button></div>`).join("") : `<div class="empty">Пока нет рубрик.</div>`;
}
async function addRubric() {
  const title = $("rb-title").value.trim(), hint = $("rb-hint").value.trim();
  if (!title) { toast("Название рубрики"); return; }
  const r = await api("rubrics/add", { title, hint });
  if (!r.ok) { toast(r.error || "Не удалось"); return; }
  $("rb-title").value = ""; $("rb-hint").value = ""; toast("Рубрика добавлена ✓"); loadRubricsAdmin();
}
async function delRubric(id) { const r = await api("rubrics/delete", { id }); toast(r.ok ? "Убрано ✓" : "Не удалось"); loadRubricsAdmin(); }
async function addUser() {
  const email = $("u-email").value.trim(), password = $("u-pass").value, name = $("u-name").value.trim();
  if (!email || !password) { toast("email и пароль обязательны"); return; }
  const r = await api("users/add", { email, password, name, region_id: Number($("u-region").value) });
  if (!r.ok) { toast(r.error || "Не удалось"); return; }
  $("u-email").value = ""; $("u-pass").value = ""; $("u-name").value = "";
  toast("Менеджер добавлен ✓"); loadUsers();
}
async function loadUsers() {
  const r = await api("users");
  const box = $("userList"); if (!box) return;
  const list = (r.users || []);
  box.innerHTML = `<table><thead><tr><th>E-mail</th><th>Имя</th><th>Роль</th><th>Регион</th></tr></thead><tbody>${
    list.map((u) => `<tr><td>${esc(u.email)}</td><td>${esc(u.name || "")}</td><td>${u.role === "owner" ? "владелец" : "менеджер"}</td><td>${esc(u.region || "—")}</td></tr>`).join("")
  }</tbody></table>`;
}

/* ---------- старт ---------- */
$("li-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
boot();
