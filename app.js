/** SOCCER24 */

const API = '/api';
const TZ = 'Europe/Moscow';
const TEAMS_SEASON = 2024; // последний сезон, доступный на free-плане

const LEAGUES = [
  { id: 39, name: 'АПЛ', full: 'Англия · Premier League' },
  { id: 140, name: 'Ла Лига', full: 'Испания · La Liga' },
  { id: 135, name: 'Серия А', full: 'Италия · Serie A' },
  { id: 78, name: 'Бундеслига', full: 'Германия · Bundesliga' },
  { id: 61, name: 'Лига 1', full: 'Франция · Ligue 1' },
  { id: 235, name: 'РПЛ', full: 'Россия · Premier League' },
  { id: 88, name: 'Эредивизи', full: 'Нидерланды · Eredivisie' },
  { id: 94, name: 'Примейра', full: 'Португалия · Primeira Liga' },
  { id: 2, name: 'ЛЧ', full: 'УЕФА · Champions League' },
  { id: 3, name: 'ЛЕ', full: 'УЕФА · Europa League' },
];

const LIVE_SHORT = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);
const DONE_SHORT = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);

const state = {
  view: 'matches',
  dateOffset: 0,
  statusFilter: 'all',
  leagueFilter: 'all',
  fixtures: [],
  live: [],
  cache: new Map(),
  user: null,
  authMode: 'login',
  pricing: { price: 45, days: 30, currency: 'RUB' },
  chatTimer: null,
  chatSince: 0,
  chatFixtureId: null,
  standingsCache: new Map(),
  activeFixtureId: null,
  captchaId: null,
  authRequired: true,
  booted: false,
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function pad(n) {
  return String(n).padStart(2, '0');
}

function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function formatRu(d) {
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' });
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TZ,
    });
  } catch {
    return '—';
  }
}

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setPill(text, ok = true) {
  const el = $('#api-pill');
  el.textContent = text;
  el.classList.toggle('is-ok', ok);
  el.classList.toggle('is-bad', !ok);
}

