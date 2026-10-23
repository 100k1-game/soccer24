const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = { user: null, tab: 'dash', chatTimer: null };

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  const n = ts > 1e12 ? ts : ts * 1000;
  return new Date(n).toLocaleString('ru-RU');
}

function showApp(on) {
  const gate = $('#admin-gate');
  const app = $('#admin-app');
  if (gate) gate.hidden = !!on;
  if (app) app.hidden = !on;
  if (on && state.user) {
    const who = $('#admin-who');
    if (who) who.textContent = `${state.user.name} · @${state.user.login}`;
  }
}

async function ensureAdmin() {
  const me = await api('/auth/me');
  if (!me.user || me.user.role !== 'admin') {
    state.user = null;
    showApp(false);
    await loadGateCaptcha();
    return false;
  }
  state.user = me.user;
  $('#admin-who').textContent = `${me.user.name} · @${me.user.login}`;
  showApp(true);
  return true;
}

async function loadGateCaptcha() {
  const visual = $('#gate-captcha-visual');
  const form = $('#admin-login');
  try {
    const data = await api('/auth/captcha');
    if (form?.captchaId) form.captchaId.value = data.id;
    if (form?.captchaAnswer) form.captchaAnswer.value = '';
    if (visual) {
      visual.innerHTML = data.svg || `<span>${esc(data.question)} = ?</span>`;
    }
  } catch {
    if (visual) visual.innerHTML = '<span>Капча недоступна</span>';
  }
}

async function loadDash() {
  const s = await api('/admin/stats');
  $('#admin-stats').innerHTML = [
    ['Пользователи', s.users],
    ['Подписки', s.subscribers],
    ['Забанено', s.banned],
    ['Эфиры', s.streams],
    ['Сообщения', s.messages],
    ['Выручка ₽', s.revenue],
  ].map(([label, val]) => `
    <div class="admin-stat"><strong>${esc(val)}</strong><span>${esc(label)}</span></div>
  `).join('');
}

async function loadChat() {
  const data = await api('/admin/chats?limit=100');
  const box = $('#mod-chat');
  if (!data.messages?.length) {
    box.innerHTML = `<div class="admin-hint">Сообщений пока нет</div>`;
    return;
  }
  box.innerHTML = data.messages.map((m) => `
    <article class="mod-item">
      <div>
        <div class="mod-item__meta">матч #${esc(m.fixtureId)} · ${fmtTime(m.ts)}</div>
        <strong>@${esc(m.login)}</strong> · ${esc(m.name)}
        <p>${esc(m.text)}</p>
      </div>
      <div class="admin-actions">
        <button type="button" class="danger" data-del="${esc(m.fixtureId)}:${esc(m.id)}">Удалить</button>
        <button type="button" class="danger" data-ban="${esc(m.userId)}">Бан</button>
      </div>
    </article>
  `).join('');

  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const [fid, mid] = btn.dataset.del.split(':');
      await api(`/admin/chat/${fid}/${mid}`, { method: 'DELETE' });
      await loadChat();
    });
  });
  box.querySelectorAll('[data-ban]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Забанить пользователя?')) return;
      await api(`/admin/users/${btn.dataset.ban}`, {
        method: 'PUT',
        body: JSON.stringify({ banned: true }),
      });
      await loadUsers();
      alert('Пользователь заблокирован');
    });
  });
}

async function loadStreams() {
  const data = await api('/admin/streams');
  const box = $('#admin-streams');
  if (!data.streams?.length) {
    box.innerHTML = `<div class="admin-hint">Активных эфиров нет</div>`;
    return;
  }
  box.innerHTML = data.streams.map((s) => `
    <article class="admin-list-item">
      <div>
        <strong>Матч #${esc(s.fixtureId)}</strong>
        <div>${esc(s.title || 'Эфир')}</div>
        <small>${esc(s.url)} · ${esc(s.by || '')}</small>
      </div>
      <div class="admin-actions">
        <button type="button" class="danger" data-rm="${esc(s.fixtureId)}">Снять</button>
      </div>
    </article>
  `).join('');
  box.querySelectorAll('[data-rm]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/streams/${btn.dataset.rm}`, { method: 'DELETE' });
      await loadStreams();
    });
  });
}

