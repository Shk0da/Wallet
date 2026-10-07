// settings.js — модалка «⚙️ Настройки»: токены брокеров, утренние уведомления,
// экспорт/импорт данных, о приложении.
//
// Секции «Брокеры» и «Уведомления» имеют класс standalone-only: в веб-версии
// они скрыты CSS (токены и крон живут на сервере в settings.json), в APK —
// видны. Хранение — localStorage['walletSettings']:
//   { tinkoffToken, finamToken, trustAllCerts, notifications: { enabled, hour, minute } }
//
// При сохранении: обновляется снапшот для Java (WalletBackup.persistSnapshot),
// перепланируется будильник (WalletAndroid.scheduleNotification) и стреляет
// событие wallet:settings-changed (sync-client.js перечитает токены).
const WalletSettings = (() => {

    const KEY = 'walletSettings';
    const THEME_KEY = 'walletTheme'; // тема устройства — отдельно от настроек-данных

    const defaults = () => ({
        tinkoffToken: '',
        finamToken: '',
        appPassword: '',              // пароль на вход (только APK); пусто — вход без пароля
        trustAllCerts: true,          // паритет с sync.php: российские CA доверяют всем
        notifications: { enabled: false, hour: 8, minute: 0 },
        autoSync: { enabled: false, hour: 9, minute: 0 }  // раз в день при открытом приложении
    });

    function load() {
        try {
            const raw = localStorage.getItem(KEY);
            if (!raw) return defaults();
            const s = JSON.parse(raw);
            const d = defaults();
            return {
                // trim при чтении: лечит хвостовой перевод строки, сохранённый
                // до фикса (мобильная вставка; Finam отвечал на такой секрет 401)
                tinkoffToken: typeof s.tinkoffToken === 'string' ? s.tinkoffToken.trim() : '',
                finamToken: typeof s.finamToken === 'string' ? s.finamToken.trim() : '',
                // пароль не триммим: пробелы в нём допустимы как часть значения
                appPassword: typeof s.appPassword === 'string' ? s.appPassword : '',
                // настройка из UI убрана: всегда доверяем (как на сервере),
                // иначе корпоративный TLS-инспектор валит запросы к брокерам
                trustAllCerts: true,
                notifications: {
                    enabled: !!(s.notifications && s.notifications.enabled),
                    hour: clampInt(s.notifications && s.notifications.hour, 0, 23, 8),
                    minute: clampInt(s.notifications && s.notifications.minute, 0, 59, 0)
                },
                autoSync: {
                    enabled: !!(s.autoSync && s.autoSync.enabled),
                    hour: clampInt(s.autoSync && s.autoSync.hour, 0, 23, 9),
                    minute: clampInt(s.autoSync && s.autoSync.minute, 0, 59, 0)
                }
            };
        } catch (e) {
            return defaults();
        }
    }

    function clampInt(v, min, max, fallback) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    // ---------- Серверные настройки (веб): токены брокеров и пароль ----------

    const isStandalone = () => !!window.WALLET_STANDALONE;

    // Статус с сервера: токены «задан/не задан» + хвост для placeholder,
    // пароль включён или нет. Веб-режим, вызывается при открытии модалки.
    async function refreshServerStatus() {
        let st = null;
        try {
            const r = await fetch('./settings.php', { cache: 'no-store', credentials: 'same-origin' });
            if (r.ok) st = await r.json();
        } catch (e) { /* сервер недоступен — плейсхолдеры по умолчанию */ }
        const t = document.getElementById('setTinkoffToken');
        const f = document.getElementById('setFinamToken');
        if (t && st && st.success && st.tinkoff) t.placeholder = st.tinkoff.set ? 'задан ' + st.tinkoff.tail + ' — введите новый' : 'не задан';
        if (f && st && st.success && st.finam) f.placeholder = st.finam.set ? 'задан ' + st.finam.tail + ' — введите новый' : 'не задан';
        const row = document.getElementById('setAuthDisableRow');
        if (row) row.hidden = !(st && st.success && st.passwordSet);
        const hint = row && row.parentNode ? row.parentNode.querySelector('.settings-hint') : null;
        if (hint && st && st.success) {
            hint.textContent = st.passwordSet
                ? 'Пароль включён. Пустое поле — не менять, галочка — выключить вход вовсе.'
                : 'Пароль выключен — если задать, календарь и портфель откроются только после входа.';
        }
    }

    // Отправка изменений на сервер. Токены шлём только если введены (пусто = не
    // менять), пароль — если введён или отмечено «Отключить».
    async function saveServerSettings() {
        const payload = {};
        // trim: мобильная вставка тянет за собой перевод строки/пробел —
        // Finam отвечает на такой секрет 401 «Api token could not be verified»
        const t = ((document.getElementById('setTinkoffToken') || {}).value || '').trim();
        const f = ((document.getElementById('setFinamToken') || {}).value || '').trim();
        if (t) payload.tinkoffToken = t;
        if (f) payload.finamToken = f;
        const pwd = (document.getElementById('setAuthPassword') || {}).value || '';
        const disable = !!((document.getElementById('setAuthDisable') || {}).checked);
        if (pwd) payload.password = pwd;
        else if (disable) payload.password = '';

        if (Object.keys(payload).length) {
            const r = await fetch('./settings.php', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const resp = await r.json().catch(() => ({ success: false, error: 'Сервер недоступен' }));
            if (!resp.success) throw new Error(resp.error || 'Сервер не сохранил настройки');
            // Смена пароля инвалидирует сессии — принимаем свежий токен
            if (resp.token) {
                try { localStorage.setItem('walletAuthToken', resp.token); } catch (e) { /* cookie останется */ }
            }
        }
    }

    // opts.reschedule — перепланировать будильник и обновить снапшот (по умолчанию true)
    function save(s, opts) {
        const settings = {
            // trim и здесь: лечит уже сохранённое значение с хвостовым
            // переводом строки (Finam отвечал на такой секрет 401)
            tinkoffToken: String(s.tinkoffToken || '').trim(),
            finamToken: String(s.finamToken || '').trim(),
            appPassword: typeof s.appPassword === 'string' ? s.appPassword : '',
            trustAllCerts: true,
            notifications: {
                enabled: !!(s.notifications && s.notifications.enabled),
                hour: clampInt(s.notifications && s.notifications.hour, 0, 23, 8),
                minute: clampInt(s.notifications && s.notifications.minute, 0, 59, 0)
            },
            autoSync: {
                enabled: !!(s.autoSync && s.autoSync.enabled),
                hour: clampInt(s.autoSync && s.autoSync.hour, 0, 23, 9),
                minute: clampInt(s.autoSync && s.autoSync.minute, 0, 59, 0)
            }
        };
        try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* приватный режим */ }

        if (!opts || opts.reschedule !== false) {
            if (window.WalletAndroid && WalletAndroid.scheduleNotification) {
                try {
                    const n = settings.notifications;
                    WalletAndroid.scheduleNotification(n.enabled, n.hour, n.minute);
                } catch (e) { /* мост недоступен — веб-режим */ }
            }
            if (window.WalletBackup) WalletBackup.persistSnapshot();
            document.dispatchEvent(new CustomEvent('wallet:settings-changed'));
        }
        return settings;
    }

    // ---------- Модалка ----------

    // Тёмная тема: класс на <html> (токены переопределены в CSS), статус-бар — через мост.
    function themeIsDark() {
        try { return localStorage.getItem(THEME_KEY) === 'dark'; } catch (e) { return false; }
    }

    function applyTheme(dark) {
        document.documentElement.classList.toggle('dark', !!dark);
        try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) { /* приватный режим */ }
        if (window.WalletAndroid && WalletAndroid.setStatusBarTheme) {
            try { WalletAndroid.setStatusBarTheme(!!dark); } catch (e) { /* не APK */ }
        }
    }

    function open() {
        applyToForm(load());
        const m = document.getElementById('settingsModal');
        if (m) m.classList.add('active');
        if (!isStandalone()) {
            // Веб: поля токенов/пароля — только «что ввести новое», не значения
            set('setTinkoffToken', '');
            set('setFinamToken', '');
            set('setAuthPassword', '');
            check('setAuthDisable', false);
            refreshServerStatus();
        }
    }

    function close() {
        const m = document.getElementById('settingsModal');
        if (m) m.classList.remove('active');
    }

    function applyToForm(s) {
        set('setTinkoffToken', s.tinkoffToken);
        set('setFinamToken', s.finamToken);
        // Пароль на вход (APK): само значение не показываем — только состояние
        set('setAppPassword', '');
        const passOn = s.appPassword !== '';
        const ap = document.getElementById('setAppPassword');
        if (ap) ap.placeholder = passOn ? 'задан — введите новый, чтобы сменить' : 'пусто — не менять';
        const row = document.getElementById('setAppPassDisableRow');
        if (row) row.hidden = !passOn;
        check('setAppPassDisable', false);
        const hint = document.getElementById('setAppPassHint');
        if (hint) hint.textContent = passOn
            ? 'Пароль включён: приложение спросит его при запуске.'
            : 'Пароль не задан — приложение открывается сразу.';
        check('setNotifyEnabled', s.notifications.enabled);
        check('setDarkTheme', themeIsDark());
        const time = document.getElementById('setNotifyTime');
        if (time) {
            time.value = ('0' + s.notifications.hour).slice(-2) + ':' +
                         ('0' + s.notifications.minute).slice(-2);
        }
        check('setAutoSync', !!(s.autoSync && s.autoSync.enabled));
        const autoTime = document.getElementById('setAutoSyncTime');
        if (autoTime) {
            autoTime.value = ('0' + clampInt(s.autoSync && s.autoSync.hour, 0, 23, 9)).slice(-2) + ':' +
                             ('0' + clampInt(s.autoSync && s.autoSync.minute, 0, 59, 0)).slice(-2);
        }
        const v = document.getElementById('settingsVersion');
        if (v) {
            v.textContent = window.WalletAndroid && WalletAndroid.appVersion
                ? 'v' + WalletAndroid.appVersion()
                : '(веб-версия)';
        }
    }

    function set(id, value) {
        const el = document.getElementById(id);
        if (el) el.value = value;
    }

    function check(id, value) {
        const el = document.getElementById(id);
        if (el) el.checked = !!value;
    }

    function saveFromForm() {
        applyTheme(!!(document.getElementById('setDarkTheme') || {}).checked);

        // Веб: токены и пароль живут на сервере — сначала туда; при ошибке
        // модалка остаётся открытой, чтобы ввод не потерялся
        if (!isStandalone()) {
            saveServerSettings().then(() => {
                if (window.toast) toast('Настройки сохранены');
                close();
            }, (e) => {
                if (window.toast) toast('Ошибка: ' + (e && e.message ? e.message : 'сервер недоступен'));
            });
            return;
        }

        let time = { hour: 8, minute: 0 };
        const timeEl = document.getElementById('setNotifyTime');
        if (timeEl && /^\d{2}:\d{2}$/.test(timeEl.value || '')) {
            const parts = timeEl.value.split(':');
            time = { hour: parseInt(parts[0], 10), minute: parseInt(parts[1], 10) };
        }
        const enabled = !!(document.getElementById('setNotifyEnabled') || {}).checked;

        let autoT = { hour: 9, minute: 0 };
        const autoEl = document.getElementById('setAutoSyncTime');
        if (autoEl && /^\d{2}:\d{2}$/.test(autoEl.value || '')) {
            const ap = autoEl.value.split(':');
            autoT = { hour: parseInt(ap[0], 10), minute: parseInt(ap[1], 10) };
        }
        const autoOn = !!(document.getElementById('setAutoSync') || {}).checked;

        // Пароль: непустое поле — новый пароль; галка «Отключить» — убрать;
        // пусто и без галки — текущий не меняется
        const cur = load();
        const pwd = (document.getElementById('setAppPassword') || {}).value || '';
        const pwdOff = !!((document.getElementById('setAppPassDisable') || {}).checked);

        save({
            tinkoffToken: ((document.getElementById('setTinkoffToken') || {}).value || '').trim(),
            finamToken: ((document.getElementById('setFinamToken') || {}).value || '').trim(),
            appPassword: pwd !== '' ? pwd : (pwdOff ? '' : cur.appPassword),
            trustAllCerts: true,
            notifications: { enabled, hour: time.hour, minute: time.minute },
            autoSync: { enabled: autoOn, hour: autoT.hour, minute: autoT.minute }
        });

        // Разрешение на уведомления запрашиваем в момент включения (Android 13+)
        if (enabled && window.WalletAndroid && WalletAndroid.requestNotificationsPermission) {
            try { WalletAndroid.requestNotificationsPermission(); } catch (e) { /* не APK */ }
        }
        if (window.toast) toast('Настройки сохранены');
        close();
    }

    // «?» у полей токенов: показать/спрятать пояснение, откуда брокер выдаёт токен.
    // Делегирование на верхнем уровне модуля (не в DOMContentLoaded) — событие
    // может прилететь и в jsdom-харнессе повторно, двойной подписки быть не должно
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.hint-btn') : null;
        if (!btn) return;
        const box = document.getElementById(btn.getAttribute('data-hint'));
        if (!box) return;
        box.hidden = !box.hidden;
        btn.setAttribute('aria-expanded', String(!box.hidden));
    });

    // Клик по подложке закрывает модалку (как у остальных)
    document.addEventListener('DOMContentLoaded', () => {
        // Класс на <html> бут-скрипт в index.html уже поставил (без вспышки
        // светлого); здесь догоняет статус-бар Android — мост доступен с загрузки
        if (themeIsDark()) applyTheme(true);
        const overlay = document.getElementById('settingsModal');
        if (overlay) {
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        }
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    });

    return { load, save, open, close, saveFromForm, applyTheme };
})();
window.WalletSettings = WalletSettings;

function openSettingsModal() { WalletSettings.open(); }
function closeSettingsModal() { WalletSettings.close(); }
function saveSettings() { WalletSettings.saveFromForm(); }