async function apiGet(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const key = `${endpoint}?${qs}`;
  if (state.cache.has(key)) return state.cache.get(key);

  const res = await fetch(`${API}/${endpoint}${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data?.errors && Object.keys(data.errors).length) {
    console.warn('API errors', data.errors);
  }
  state.cache.set(key, data);
  return data;
}

function isLive(fx) {
  return LIVE_SHORT.has(fx?.fixture?.status?.short);
}

function isDone(fx) {
  return DONE_SHORT.has(fx?.fixture?.status?.short);
}

function scoreText(fx) {
  const h = fx.goals?.home;
  const a = fx.goals?.away;
  if (h == null && a == null) return null;
  return { h: h ?? 0, a: a ?? 0 };
}

/* ---------- render fixtures ---------- */

function fixtureRow(fx) {
  const live = isLive(fx);
  const done = isDone(fx);
  const score = scoreText(fx);
  const elapsed = fx.fixture?.status?.elapsed;
  const timeLabel = live
    ? `${elapsed ?? ''}′`
    : done
      ? 'FT'
      : formatTime(fx.fixture.date);

  const scoreHtml = score
    ? `<div class="fixture__score">${score.h}<em>:</em>${score.a}</div>`
    : `<div class="fixture__score" style="color:var(--muted);font-size:0.95rem">${formatTime(fx.fixture.date)}</div>`;

  return `
    <button type="button" class="fixture" data-id="${fx.fixture.id}">
      <div class="fixture__time ${live ? 'is-live' : ''}">${escapeHtml(String(timeLabel))}</div>
      <div class="fixture__teams">
        <div class="fixture__team">
          <img src="${escapeHtml(fx.teams.home.logo)}" alt="" loading="lazy" width="26" height="26">
          <span>${escapeHtml(fx.teams.home.name)}</span>
        </div>
        <div class="fixture__team">
          <img src="${escapeHtml(fx.teams.away.logo)}" alt="" loading="lazy" width="26" height="26">
          <span>${escapeHtml(fx.teams.away.name)}</span>
        </div>
      </div>
      ${scoreHtml}
    </button>
  `;
}

function filteredFixtures(list = state.fixtures) {
  let rows = list.slice();

  if (state.leagueFilter !== 'all') {
    rows = rows.filter((fx) => String(fx.league.id) === state.leagueFilter);
  }

  if (state.statusFilter === 'NS') {
    rows = rows.filter((fx) => fx.fixture.status.short === 'NS' || fx.fixture.status.short === 'TBD');
  } else if (state.statusFilter === 'LIVE') {
    rows = rows.filter(isLive);
  } else if (state.statusFilter === 'FT') {
    rows = rows.filter(isDone);
  }

  return rows;
}

function groupByLeague(list) {
  const map = new Map();
  list.forEach((fx) => {
    const key = `${fx.league.id}|${fx.league.name}|${fx.league.country}`;
    if (!map.has(key)) {
      map.set(key, {
        id: fx.league.id,
        name: fx.league.name,
        country: fx.league.country,
        logo: fx.league.logo,
        items: [],
      });
    }
    map.get(key).items.push(fx);
  });
  return [...map.values()].sort((a, b) => b.items.length - a.items.length);
}

function bindFixtureClicks(root) {
  root.querySelectorAll('.fixture[data-id], .live-row[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const fx = [...state.fixtures, ...state.live].find((x) => x.fixture.id === id);
      if (fx) openFixture(fx);
    });
  });
}

function renderFeed(target, list) {
  const rows = filteredFixtures(list);
  if (!rows.length) {
    target.innerHTML = `<div class="empty">Матчей нет. Смените дату или фильтр.</div>`;
    return;
  }

  const groups = groupByLeague(rows);
  target.innerHTML = groups.map((g) => `
    <section class="league-block">
      <div class="league-block__head">
        ${g.logo ? `<img src="${escapeHtml(g.logo)}" alt="">` : ''}
        <h3>${escapeHtml(g.name)}</h3>
        <span>${escapeHtml(g.country)} · ${g.items.length}</span>
      </div>
      ${g.items.map(fixtureRow).join('')}
    </section>
  `).join('');

  bindFixtureClicks(target);
}

function renderLiveMini() {
  const box = $('#live-mini');
  const list = state.live.slice(0, 8);
  if (!list.length) {
    box.innerHTML = `<div class="empty empty--sm">Сейчас нет live-матчей</div>`;
    return;
  }
  box.innerHTML = list.map((fx) => {
    const s = scoreText(fx) || { h: 0, a: 0 };
    return `
      <button type="button" class="live-row" data-id="${fx.fixture.id}">
        <div>
          <strong>${escapeHtml(fx.teams.home.name)} — ${escapeHtml(fx.teams.away.name)}</strong>
          <small>${escapeHtml(fx.league.name)} · ${fx.fixture.status.elapsed ?? ''}′</small>
        </div>
        <div class="live-row__score">${s.h}:${s.a}</div>
      </button>
    `;
  }).join('');
  bindFixtureClicks(box);
}

function updateHeroStats() {
  const leagues = new Set(state.fixtures.map((fx) => fx.league.id));
  $('#stat-total').textContent = String(state.fixtures.length);
  $('#stat-live').textContent = String(state.live.length);
  $('#stat-leagues').textContent = String(leagues.size);

  const day = addDays(new Date(), state.dateOffset);
  $('#hero-date').textContent = formatRu(day);
}

function fillLeagueFilter() {
  const select = $('#league-filter');
  const current = select.value || 'all';
  const fromData = new Map();
  state.fixtures.forEach((fx) => {
    fromData.set(fx.league.id, `${fx.league.name} (${fx.league.country})`);
  });

  const options = [`<option value="all">Все лиги</option>`];
  [...fromData.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'ru'))
    .forEach(([id, label]) => {
      options.push(`<option value="${id}">${escapeHtml(label)}</option>`);
    });

  select.innerHTML = options.join('');
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function renderDateTabs() {
  const root = $('#date-tabs');
  const labels = [-1, 0, 1, 2].map((off) => {
    const d = addDays(new Date(), off);
    let label = formatRu(d);
    if (off === 0) label = 'Сегодня';
    if (off === -1) label = 'Вчера';
    if (off === 1) label = 'Завтра';
    return { off, label };
  });

  root.innerHTML = labels.map(({ off, label }) => `
    <button type="button" class="date-chip ${state.dateOffset === off ? 'is-on' : ''}" data-off="${off}">
      ${label}
    </button>
  `).join('');

  root.querySelectorAll('.date-chip').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.dateOffset = Number(btn.dataset.off);
      renderDateTabs();
      await loadFixturesForSelectedDay();
    });
  });
}

/* ---------- standings / teams ---------- */

function formBadge(form) {
  if (!form) return '';
  return `<span class="form-strip">${[...String(form)].slice(-5).map((c) =>
    `<i class="f f--${c}">${c}</i>`
  ).join('')}</span>`;
}

function renderStandings(payload, mount, { mini = false } = {}) {
  if (!payload?.ok || !payload.groups?.length) {
    mount.innerHTML = `<div class="empty empty--sm">Таблица недоступна для этой лиги</div>`;
    return;
  }

  const groups = payload.groups;
  const seasonLabel = payload.seasonLabel || String(payload.season || '');
  const leagueName = payload.league?.name || '';

  const blocks = groups.map((table, idx) => {
    const groupName = table[0]?.group && table[0].group !== leagueName
      ? table[0].group
      : (groups.length > 1 ? `Группа ${idx + 1}` : '');
    const rows = (mini ? table.slice(0, 8) : table).map((row) => `
      <tr>
        <td class="col-rank">${row.rank}</td>
        <td class="team"><span>
          <img src="${escapeHtml(row.team.logo)}" alt="" width="18" height="18" loading="lazy">
          ${escapeHtml(row.team.name)}
        </span></td>
        <td>${row.all.played}</td>
        ${mini ? '' : `<td>${row.all.win}</td><td>${row.all.draw}</td><td>${row.all.lose}</td>`}
        <td>${row.goalsDiff > 0 ? '+' : ''}${row.goalsDiff}</td>
        <td class="pts">${row.points}</td>
        ${mini ? '' : `<td>${formBadge(row.form)}</td>`}
      </tr>
    `).join('');

    return `
      ${groupName ? `<h3 class="table-group">${escapeHtml(groupName)}</h3>` : ''}
      <table class="table">
        <thead>
          <tr>
            <th>#</th><th>Команда</th><th>И</th>
            ${mini ? '' : '<th>В</th><th>Н</th><th>П</th>'}
            <th>+/−</th><th>О</th>
            ${mini ? '' : '<th>Форма</th>'}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }).join('');

  mount.innerHTML = `
    <div class="table-meta">
      <strong>${escapeHtml(leagueName)}</strong>
      <span>Сезон ${escapeHtml(seasonLabel)}</span>
    </div>
    ${blocks}
  `;
}

async function loadStandings(leagueId) {
  const key = String(leagueId);
  if (state.standingsCache.has(key)) return state.standingsCache.get(key);
  const data = await authFetch(`/standings/${key}`);
  state.standingsCache.set(key, data);
  return data;
}

async function renderRailTable() {
  const select = $('#rail-league');
  if (!select.options.length) {
    select.innerHTML = LEAGUES.map((l) =>
      `<option value="${l.id}">${escapeHtml(l.name)}</option>`
    ).join('');
    select.addEventListener('change', () => renderRailTable());
  }
  try {
    const payload = await loadStandings(select.value);
    renderStandings(payload, $('#rail-table'), { mini: true });
  } catch {
    $('#rail-table').innerHTML = `<div class="empty empty--sm">Не удалось загрузить</div>`;
  }
}

function fillLeagueSelects() {
  const opts = LEAGUES.map((l) =>
    `<option value="${l.id}">${escapeHtml(l.full)}</option>`
  ).join('');
  $('#tables-league').innerHTML = opts;
  $('#teams-league').innerHTML = opts;
  $('#tables-hint').textContent = 'Актуальные итоговые таблицы доступных сезонов по каждой лиге.';
}

async function renderTablesView() {
  const id = $('#tables-league').value;
  const mount = $('#tables-full');
  mount.innerHTML = `<div class="empty">Загрузка таблицы…</div>`;
  try {
    state.standingsCache.delete(String(id));
    const payload = await loadStandings(id);
    renderStandings(payload, mount, { mini: false });
  } catch {
    mount.innerHTML = `<div class="empty">Ошибка загрузки таблицы</div>`;
  }
}