async function loadUsers() {
  const data = await api('/admin/users');
  const wrap = $('#admin-users');
  wrap.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Пользователь</th>
          <th>Роль</th>
          <th>Подписка</th>
          <th>Статус</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${data.users.map((u) => `
          <tr>
            <td>
              <strong>${esc(u.name)}</strong><br>
              <small>@${esc(u.login)}</small>
            </td>
            <td>${u.role === 'admin' ? '<span class="badge badge--admin">admin</span>' : 'user'}</td>
            <td>${u.subscribed ? '<span class="badge badge--sub">активна</span>' : 'нет'}</td>
            <td>${u.banned ? '<span class="badge badge--ban">бан</span>' : 'ок'}</td>
            <td>
              <div class="admin-actions">
                ${u.login === 'admin' ? '' : `
                  <button type="button" class="ok" data-grant="${esc(u.id)}">+30д</button>
                  <button type="button" data-revoke="${esc(u.id)}">Снять</button>
                  <button type="button" class="danger" data-toggle-ban="${esc(u.id)}" data-banned="${u.banned ? '1' : '0'}">
                    ${u.banned ? 'Разбан' : 'Бан'}
                  </button>
                `}
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('[data-grant]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/admin/users/${btn.dataset.grant}`, { method: 'PUT', body: JSON.stringify({ grantSub: true }) });
      await loadUsers();
      await loadDash();
    });
  });
  wrap.querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/admin/users/${btn.dataset.revoke}`, { method: 'PUT', body: JSON.stringify({ revokeSub: true }) });
      await loadUsers();
      await loadDash();
    });
  });
  wrap.querySelectorAll('[data-toggle-ban]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const banned = btn.dataset.banned !== '1';
      await api(`/admin/users/${btn.dataset.toggleBan}`, {
        method: 'PUT',
        body: JSON.stringify({ banned }),
      });
      await loadUsers();
      await loadDash();
    });
  });
}

async function loadPay() {
  const data = await api('/admin/payments');
  const wrap = $('#admin-pay');
  if (!data.payments?.length) {
    wrap.innerHTML = `<div class="admin-hint">Платежей пока нет</div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>Когда</th><th>Кто</th><th>Сумма</th><th>Метод</th><th>Статус</th></tr></thead>
      <tbody>
        ${data.payments.map((p) => `
          <tr>
            <td>${fmtTime(p.ts)}</td>
            <td>@${esc(p.login)}</td>
            <td>${esc(p.amount)} ₽</td>
            <td>${esc(p.method)}</td>
            <td>${esc(p.status)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function refreshAll() {
  if (!(await ensureAdmin())) return;
  await loadDash();
  if (state.tab === 'chat') await loadChat();
  if (state.tab === 'streams') await loadStreams();
  if (state.tab === 'users') await loadUsers();
  if (state.tab === 'pay') await loadPay();
}

async function switchTab(tab) {
  state.tab = tab;
  const titles = {
    dash: 'Обзор',
    chat: 'Модерация чата',
    streams: 'Трансляции',
    users: 'Пользователи',
    pay: 'Платежи',
  };
  const heading = $('#admin-heading');
  if (heading) heading.textContent = titles[tab] || 'Панель';
  $$('.admin-nav button').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === tab));
  $$('.admin-panel').forEach((p) => {
    const on = p.dataset.panel === tab;
    p.hidden = !on;
  });
  if (state.chatTimer) {
    clearInterval(state.chatTimer);
    state.chatTimer = null;
  }
  try {
    await refreshAll();
  } catch (ex) {
    console.error('switchTab', ex);
  }
  if (tab === 'chat') {
    state.chatTimer = setInterval(() => loadChat().catch(() => {}), 4000);
  }
}

function bind() {
  $('#admin-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const err = $('#gate-error');
    if (err) {
      err.hidden = true;
      err.textContent = '';
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Вход…';
    }
    try {
      const login = String(fd.get('login') || '').trim().toLowerCase();
      const password = String(fd.get('password') || '');
      const captchaId = String(fd.get('captchaId') || '');
      const captchaAnswer = String(fd.get('captchaAnswer') || '').trim();
      if (!login || !password) throw new Error('Введите логин и пароль');
      if (!captchaAnswer) throw new Error('Решите капчу');

      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login, password, captchaId, captchaAnswer }),
      });
      if (!data.user || data.user.role !== 'admin') {
        throw new Error('Этот аккаунт не является администратором');
      }
      state.user = data.user;
      showApp(true);
      await switchTab('dash');
    } catch (ex) {
      console.error('admin login', ex);
      if (err) {
        err.hidden = false;
        err.textContent = ex.message || 'Не удалось войти';
      }
      showApp(false);
      await loadGateCaptcha();
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Войти в панель';
      }
    }
  });

  $('#admin-logout')?.addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST', body: '{}' }); } catch { /* */ }
    if (state.chatTimer) clearInterval(state.chatTimer);
    showApp(false);
    await loadGateCaptcha();
  });

  $('#gate-captcha-refresh')?.addEventListener('click', () => loadGateCaptcha());

  $$('.admin-nav button').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('#admin-refresh')?.addEventListener('click', () => refreshAll());

  $('#stream-admin-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const err = $('#stream-admin-err');
    const ok = $('#stream-admin-ok');
    err.hidden = true;
    ok.hidden = true;
    try {
      const id = String(fd.get('fixtureId') || '').trim();
      await api(`/streams/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          url: String(fd.get('url') || '').trim(),
          title: String(fd.get('title') || '').trim(),
        }),
      });
      ok.hidden = false;
      ok.textContent = 'Трансляция сохранена';
      form.reset();
      await loadStreams();
      await loadDash();
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message;
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  bind();
  try {
    if (await ensureAdmin()) switchTab('dash');
  } catch {
    showApp(false);
    await loadGateCaptcha();
  }
});
