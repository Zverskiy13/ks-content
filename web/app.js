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
  if (PROFILE.role === "owner") $("tab-team").classList.remove("hidden");
  const [rg, pl] = await Promise.all([api("regions"), api("platforms")]);
  REGIONS = (rg.regions || []); PLATFORMS = (pl.platforms || []);
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
function renderCurrent() { if (TAB === "viral") renderViral(); else if (TAB === "plan") renderPlan(); else renderTeam(); }

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
      <h2>Запланировать публикацию</h2>
      <div class="hint">Соберите пост, выберите площадки и дату. Публикация в v1 — вручную; статусы помогают вести очередь. IG/TikTok сейчас недоступны в РФ (оставлены на будущее).</div>
      <input id="p-title" placeholder="Заголовок / тема" style="width:100%;margin-bottom:8px">
      <textarea id="p-text" placeholder="Текст поста / сценарий" style="width:100%;min-height:90px;margin-bottom:8px"></textarea>
      <div class="plats">${plats}</div>
      <div class="row">
        <input id="p-date" type="date">
        <input id="p-time" type="time">
        <select id="p-status"><option value="draft">Черновик</option><option value="ready">Готово к публикации</option></select>
      </div>
      <div style="margin-top:10px"><button class="btn primary" onclick="addPlan()">Добавить в план</button></div>
    </div>
    <div class="card">
      <h2>Контент-план региона</h2>
      <div id="planList"><div class="empty">Загружаю…</div></div>
    </div>`;
  loadPlan();
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
  box.innerHTML = `<table><thead><tr><th>Дата</th><th>Тема</th><th>Площадки</th><th>Статус</th><th></th></tr></thead><tbody>${
    list.map((p) => {
      const pl = (p.platforms || []).map((k) => (PLATFORMS.find((x) => x.key === k) || { name: k }).name).join(", ");
      const when = (p.plan_date || "—") + (p.plan_time ? " " + p.plan_time : "");
      const nextSt = p.status === "draft" ? "ready" : (p.status === "ready" ? "published" : "draft");
      const stName = { draft: "Черновик", ready: "Готово", published: "Опубликовано" }[p.status] || p.status;
      return `<tr>
        <td>${esc(when)}</td>
        <td><b>${esc(p.title)}</b>${p.text ? `<div style="color:var(--muted);font-size:13px;margin-top:2px">${esc(p.text).slice(0, 120)}</div>` : ""}</td>
        <td>${esc(pl)}</td>
        <td><span class="badge st-${p.status}" style="cursor:pointer" onclick="cycleStatus(${p.id},'${nextSt}')">${stName}</span></td>
        <td><button class="link" onclick="delPlan(${p.id})">Удалить</button></td>
      </tr>`;
    }).join("")}</tbody></table>`;
}
async function cycleStatus(id, st) { const r = await api("plan/status", { id, status: st }); if (r.ok) loadPlan(); }
async function delPlan(id) { const r = await api("plan/delete", { id }); toast(r.ok ? "Удалено ✓" : "Не удалось"); loadPlan(); }

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
    <div class="card"><h2>Пользователи</h2><div id="userList"><div class="empty">Загружаю…</div></div></div>`;
  loadUsers();
}
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
