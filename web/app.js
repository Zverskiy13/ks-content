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
function renderCurrent() {
  if (TAB === "viral") renderViral();
  else if (TAB === "scout") renderScout();
  else if (TAB === "plan") renderPlan();
  else if (TAB === "results") renderResults();
  else if (TAB === "studio") renderStudio();
  else renderTeam();
}

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
    <div id="genResult"></div>
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
  window.__ideas = list;
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
      <button class="btn primary sm" onclick="genPost(${row.id})">✍️ Сделать пост</button>
      <button class="btn ghost sm" onclick='toPlan(${row.id})'>→ В план (черновик)</button>
      <button class="link" onclick="delIdea(${row.id})">Удалить</button>
    </div>
  </div>`;
}
async function delIdea(id) { const r = await api("ideas/delete", { id }); toast(r.ok ? "Удалено ✓" : "Не удалось"); loadIdeas(); }

/* агент-сценарист: из идеи → готовый пост */
async function genPost(id) {
  const c = (window.__ideas || []).find((x) => x.id === id); if (!c) return;
  const d = c.data || {}, app = (d.applicability && d.applicability[0]) || {};
  toast("Пишу пост… 10–20 сек");
  const r = await api("script/generate", { region_id: CUR_REGION, theme: d.theme || "", hook: d.hook || "", direction: app.direction || "", idea: app.idea || "" });
  if (!r.ok) { toast(r.error || "Не удалось"); return; }
  window.__script = r.script; renderGen(r.script);
}
function renderGen(s) {
  const box = $("genResult"); if (!box) return;
  const cm = s.compliance || {};
  const cbadge = cm.art24_ok === false ? `<span class="badge bad">ст.24: ${esc((cm.flags || []).join("; "))}</span>` : `<span class="badge ok">ст.24 ок</span>`;
  const ebadge = cm.needs_erid ? `<span class="badge ad">реклама · нужен erid</span>` : `<span class="badge org">органика</span>`;
  box.innerHTML = `<div class="card" style="border-color:var(--red)">
    <h2>Готовый пост</h2>
    ${(s.headlines || []).length ? `<div class="line"><b>Заголовки:</b> ${(s.headlines || []).map(esc).join(" · ")}</div>` : ""}
    <div class="line" style="margin-top:8px"><b>VK:</b></div><div style="white-space:pre-wrap;font-size:14px">${esc(s.post_vk || "")}</div>
    <div class="line" style="margin-top:8px"><b>OK:</b></div><div style="white-space:pre-wrap;font-size:14px">${esc(s.post_ok || "")}</div>
    <div class="meta" style="margin-top:8px">${cbadge} ${ebadge}</div>
    <div class="actions">
      <button class="btn ghost sm" onclick="scriptToPlan('vk')">В план — версия VK</button>
      <button class="btn ghost sm" onclick="scriptToPlan('ok')">В план — версия OK</button>
      <button class="link" onclick="document.getElementById('genResult').innerHTML=''">скрыть</button>
    </div></div>`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}
function scriptToPlan(which) {
  const s = window.__script; if (!s) return;
  switchTab("plan");
  setTimeout(() => {
    if ($("p-title")) $("p-title").value = s.title || "";
    if ($("p-text")) $("p-text").value = (which === "ok" ? s.post_ok : s.post_vk) || "";
    window.__planCompliance = s.compliance || {};
    toast("Пост перенесён в план — выбери площадку и дату");
  }, 60);
}

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
        <input id="p-imgprompt" placeholder="🎨 Обложка ИИ: опиши картинку (пусто — по заголовку)" style="flex:3">
        <button class="btn ghost" onclick="genImage()">Сгенерировать обложку</button>
      </div>
      <div id="p-imgprev"></div>
      <input id="p-image" placeholder="…или ссылка на готовую картинку (URL)" style="width:100%;margin-bottom:8px">
      <input id="p-video" placeholder="Ссылка на видеофайл (URL .mp4, необязательно — загрузится в VK)" style="width:100%;margin-bottom:8px">
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
  if (window.__planImageData && $("p-imgprev")) $("p-imgprev").innerHTML = `<img src="data:image/png;base64,${window.__planImageData}" style="max-width:220px;border-radius:10px;margin:6px 0;display:block"><button class="link" onclick="clearImg()">убрать обложку</button>`;
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
async function genImage() {
  const prompt = ($("p-imgprompt").value.trim()) || ($("p-title") ? $("p-title").value.trim() : "");
  if (!prompt) { toast("Опиши картинку или заполни заголовок"); return; }
  toast("Рисую обложку… 15–30 сек");
  const r = await api("image/generate", { region_id: CUR_REGION, prompt });
  if (!r.ok) { toast(r.error || "Не удалось"); return; }
  window.__planImageData = r.image_b64;
  $("p-imgprev").innerHTML = `<img src="data:image/png;base64,${r.image_b64}" style="max-width:220px;border-radius:10px;margin:6px 0;display:block"><button class="link" onclick="clearImg()">убрать обложку</button>`;
  toast("Готово ✓ — приложится к посту");
}
function clearImg() { window.__planImageData = ""; if ($("p-imgprev")) $("p-imgprev").innerHTML = ""; }
async function addPlan() {
  const title = $("p-title").value.trim(), text = $("p-text").value.trim();
  const platforms = Object.keys(PICK).filter((k) => PICK[k]);
  if (!title) { toast("Добавьте заголовок"); return; }
  if (!platforms.length) { toast("Выберите хотя бы одну площадку"); return; }
  const r = await api("plan/add", {
    region_id: CUR_REGION, title, text, platforms,
    date: $("p-date").value, time: $("p-time").value, status: $("p-status").value,
    idea_id: window.__planIdeaId || null, compliance: window.__planCompliance || {},
    image_url: ($("p-image") ? $("p-image").value.trim() : ""),
    video_url: ($("p-video") ? $("p-video").value.trim() : ""),
    image_data: (window.__planImageData || "")
  });
  if (!r.ok) { toast(r.error || "Не удалось"); return; }
  $("p-title").value = ""; $("p-text").value = ""; if ($("p-image")) $("p-image").value = ""; if ($("p-video")) $("p-video").value = "";
  window.__planImageData = ""; if ($("p-imgprev")) $("p-imgprev").innerHTML = ""; if ($("p-imgprompt")) $("p-imgprompt").value = "";
  window.__planIdeaId = null; window.__planCompliance = null;
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
      const pub = p.published_url ? `<div style="font-size:12px;margin-top:3px"><a href="${esc(p.published_url)}" target="_blank" rel="noopener">опубликовано ↗</a></div>` : "";
      const perr = p.publish_error ? `<div style="font-size:12px;color:var(--red);margin-top:3px">${esc(p.publish_error)}</div>` : "";
      const canPub = p.status !== "published";
      return `<tr>
        <td>${esc(when)}</td>
        <td><b>${esc(p.title)}</b>${p.text ? `<div style="color:var(--muted);font-size:13px;margin-top:2px">${esc(p.text).slice(0, 120)}</div>` : ""}</td>
        <td>${esc(pl)}</td>
        <td><span class="badge st-${p.status}" style="cursor:pointer" onclick="cycleStatus(${p.id},'${nextSt}')">${stName}</span>${pub}${perr}</td>
        <td>${canPub ? `<button class="btn ghost sm" onclick="publishNow(${p.id})">Опубликовать</button> ` : ""}<button class="link" onclick="delPlan(${p.id})">Удалить</button></td>
      </tr>`;
    }).join("")}</tbody></table>`;
}
async function cycleStatus(id, st) { const r = await api("plan/status", { id, status: st }); if (r.ok) loadPlan(); }
async function delPlan(id) { const r = await api("plan/delete", { id }); toast(r.ok ? "Удалено ✓" : "Не удалось"); loadPlan(); }