async function renderTeamsView() {
  const id = $('#teams-league').value;
  const grid = $('#teams-grid');
  grid.innerHTML = `<div class="empty">Загрузка клубов…</div>`;
  try {
    const data = await apiGet('teams', { league: id, season: TEAMS_SEASON });
    const teams = data?.response || [];
    if (!teams.length) {
      grid.innerHTML = `<div class="empty">Нет команд для этой лиги / сезона</div>`;
      return;
    }
    grid.innerHTML = teams.map(({ team, venue }) => `
      <button type="button" class="team-card" data-team='${escapeHtml(JSON.stringify({
        id: team.id,
        name: team.name,
        logo: team.logo,
        country: team.country,
        founded: team.founded,
        venue: venue?.name || '',
        city: venue?.city || '',
      }))}'>
        <img src="${escapeHtml(team.logo)}" alt="" loading="lazy">
        <strong>${escapeHtml(team.name)}</strong>
        <span>${escapeHtml(venue?.city || team.country || '')}</span>
      </button>
    `).join('');

    grid.querySelectorAll('.team-card').forEach((btn) => {
      btn.addEventListener('click', () => openTeam(JSON.parse(btn.dataset.team)));
    });
  } catch {
    grid.innerHTML = `<div class="empty">Ошибка загрузки команд</div>`;
  }
}

/* ---------- auth & streams ---------- */