/* ---------- Результаты (контролёр) ---------- */
async function renderResults() {
  $("pane-results").innerHTML = `
    <div class="card">
      <h2>Результаты публикаций</h2>
      <div class="hint">Статистика опубликованных постов (VK). Обновляется автоматически ~раз в 30 мин; можно и вручную.</div>
      <div style="margin:6px 0;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ghost" onclick="refreshStats()">Обновить статистику</button>
        <button class="btn primary" onclick="resultsAdvice()">Совет ИИ — что масштабировать</button>
      </div>
      <div id="adviceBox"></div>
      <div id="resList" style="margin-top:10px"><div class="empty">Загружаю…</div></div>
    </div>`;
  loadResults();
}
async function loadResults() {
  const r = await api("results?region_id=" + CUR_REGION);
  const box = $("resList"); if (!box) return;
  const list = (r.results || []);
  if (!list.length) { box.innerHTML = `<div class="empty">Пока нет опубликованных постов.</div>`; return; }
  box.innerHTML = `<table><thead><tr><th>Дата</th><th>Пост</th><th>👁</th><th>👍</th><th>🔁</th><th>💬</th><th></th></tr></thead><tbody>${
    list.map((p) => {
      const m = (p.metrics && p.metrics.vk) || {};
      const link = p.published_url ? `<a href="${esc(p.published_url)}" target="_blank" rel="noopener">открыть ↗</a>` : "";
      return `<tr><td>${esc(p.published_at || "")}</td><td><b>${esc(p.title)}</b></td>
        <td>${m.views || 0}</td><td>${m.likes || 0}</td><td>${m.reposts || 0}</td><td>${m.comments || 0}</td><td>${link}</td></tr>`;
    }).join("")}</tbody></table>`;
}
async function refreshStats() {
  toast("Обновляю статистику…");
  const r = await api("plan/refresh", { region_id: CUR_REGION });
  toast(r.ok ? `Обновлено постов: ${r.updated}` : (r.error || "Не удалось")); loadResults();
}
async function resultsAdvice() {
  toast("Анализирую результаты… 10–20 сек");
  const r = await api("results/advice", { region_id: CUR_REGION });
  const box = $("adviceBox"); if (!box) return;
  if (!r.ok) { box.innerHTML = `<div class="hint" style="color:var(--red)">${esc(r.error || "Не удалось")}</div>`; return; }
  const li = (arr) => (arr || []).map((x) => `<li>${esc(x)}</li>`).join("");
  box.innerHTML = `<div class="card" style="border-color:var(--red);margin-top:8px">
    <div class="line"><b>${esc(r.summary || "")}</b></div>
    <div class="line" style="margin-top:6px"><b>📈 Масштабировать:</b><ul>${li(r.scale)}</ul></div>
    <div class="line"><b>🗑 Убрать / не повторять:</b><ul>${li(r.drop)}</ul></div>
    <div class="line"><b>➡️ На следующий цикл:</b><ul>${li(r.next)}</ul></div>
  </div>`;
}