async function authFetch(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

function isSubscribed() {
  return !!(state.user && (state.user.subscribed || state.user.role === 'admin'));
}

async function refreshUser() {
  try {
    const data = await authFetch('/auth/me');
    state.user = data.user || null;
    if (data.pricing) state.pricing = data.pricing;
  } catch {
    state.user = null;
  }
  renderAuthSlot();
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

function showAuthStep(step) {
  const formStep = $('#auth-step-form');
  const subStep = $('#auth-step-sub');
  if (formStep) formStep.hidden = step !== 'form';
  if (subStep) subStep.hidden = step !== 'sub';
}

function renderAuthSlot() {
  const slot = $('#auth-slot');
  if (!slot) return;
  const profileTab = $('#auth-tab-profile');
  if (profileTab) profileTab.hidden = !state.user;

  if (!state.user) {
    slot.innerHTML = `
      <button type="button" class="btn-auth" id="btn-login">Войти</button>
      <button type="button" class="btn-auth btn-auth--solid" id="btn-register">Регистрация</button>
    `;
    $('#btn-login')?.addEventListener('click', () => openAuth('login'));
    $('#btn-register')?.addEventListener('click', () => openAuth('register'));
    return;
  }

  const subBadge = isSubscribed()
    ? '<em class="chip-sub">PRO</em>'
    : '<em class="chip-free">FREE</em>';

  slot.innerHTML = `
    ${state.user.role === 'admin' ? '<a class="btn-auth" href="/admin.html">Админка</a>' : ''}
    ${!isSubscribed() ? '<button type="button" class="btn-auth btn-auth--solid" id="btn-sub-open">Подписка 45₽</button>' : ''}
    <button type="button" class="user-chip" id="btn-profile" title="Профиль">
      <span class="user-chip__ava">${escapeHtml(initials(state.user.name))}</span>
      <span>${escapeHtml(state.user.name)}</span>
      ${state.user.role === 'admin' ? '<em>admin</em>' : subBadge}
    </button>
    <button type="button" class="btn-auth" id="btn-logout">Выйти</button>
  `;
  $('#btn-profile')?.addEventListener('click', () => openAuth('profile'));
  $('#btn-sub-open')?.addEventListener('click', () => openSubscription());
  $('#btn-logout')?.addEventListener('click', async () => {
    try { await authFetch('/auth/logout', { method: 'POST', body: '{}' }); } catch { /* ignore */ }
    state.user = null;
    stopChatPolling();
    renderAuthSlot();
    openAuth('login', { forced: true });
  });
}

function openSubscription() {
  if (!state.user) {
    openAuth('register');
    return;
  }
  showAuthStep('sub');
  const sheet = $('#auth-sheet');
  if (sheet && !sheet.open) sheet.showModal();
}

function finishBoot() {
  const boot = $('#boot-screen');
  document.body.classList.remove('is-booting');
  document.body.classList.add('is-ready');
  if (boot) {
    boot.classList.add('is-done');
    setTimeout(() => boot.remove(), 500);
  }
  state.booted = true;
  if (!state.user) {
    openAuth('login', { forced: true });
  }
}

async function runBootSequence() {
  const bar = $('#boot-bar');
  const hint = $('.boot__hint');
  const steps = [
    [18, 'Проверка сессии…'],
    [45, 'Подключение…'],
    [72, 'Загрузка данных…'],
    [100, 'Готово'],
  ];
  await refreshUser();
  for (const [pct, text] of steps) {
    if (bar) bar.style.width = `${pct}%`;
    if (hint) hint.textContent = text;
    await new Promise((r) => setTimeout(r, 280));
  }
  finishBoot();
}

async function buySubscription() {
  const err = $('#sub-error');
  if (err) { err.hidden = true; err.textContent = ''; }
  try {
    const data = await authFetch('/billing/subscribe', {
      method: 'POST',
      body: JSON.stringify({ method: 'card' }),
    });
    state.user = data.user;
    renderAuthSlot();
    showAuthStep('form');
    $('#auth-sheet')?.close();
    if (state.activeFixtureId) {
      await mountMediaStage(state.activeFixtureId);
    }
  } catch (ex) {
    if (err) { err.hidden = false; err.textContent = ex.message; }
  }
}

function openAuth(mode = 'login', { forced = false } = {}) {
  if (mode === 'profile' && !state.user) mode = 'login';
  state.authMode = mode;
  state.authRequired = forced || !state.user;
  showAuthStep('form');
  const err = $('#auth-error');
  const ok = $('#auth-ok');
  if (err) { err.hidden = true; err.textContent = ''; }
  if (ok) { ok.hidden = true; ok.textContent = ''; }

  $$('#auth-tabs .auth-tabs__btn').forEach((b) => {
    if (b.dataset.mode === 'profile') b.hidden = !state.user;
    b.classList.toggle('is-on', b.dataset.mode === mode);
  });

  const isReg = mode === 'register';
  const isProfile = mode === 'profile';
  const gate = state.authRequired && !isProfile;
  $('.auth-field--email').hidden = !isReg;
  $('.auth-field--name').hidden = !isProfile;
  $('.auth-field--login').hidden = isProfile;
  $('.auth-field--pass').hidden = isProfile;
  $('.auth-field--pass2').hidden = !isReg;
  const hintReg = $('.auth-hint--reg');
  if (hintReg) hintReg.hidden = !isReg;
  const captchaBox = $('#auth-captcha');
  if (captchaBox) captchaBox.hidden = isProfile;
  if (!isProfile) loadAuthCaptcha();

  const closeBtn = $('#auth-close');
  if (closeBtn) closeBtn.hidden = gate;
  const sheet = $('#auth-sheet');
  if (sheet) sheet.classList.toggle('is-forced', gate);

  const box = $('#auth-profile-box');
  if (box) {
    box.hidden = !isProfile;
    if (isProfile && state.user) {
      const until = state.user.subscriptionUntil
        ? new Date(state.user.subscriptionUntil * 1000).toLocaleDateString('ru-RU')
        : 'нет';
      box.innerHTML = `
        <div class="profile-stats">
          <div><span>Логин</span><strong>@${escapeHtml(state.user.login)}</strong></div>
          <div><span>Почта</span><strong>${escapeHtml(state.user.email || '—')}</strong></div>
          <div><span>Подписка</span><strong>${isSubscribed() ? `до ${until}` : 'не активна'}</strong></div>
          <div><span>Роль</span><strong>${escapeHtml(state.user.role)}</strong></div>
        </div>
        ${!isSubscribed() ? '<button type="button" class="btn-auth btn-auth--solid btn-auth--wide" id="profile-buy">Купить подписку 45 ₽</button>' : ''}
        ${state.user.role === 'admin' ? '<a class="btn-auth btn-auth--wide" href="/admin.html" style="text-align:center;display:block;margin-top:0.5rem">Открыть админ-панель</a>' : ''}
      `;
      $('#profile-buy')?.addEventListener('click', () => openSubscription());
    }
  }

  const title = $('#auth-title');
  const lead = $('#auth-lead');
  const submit = $('#auth-submit');
  if (title) {
    title.textContent = isProfile ? 'Профиль' : isReg ? 'Регистрация' : 'Вход';
  }
  if (lead) {
    lead.textContent = isProfile
      ? 'Управляйте именем и подпиской'
      : isReg
        ? 'Почта, логин и пароль — и вы в игре.'
        : 'Логин и пароль для входа в SOCCER24.';
  }
  if (submit) {
    submit.hidden = isProfile;
    submit.textContent = isReg ? 'Создать аккаунт' : 'Войти';
  }

  const form = $('#auth-form');
  if (form && isProfile) form.name.value = state.user.name || '';
  const pass = form?.password;
  if (pass) {
    pass.required = !isProfile;
    pass.minLength = isReg ? 8 : 1;
    pass.autocomplete = isReg ? 'new-password' : 'current-password';
  }
  const pass2 = form?.password2;
  if (pass2) pass2.required = isReg;
  const login = form?.login;
  if (login) login.required = !isProfile;
  const email = form?.email;
  if (email) email.required = isReg;
  const captchaAns = form?.captchaAnswer;
  if (captchaAns) captchaAns.required = !isProfile;

  if (sheet && !sheet.open) sheet.showModal();
}

function stopChatPolling() {
  if (state.chatTimer) {
    clearInterval(state.chatTimer);
    state.chatTimer = null;
  }
  state.chatFixtureId = null;
  state.chatSince = 0;
}

function formatChatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function appendChatMessages(list, messages, { replace = false } = {}) {
  if (!list) return;
  if (replace) {
    list.innerHTML = '';
    if (!messages.length) {
      list.innerHTML = `<div class="chat-empty">Пока тихо — напишите первое сообщение</div>`;
      return;
    }
  }
  messages.forEach((m) => {
    if (list.querySelector(`[data-id="${CSS.escape(m.id)}"]`)) return;
    list.querySelector('.chat-empty')?.remove();
    const mine = state.user && m.userId === state.user.id;
    const el = document.createElement('div');
    el.className = `chat-msg ${mine ? 'is-mine' : ''}`;
    el.dataset.id = m.id;
    el.innerHTML = `
      <div class="chat-msg__top">
        <strong>${escapeHtml(m.name || m.login)}</strong>
        <time>${formatChatTime(m.ts)}</time>
      </div>
      <p>${escapeHtml(m.text)}</p>
    `;
    list.appendChild(el);
    if (m.ts > state.chatSince) state.chatSince = m.ts;
  });
  list.scrollTop = list.scrollHeight;
}

async function pullChat(fixtureId, { initial = false } = {}) {
  const list = $('#chat-list');
  if (!list) return;
  try {
    const q = !initial && state.chatSince ? `?since=${state.chatSince}` : '';
    const data = await authFetch(`/chat/${fixtureId}${q}`);
    appendChatMessages(list, data.messages || [], { replace: initial });
  } catch {
    if (initial) list.innerHTML = `<div class="chat-empty">Чат временно недоступен</div>`;
  }
}

function mountChat(fixtureId) {
  stopChatPolling();
  state.chatFixtureId = fixtureId;
  state.chatSince = 0;
  const root = $('#chat-root');
  if (!root) return;

  root.innerHTML = `
    <div class="chat">
      <div class="chat-list" id="chat-list"><div class="chat-empty">Загрузка чата…</div></div>
      ${state.user ? `
        <form class="chat-form" id="chat-form">
          <input type="text" name="text" maxlength="280" placeholder="Написать в чат матча…" autocomplete="off" required>
          <button type="submit">Отправить</button>
        </form>
      ` : `
        <div class="chat-login">
          <span>Чтобы писать в чат, войдите в аккаунт</span>
          <button type="button" class="btn-auth btn-auth--solid" id="chat-need-auth">Войти</button>
        </div>
      `}
    </div>
  `;

  $('#chat-need-auth')?.addEventListener('click', () => openAuth('login'));
  $('#chat-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.querySelector('input[name="text"]');
    const text = String(input?.value || '').trim();
    if (!text) return;
    try {
      const data = await authFetch(`/chat/${fixtureId}`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      if (input) input.value = '';
      appendChatMessages($('#chat-list'), [data.message]);
    } catch (ex) {
      alert(ex.message);
    }
  });

  pullChat(fixtureId, { initial: true }).then(() => {
    state.chatTimer = setInterval(() => pullChat(fixtureId), 2500);
  });
}

function toEmbed(url) {
  if (!url) return null;
  const raw = url.trim();

  let m = raw.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)([\w-]{6,})/i);
  if (m) return { type: 'iframe', src: `https://www.youtube.com/embed/${m[1]}?autoplay=1` };

  m = raw.match(/youtube\.com\/embed\/([\w-]{6,})/i);
  if (m) return { type: 'iframe', src: raw };

  m = raw.match(/twitch\.tv\/([\w]+)/i);
  if (m && !raw.includes('/videos/')) {
    const parent = location.hostname || '127.0.0.1';
    return { type: 'iframe', src: `https://player.twitch.tv/?channel=${m[1]}&parent=${parent}&autoplay=true` };
  }

  m = raw.match(/kick\.com\/([\w-]+)/i);
  if (m) return { type: 'iframe', src: `https://player.kick.com/${m[1]}` };

  if (/\.m3u8(\?|$)/i.test(raw)) return { type: 'hls', src: raw };
  if (/\.(mp4|webm)(\?|$)/i.test(raw)) return { type: 'video', src: raw };
  if (/^https?:\/\//i.test(raw)) return { type: 'iframe', src: raw };
  return null;
}

function renderStreamPlayer(payload) {
  const stream = payload?.stream;
  const locked = !!payload?.locked;
  const price = payload?.price || state.pricing.price || 45;

  if (locked) {
    return `
      <div class="stream-box__head">
        <div class="stream-box__badge">Трансляция</div>
        <div class="stream-box__meta">${escapeHtml(stream?.title || 'Эфир доступен по подписке')}</div>
      </div>
      <div class="stream-lock">
        <div class="stream-lock__icon">▶</div>
        <h3>Смотреть матч</h3>
        <p>Подписка открывает плеер на 30 дней</p>
        <div class="stream-lock__price">${price} ₽</div>
        <button type="button" class="btn-auth btn-auth--solid" id="stream-buy">
          ${state.user ? 'Оформить подписку' : 'Войти и купить'}
        </button>
      </div>
    `;
  }

  if (!stream?.url) {
    return `
      <div class="stream-empty">
        <div class="stream-box__badge">Трансляция</div>
        <p>Эфир ещё не подключен</p>
        <span>Админ подключит ссылку в панели модерации</span>
        <div class="stream-id">ID матча: <code id="copy-fid">${escapeHtml(state.activeFixtureId || '')}</code></div>
      </div>
    `;
  }

  const emb = toEmbed(stream.url);
  let player = `<div class="stream-empty"><p>Не удалось встроить ссылку</p></div>`;
  if (emb?.type === 'iframe') {
    player = `<div class="stream-player"><iframe src="${escapeHtml(emb.src)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
  } else if (emb?.type === 'video' || emb?.type === 'hls') {
    player = `<div class="stream-player"><video controls autoplay playsinline src="${escapeHtml(emb.src)}"></video></div>`;
  }
  return `
    <div class="stream-box__head">
      <div class="stream-box__badge">В эфире</div>
      <div class="stream-box__meta">${escapeHtml(stream.title || 'Прямая трансляция')}${stream.by ? ` · ${escapeHtml(stream.by)}` : ''}</div>
    </div>
    ${player}
  `;
}

function renderStreamAdmin(fixtureId, stream) {
  if (!state.user || state.user.role !== 'admin') return '';
  return `
    <div class="stream-admin">
      <h4>Админ: эфир матча #${escapeHtml(fixtureId)}</h4>
      <form class="stream-form" id="stream-form">
        <input type="url" name="url" placeholder="https://youtube.com/watch?v=..." value="${escapeHtml(stream?.url || '')}">
        <input type="text" name="title" placeholder="Название эфира" value="${escapeHtml(stream?.title || '')}">
        <div class="stream-form__actions">
          <button type="submit" class="btn-save">Сохранить</button>
          <button type="button" class="btn-clear" id="stream-clear">Убрать</button>
        </div>
      </form>
      <p class="auth-error" id="stream-error" hidden></p>
    </div>
  `;
}

async function mountMediaStage(fixtureId) {
  state.activeFixtureId = fixtureId;
  const stage = $('#media-stage');
  if (!stage) return;

  let payload = { stream: null, locked: false };
  try {
    payload = await authFetch(`/streams/${fixtureId}`);
  } catch { /* empty */ }

  const playerCol = $('#stream-box');
  if (playerCol) {
    playerCol.innerHTML = `${renderStreamPlayer(payload)}${renderStreamAdmin(fixtureId, payload.stream)}`;
  }

  $('#stream-buy')?.addEventListener('click', () => {
    if (!state.user) openAuth('register');
    else openSubscription();
  });

  $('#stream-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const err = $('#stream-error');
    try {
      await authFetch(`/streams/${fixtureId}`, {
        method: 'PUT',
        body: JSON.stringify({
          url: String(fd.get('url') || '').trim(),
          title: String(fd.get('title') || '').trim(),
        }),
      });
      await mountMediaStage(fixtureId);
    } catch (ex) {
      if (err) { err.hidden = false; err.textContent = ex.message; }
    }
  });

  $('#stream-clear')?.addEventListener('click', async () => {
    try {
      await authFetch(`/streams/${fixtureId}`, { method: 'DELETE' });
      await mountMediaStage(fixtureId);
    } catch (ex) {
      const err = $('#stream-error');
      if (err) { err.hidden = false; err.textContent = ex.message; }
    }
  });

  mountChat(fixtureId);
}

/* ---------- match detail ---------- */

const STATUS_RU = {
  TBD: 'Время уточняется',
  NS: 'Не начался',
  '1H': 'Первый тайм',
  HT: 'Перерыв',
  '2H': 'Второй тайм',
  ET: 'Доп. время',
  BT: 'Перерыв (доп.)',
  P: 'Пенальти',
  SUSP: 'Приостановлен',
  INT: 'Прерван',
  FT: 'Завершён',
  AET: 'Завершён (доп.)',
  PEN: 'Завершён (пен.)',
  PST: 'Перенесён',
  CANC: 'Отменён',
  ABD: 'Прерван',
  AWD: 'Техническое поражение',
  WO: 'Неявка',
  LIVE: 'В эфире',
};

function statusRu(fx) {
  const short = fx?.fixture?.status?.short;
  const base = STATUS_RU[short] || fx?.fixture?.status?.long || '—';
  const el = fx?.fixture?.status?.elapsed;
  if (el && LIVE_SHORT.has(short)) return `${base} · ${el}′`;
  return base;
}

function eventLabel(ev) {
  const t = (ev.type || '').toLowerCase();
  const d = (ev.detail || '').toLowerCase();
  if (t === 'goal') {
    if (d.includes('own')) return 'Автогол';
    if (d.includes('penalty')) return 'Гол (пен.)';
    if (d.includes('missed')) return 'Незабитый пен.';
    return 'Гол';
  }
  if (t === 'card') {
    if (d.includes('red') || d.includes('second')) return 'Красная';
    return 'Жёлтая';
  }
  if (t === 'subst') return 'Замена';
  if (t === 'var') return `VAR · ${ev.detail || ''}`.trim();
  return ev.detail || ev.type || 'Событие';
}

function eventClass(ev) {
  const t = (ev.type || '').toLowerCase();
  const d = (ev.detail || '').toLowerCase();
  if (t === 'goal') return 'ev--goal';
  if (t === 'card' && (d.includes('red') || d.includes('second'))) return 'ev--red';
  if (t === 'card') return 'ev--yellow';
  if (t === 'subst') return 'ev--sub';
  return 'ev--misc';
}

function renderEvents(events, homeId) {
  if (!events?.length) {
    return `<div class="empty empty--sm">Событий пока нет</div>`;
  }
  return `
    <ul class="timeline">
      ${events.map((ev) => {
        const home = ev.team?.id === homeId;
        const extra = ev.time?.extra ? `+${ev.time.extra}` : '';
        let who = ev.player?.name || ev.team?.name || '';
        let note = '';
        if (ev.type === 'subst' && ev.assist?.name) {
          who = `${ev.player?.name || '?'} → ${ev.assist.name}`;
        } else if (ev.assist?.name && (ev.type || '').toLowerCase() === 'goal') {
          note = `<small>ассист: ${escapeHtml(ev.assist.name)}</small>`;
        }
        return `
          <li class="timeline__item ${home ? 'is-home' : 'is-away'} ${eventClass(ev)}">
            <div class="timeline__min">${ev.time?.elapsed ?? '—'}′${extra}</div>
            <div class="timeline__body">
              <strong>${escapeHtml(eventLabel(ev))}</strong>
              <span>${escapeHtml(who)}</span>
              ${note}
            </div>
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

function renderStats(stats) {
  if (!stats || stats.length < 2) {
    return `<div class="empty empty--sm">Статистика появится во время / после матча</div>`;
  }
  const home = stats[0];
  const away = stats[1];
  const map = new Map();
  home.statistics.forEach((s) => map.set(s.type, { home: s.value, away: null, type: s.type }));
  away.statistics.forEach((s) => {
    const row = map.get(s.type) || { home: null, away: null, type: s.type };
    row.away = s.value;
    map.set(s.type, row);
  });

  const rows = [...map.values()].map((row) => {
    const hv = row.home ?? 0;
    const av = row.away ?? 0;
    const hn = typeof hv === 'string' && hv.endsWith('%') ? parseFloat(hv) : Number(hv) || 0;
    const an = typeof av === 'string' && av.endsWith('%') ? parseFloat(av) : Number(av) || 0;
    const sum = hn + an || 1;
    const hp = Math.round((hn / sum) * 100);
    const ap = 100 - hp;
    return `
      <div class="stat-row">
        <div class="stat-row__vals">
          <span>${escapeHtml(hv ?? '0')}</span>
          <em>${escapeHtml(row.type)}</em>
          <span>${escapeHtml(av ?? '0')}</span>
                    </div>
        <div class="stat-row__bar">
          <i style="width:${hp}%"></i>
          <b style="width:${ap}%"></b>
                </div>
                    </div>
    `;
  }).join('');

  return `
    <div class="stats-head">
      <span><img src="${escapeHtml(home.team.logo)}" alt=""> ${escapeHtml(home.team.name)}</span>
      <span><img src="${escapeHtml(away.team.logo)}" alt=""> ${escapeHtml(away.team.name)}</span>
                </div>
    <div class="stats-list">${rows}</div>
  `;
}

function renderLineups(lineups) {
  if (!lineups?.length) {
    return `<div class="empty empty--sm">Составы ещё не опубликованы</div>`;
  }
  return `
    <div class="lineups">
      ${lineups.map((side) => `
        <div class="lineup">
          <div class="lineup__head">
            <img src="${escapeHtml(side.team.logo)}" alt="">
            <div>
              <strong>${escapeHtml(side.team.name)}</strong>
              <small>${escapeHtml(side.formation || 'схема —')} · тренер: ${escapeHtml(side.coach?.name || '—')}</small>
            </div>
          </div>
          <h4>Старт</h4>
          <ul class="lineup__list">
            ${(side.startXI || []).map((p) => `
              <li><b>${escapeHtml(p.player.number ?? '—')}</b> ${escapeHtml(p.player.name)} <em>${escapeHtml(p.player.pos || '')}</em></li>
            `).join('')}
          </ul>
          <h4>Запас</h4>
          <ul class="lineup__list lineup__list--bench">
            ${(side.substitutes || []).map((p) => `
              <li><b>${escapeHtml(p.player.number ?? '—')}</b> ${escapeHtml(p.player.name)}</li>
            `).join('') || '<li>Нет данных</li>'}
          </ul>
        </div>
      `).join('')}
    </div>
  `;
}

function scoreBlock(fx) {
  const score = scoreText(fx);
  const ht = fx.score?.halftime;
  const ft = fx.score?.fulltime;
  const et = fx.score?.extratime;
  const pen = fx.score?.penalty;
  return `
    <div class="sheet-scoreline">
      <div>
        <img src="${escapeHtml(fx.teams.home.logo)}" alt="">
        <div>${escapeHtml(fx.teams.home.name)}</div>
      </div>
      <div class="sheet-scoreline__num">
        ${score ? `${score.h} : ${score.a}` : formatTime(fx.fixture.date)}
        <small>${escapeHtml(statusRu(fx))}</small>
      </div>
      <div>
        <img src="${escapeHtml(fx.teams.away.logo)}" alt="">
        <div>${escapeHtml(fx.teams.away.name)}</div>
      </div>
    </div>
    <div class="score-breakdown">
      ${ht?.home != null ? `<span>1-й тайм ${ht.home}:${ht.away}</span>` : ''}
      ${ft?.home != null ? `<span>Основное ${ft.home}:${ft.away}</span>` : ''}
      ${et?.home != null ? `<span>Доп. ${et.home}:${et.away}</span>` : ''}
      ${pen?.home != null ? `<span>Пен. ${pen.home}:${pen.away}</span>` : ''}
    </div>
  `;
}

async function openFixture(fx) {
  const body = $('#sheet-body');
  const id = fx.fixture.id;
  state.activeFixtureId = id;

  body.innerHTML = `
    <p class="sheet-kicker">${escapeHtml(fx.league.country)} · ${escapeHtml(fx.league.name)} · ${escapeHtml(fx.league.round || '')} · ID ${escapeHtml(id)}</p>
    <h2 class="sheet-title">${escapeHtml(fx.teams.home.name)} — ${escapeHtml(fx.teams.away.name)}</h2>
    ${scoreBlock(fx)}

    <div class="media-stage" id="media-stage">
      <div class="stream-box" id="stream-box">
        <div class="stream-empty">
          <div class="stream-box__badge">Трансляция</div>
          <p>Загрузка плеера…</p>
        </div>
      </div>
      <aside class="chat-side">
        <div class="chat-side__head">Чат матча</div>
        <div id="chat-root"></div>
      </aside>
    </div>

    <ul class="sheet-meta">
      <li><span>Дата</span><strong>${escapeHtml(new Date(fx.fixture.date).toLocaleString('ru-RU', { timeZone: TZ }))}</strong></li>
      <li><span>Стадион</span><strong>${escapeHtml(fx.fixture.venue?.name || '—')}</strong></li>
      <li><span>Город</span><strong>${escapeHtml(fx.fixture.venue?.city || '—')}</strong></li>
      <li><span>Судья</span><strong>${escapeHtml(fx.fixture.referee || '—')}</strong></li>
      <li><span>Сезон</span><strong>${escapeHtml(fx.league.season || '—')}</strong></li>
    </ul>
    <div class="match-tabs" id="match-tabs">
      <button type="button" class="match-tabs__btn is-on" data-tab="events">События</button>
      <button type="button" class="match-tabs__btn" data-tab="stats">Статистика</button>
      <button type="button" class="match-tabs__btn" data-tab="lineups">Составы</button>
    </div>
    <div class="match-tab-panels">
      <div class="match-panel is-on" data-panel="events"><div class="empty empty--sm">Загрузка событий…</div></div>
      <div class="match-panel" data-panel="stats" hidden><div class="empty empty--sm">Загрузка статистики…</div></div>
      <div class="match-panel" data-panel="lineups" hidden><div class="empty empty--sm">Загрузка составов…</div></div>
            </div>
        `;
  stopChatPolling();
  $('#sheet').showModal();

  $$('#match-tabs .match-tabs__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#match-tabs .match-tabs__btn').forEach((b) => b.classList.toggle('is-on', b === btn));
      $$('.match-panel').forEach((p) => {
        const on = p.dataset.panel === btn.dataset.tab;
        p.hidden = !on;
        p.classList.toggle('is-on', on);
      });
    });
  });

  const [evData, stData, lnData, fxData] = await Promise.all([
    apiGet('fixtures/events', { fixture: id }).catch(() => ({ response: [] })),
    apiGet('fixtures/statistics', { fixture: id }).catch(() => ({ response: [] })),
    apiGet('fixtures/lineups', { fixture: id }).catch(() => ({ response: [] })),
    apiGet('fixtures', { id }).catch(() => ({ response: [] })),
  ]);

  const fresh = fxData?.response?.[0] || fx;
  if (fxData?.response?.[0]) {
    const title = body.querySelector('.sheet-title');
    const kicker = body.querySelector('.sheet-kicker');
    const tmp = document.createElement('div');
    tmp.innerHTML = scoreBlock(fresh);
    const oldScore = body.querySelector('.sheet-scoreline');
    const oldBreak = body.querySelector('.score-breakdown');
    const newScore = tmp.querySelector('.sheet-scoreline');
    const newBreak = tmp.querySelector('.score-breakdown');
    if (oldScore && newScore) oldScore.replaceWith(newScore);
    if (oldBreak && newBreak) oldBreak.replaceWith(newBreak);
    if (kicker) kicker.textContent = `${fresh.league.country} · ${fresh.league.name} · ${fresh.league.round || ''} · ID ${id}`;
    if (title) title.textContent = `${fresh.teams.home.name} — ${fresh.teams.away.name}`;
  }

  body.querySelector('[data-panel="events"]').innerHTML = renderEvents(evData?.response || [], fresh.teams.home.id);
  body.querySelector('[data-panel="stats"]').innerHTML = renderStats(stData?.response || []);
  body.querySelector('[data-panel="lineups"]').innerHTML = renderLineups(lnData?.response || []);
  await mountMediaStage(id);
}

function openTeam(team) {
  $('#sheet-body').innerHTML = `
    <div class="sheet-scoreline" style="grid-template-columns:auto 1fr;text-align:left">
      <img src="${escapeHtml(team.logo)}" alt="" style="width:72px;height:72px;margin:0">
      <div>
        <p class="sheet-kicker">${escapeHtml(team.country || '')}</p>
        <h2 class="sheet-title" style="margin:0">${escapeHtml(team.name)}</h2>
      </div>
    </div>
    <ul class="sheet-meta">
      <li><span>Основан</span><strong>${escapeHtml(team.founded || '—')}</strong></li>
      <li><span>Стадион</span><strong>${escapeHtml(team.venue || '—')}</strong></li>
      <li><span>Город</span><strong>${escapeHtml(team.city || '—')}</strong></li>
    </ul>
  `;
  $('#sheet').showModal();
}

/* ---------- data load ---------- */

async function loadFixturesForSelectedDay() {
  const day = addDays(new Date(), state.dateOffset);
  const iso = toISO(day);
  const feed = $('#fixtures-feed');
  feed.innerHTML = `<div class="empty">Загрузка матчей на ${formatRu(day)}…</div>`;
  try {
    const data = await apiGet('fixtures', { date: iso, timezone: TZ });
    state.fixtures = data?.response || [];
    fillLeagueFilter();
    updateHeroStats();
    renderFeed(feed, state.fixtures);
    setPill(`${state.fixtures.length} матчей`, true);
  } catch (err) {
    console.error(err);
    feed.innerHTML = `<div class="empty">Не удалось загрузить матчи. Обновите страницу чуть позже.</div>`;
    setPill('Офлайн', false);
  }
}

async function loadLive() {
  try {
    const data = await apiGet('fixtures', { live: 'all' });
    state.live = data?.response || [];
    renderLiveMini();
    updateHeroStats();
    if (state.view === 'live') {
      renderFeed($('#live-feed'), state.live);
    }
  } catch (err) {
    console.error(err);
    $('#live-mini').innerHTML = `<div class="empty empty--sm">Live недоступен</div>`;
  }
}

/* ---------- navigation ---------- */

function switchView(name) {
  state.view = name;
  $$('.nav__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  $$('.view').forEach((v) => {
    const on = v.dataset.panel === name;
    v.hidden = !on;
    v.classList.toggle('is-on', on);
  });
  location.hash = name;
  $('#main-nav').classList.remove('is-open');

  if (name === 'live') renderFeed($('#live-feed'), state.live);
  if (name === 'tables') renderTablesView();
  if (name === 'teams') renderTeamsView();
  if (name === 'matches') renderFeed($('#fixtures-feed'), state.fixtures);
}

function bindUI() {
  $$('[data-view]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(el.dataset.view);
    });
  });

  $('#burger')?.addEventListener('click', () => {
    $('#main-nav').classList.toggle('is-open');
  });

  $('#league-filter')?.addEventListener('change', (e) => {
    state.leagueFilter = e.target.value;
    renderFeed($('#fixtures-feed'), state.fixtures);
  });

  $$('#status-filter .seg__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.statusFilter = btn.dataset.status;
      $$('#status-filter .seg__btn').forEach((b) => b.classList.toggle('is-on', b === btn));
      renderFeed($('#fixtures-feed'), state.fixtures);
    });
});

  $('#tables-league')?.addEventListener('change', () => renderTablesView());
  $('#teams-league')?.addEventListener('change', () => renderTeamsView());
  $('#refresh-live')?.addEventListener('click', async () => {
    state.cache.delete('fixtures?live=all');
    await loadLive();
  });

  $('#sheet-close')?.addEventListener('click', () => {
    stopChatPolling();
    $('#sheet').close();
  });
  $('#sheet')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      stopChatPolling();
      e.currentTarget.close();
    }
  });
  $('#sheet')?.addEventListener('close', () => stopChatPolling());

  $('#btn-login')?.addEventListener('click', () => openAuth('login'));
  $('#btn-register')?.addEventListener('click', () => openAuth('register'));
  $('#auth-close')?.addEventListener('click', () => {
    showAuthStep('form');
    $('#auth-sheet').close();
  });
  $('#auth-sheet')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      showAuthStep('form');
      e.currentTarget.close();
    }
  });

  $$('#auth-tabs .auth-tabs__btn').forEach((btn) => {
    btn.addEventListener('click', () => openAuth(btn.dataset.mode));
  });

  $('#btn-buy-sub')?.addEventListener('click', () => buySubscription());
  $('#btn-skip-sub')?.addEventListener('click', () => {
    showAuthStep('form');
    state.authRequired = false;
    const sheet = $('#auth-sheet');
    sheet?.classList.remove('is-forced');
    sheet?.close();
    if (state.activeFixtureId) mountMediaStage(state.activeFixtureId);
  });

  $('#auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const err = $('#auth-error');
    const ok = $('#auth-ok');
    if (err) { err.hidden = true; err.textContent = ''; }
    if (ok) { ok.hidden = true; ok.textContent = ''; }

    try {
      if (state.authMode === 'profile') {
        const data = await authFetch('/auth/profile', {
          method: 'PUT',
          body: JSON.stringify({ name: String(fd.get('name') || '').trim() }),
        });
        state.user = data.user;
        renderAuthSlot();
        if (ok) { ok.hidden = false; ok.textContent = 'Имя сохранено'; }
        return;
      }

      const payload = {
        login: String(fd.get('login') || '').trim().toLowerCase(),
        email: String(fd.get('email') || '').trim().toLowerCase(),
        password: String(fd.get('password') || ''),
        password2: String(fd.get('password2') || ''),
        name: String(fd.get('name') || '').trim() || String(fd.get('login') || '').trim().toLowerCase(),
        captchaId: String(fd.get('captchaId') || state.captchaId || ''),
        captchaAnswer: String(fd.get('captchaAnswer') || '').trim(),
      };
      const path = state.authMode === 'register' ? '/auth/register' : '/auth/login';
      const data = await authFetch(path, { method: 'POST', body: JSON.stringify(payload) });
      state.user = data.user;
      state.authRequired = false;
      if (data.pricing) state.pricing = data.pricing;
      renderAuthSlot();
      form.reset();
      await Promise.all([loadFixturesForSelectedDay(), loadLive(), renderRailTable()]);

      if (data.offerSubscription && !isSubscribed()) {
        openSubscription();
      } else {
        const sheet = $('#auth-sheet');
        sheet?.classList.remove('is-forced');
        sheet?.close();
        if (state.activeFixtureId) await mountMediaStage(state.activeFixtureId);
      }
    } catch (ex) {
      if (err) {
        err.hidden = false;
        err.textContent = ex.message;
      }
      await loadAuthCaptcha();
    }
  });

  $('#auth-captcha-refresh')?.addEventListener('click', () => loadAuthCaptcha());

  $('#auth-sheet')?.addEventListener('cancel', (e) => {
    if (state.authRequired && !state.user) e.preventDefault();
  });
}

async function loadAuthCaptcha() {
  const visual = $('#auth-captcha-visual');
  const form = $('#auth-form');
  try {
    const data = await authFetch('/auth/captcha');
    state.captchaId = data.id;
    if (form?.captchaId) form.captchaId.value = data.id;
    if (form?.captchaAnswer) form.captchaAnswer.value = '';
    if (visual) {
      visual.innerHTML = data.svg || `<span>${escapeHtml(data.question)} = ?</span>`;
    }
  } catch {
    if (visual) visual.innerHTML = '<span>Капча недоступна</span>';
  }
}

async function init() {
  bindUI();
  fillLeagueSelects();
  renderDateTabs();

  const hash = (location.hash || '#matches').slice(1);
  if (['matches', 'live', 'tables', 'teams'].includes(hash)) {
    switchView(hash);
  }

  setPill('Загрузка…', true);
  await runBootSequence();

  try {
    await apiGet('status');
    setPill('Онлайн', true);
  } catch {
    setPill('Офлайн', false);
  }

  if (state.user) {
    await Promise.all([loadFixturesForSelectedDay(), loadLive(), renderRailTable()]);
  }
}

document.addEventListener('DOMContentLoaded', init);