/* ---------- Студия обложек (чат + фирстиль) ---------- */
async function renderStudio() {
  const br = await api("brand?region_id=" + CUR_REGION);
  const style = (br && br.style) || "";
  window.__studioThread = window.__studioThread || [];
  $("pane-studio").innerHTML = `
    <div class="card">
      <h2>Фирменный стиль</h2>
      <div class="hint">Опиши стиль клиники (цвета, настроение, что нельзя). ИИ будет держать его во всех картинках.</div>
      <textarea id="brand-style" style="width:100%;min-height:72px" placeholder="Напр.: фирменный красный #E1191C, чистый минимализм, доверие и забота, светлые тона, реальные люди без стоковых улыбок, без текста на изображении">${esc(style)}</textarea>
      <button class="btn ghost" style="margin-top:8px" onclick="saveBrand()">Сохранить стиль</button>
    </div>
    <div class="card">
      <h2>Студия обложек</h2>
      <div class="hint">Напиши, что понравилось / что хочешь на картинке — ИИ сделает обложку в вашем стиле. Можно уточнять: «сделай теплее», «другой ракурс».</div>
      <div id="studioThread" style="display:flex;flex-direction:column;gap:14px;margin:12px 0"></div>
      <div class="row">
        <input id="studio-in" placeholder="Напр.: как тот пост про чекапы, только светлее и с врачом у окна" style="flex:4">
        <button class="btn primary" onclick="studioSend()">Сгенерировать</button>
      </div>
    </div>`;
  const inp = $("studio-in"); if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") studioSend(); });
  renderThread();
}
async function saveBrand() {
  const r = await api("brand", { region_id: CUR_REGION, style: $("brand-style").value.trim() });
  toast(r.ok ? "Стиль сохранён ✓" : "Не удалось");
}
function renderThread() {
  const box = $("studioThread"); if (!box) return;
  const t = window.__studioThread || [];
  box.innerHTML = t.length ? t.map((m, i) => `
    <div>
      <div style="font-size:14px;color:var(--muted)">🗨 ${esc(m.text)}</div>
      ${m.image ? `<img src="data:image/png;base64,${m.image}" style="max-width:300px;border-radius:12px;margin-top:6px;display:block">
        <div class="actions"><button class="btn ghost sm" onclick="studioToPlan(${i})">→ В план как обложку</button></div>` : `<div class="hint">рисую…</div>`}
    </div>`).join("") : `<div class="empty">Пока пусто — напиши идею ниже ↓</div>`;
}
async function studioSend() {
  const text = $("studio-in").value.trim();
  if (!text) return;
  $("studio-in").value = "";
  window.__studioThread.push({ text, image: "" }); renderThread();
  toast("Рисую… 15–30 сек");
  const r = await api("studio/generate", { region_id: CUR_REGION, text });
  const item = window.__studioThread[window.__studioThread.length - 1];
  if (!r.ok) { item.text += "  (ошибка: " + (r.error || "не удалось") + ")"; toast(r.error || "Не удалось"); }
  else { item.image = r.image_b64; toast("Готово ✓"); }
  renderThread();
}
function studioToPlan(i) {
  const m = window.__studioThread[i]; if (!m || !m.image) return;
  window.__planImageData = m.image;
  switchTab("plan");
  setTimeout(() => toast("Обложка перенесена в план ✓ — заполни текст и дату"), 80);
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
