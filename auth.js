// Авторизация дашборда: пароль задаётся в settings.json (auth.password).
// Пустой пароль = авторизация выключена — оверлей не показывается, всё работает как раньше.
//
// В APK (window.WALLET_STANDALONE) пароль хранится локально — в настройках
// приложения (walletSettings.appPassword), серверного login.php там нет: проверка
// идёт на месте. Разблокировка — флаг в памяти страницы: перезапуск/пересоздание
// активности запирают снова, а уход в фон зовёт MainActivity onPause →
// __walletRelock() (процесс WebView переживает «закрыл-открыл»).
//
// Сессия передаётся двумя равнозначными путями: cookie wallet_auth (ставит сервер)
// и заголовок X-Wallet-Auth с токеном из localStorage. Запасной путь нужен для
// браузеров, которые не сохраняют/не шлют cookie (приватный режим, блокировки) —
// без него вход выглядел бы бесконечным: страница перезагружается, а сессии нет.
const WalletAuth = (() => {
    // Относительная база: работает и в корне (php -S), и под префиксом /wallet (Herd)
    const BASE = '.';
    const TOKEN_KEY = 'walletAuthToken';
    const standalone = () => !!window.WALLET_STANDALONE;
    let authRequired = false;
    let appUnlocked = false; // вводили пароль в этой жизни страницы (только APK)

    const storedToken = () => {
        try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
    };

    // Пароль APK из walletSettings (без загрузки всего модуля настроек)
    const storedAppPassword = () => {
        try {
            const raw = localStorage.getItem('walletSettings');
            if (!raw) return '';
            const s = JSON.parse(raw);
            return typeof s.appPassword === 'string' ? s.appPassword : '';
        } catch (e) { return ''; }
    };

    // --- Обёртка над fetch: добавляет X-Wallet-Auth ко same-origin запросам ---
    // Устанавливается до app.js/dashboard.js, поэтому покрывает все запросы приложения.
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    if (origFetch) {
        window.fetch = (url, opts = {}) => {
            const token = storedToken();
            if (token) {
                const u = String(url);
                const sameOrigin = !/^https?:\/\//i.test(u) || u.indexOf(location.origin) === 0;
                if (sameOrigin) {
                    const headers = Object.assign({}, opts.headers || {});
                    const has = Object.keys(headers).some(k => k.toLowerCase() === 'x-wallet-auth');
                    if (!has) {
                        headers['X-Wallet-Auth'] = token;
                        opts = Object.assign({}, opts, { headers });
                    }
                }
            }
            return origFetch(url, opts);
        };
    }

    function show(message) {
        const ov = document.getElementById('loginOverlay');
        if (!ov) return;
        document.body.classList.add('auth-lock');
        ov.hidden = false;
        const err = document.getElementById('loginError');
        if (err) err.textContent = message || '';
        const inp = document.getElementById('loginPassword');
        if (inp) setTimeout(() => { try { inp.focus(); } catch (e) { /* jsdom */ } }, 50);
    }

    function hide() {
        const ov = document.getElementById('loginOverlay');
        if (ov) ov.hidden = true;
        document.body.classList.remove('auth-lock');
    }

    async function submit(e) {
        if (e) e.preventDefault();
        const inp = document.getElementById('loginPassword');
        const err = document.getElementById('loginError');
        const btn = document.getElementById('loginSubmit');
        if (!inp || !btn) return;
        err.textContent = '';
        btn.disabled = true;

        // APK: сверяем локально, сервера нет
        if (standalone()) {
            if (inp.value !== '' && inp.value === storedAppPassword()) {
                appUnlocked = true;
                hide();
            } else {
                err.textContent = 'Неверный пароль';
                btn.disabled = false;
            }
            inp.value = '';
            return;
        }

        try {
            const r = await fetch(BASE + '/login.php', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: inp.value })
            });
            const s = await r.json();
            if (!s.success) {
                err.textContent = s.error || 'Неверный пароль';
                btn.disabled = false;
                return;
            }
            // Запасной путь: сервер прислал токен — храним, обёртка fetch приложит его
            // ко всем запросам, даже если cookie не сохранился.
            if (s.token) {
                try { localStorage.setItem(TOKEN_KEY, s.token); } catch (e) { /* localStorage недоступен */ }
            }
            // Прежде чем перезагружать страницу, убеждаемся, что сервер видит сессию
            // (cookie или токен) — иначе reload покажет этот же оверлей, и вход
            // будет выглядеть бесконечным.
            const check = await fetch(BASE + '/login.php', { cache: 'no-store', credentials: 'same-origin' });
            const st = await check.json();
            if (st.authenticated) {
                location.reload(); // чистая инициализация: календарь + дашборд перечитают всё с сервера
            } else {
                err.textContent = 'Вход принят, но сессия не подтвердилась (' + location.host + '). ' +
                    'Проверьте, что вы открыли приложение по тому же адресу, где входили ' +
                    '(localhost и 127.0.0.1 — разные адреса), и что браузер не блокирует cookies и localStorage.';
                btn.disabled = false;
            }
        } catch (ex) {
            err.textContent = 'Сервер недоступен';
            btn.disabled = false;
        }
    }

    async function logout() {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
        try {
            await fetch(BASE + '/login.php', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'logout' })
            });
        } catch (e) { /* даже при ошибке — перезагружаем, cookie истечёт сам */ }
        location.reload();
    }

    async function init() {
        // APK: локальный пароль, без сервера. Выхода нет — запирает на холодном
        // старте, пересоздании активности и после ухода в фон (__walletRelock)
        if (standalone()) {
            authRequired = storedAppPassword() !== '';
            const lb = document.getElementById('logoutBtn');
            if (lb) lb.hidden = true;
            if (authRequired && !appUnlocked) show();
            else if (authRequired) hide();
            return;
        }

        let status = null;
        try {
            const r = await fetch(BASE + '/login.php', { cache: 'no-store', credentials: 'same-origin' });
            status = await r.json();
        } catch (e) { /* сервер недоступен — свои ошибки покажет app.js */ }
        authRequired = !!(status && status.authRequired);
        const btn = document.getElementById('logoutBtn');
        if (btn) btn.hidden = !authRequired;
        if (authRequired && !(status && status.authenticated)) show();
        else if (authRequired) hide();
    }

    // Скрипты подключены в конце body — элементы уже доступны
    const form = document.getElementById('loginForm');
    if (form) form.addEventListener('submit', submit);
    const btn = document.getElementById('logoutBtn');
    if (btn) btn.addEventListener('click', logout);
    // Возврат по «Назад» из bfcache восстанавливает старое состояние DOM (возможно, с оверлеем)
    window.addEventListener('pageshow', (e) => { if (e.persisted) init(); });
    init();

    // Перезапирание из Java (MainActivity.onPause): приложение ушло в фон —
    // при возврате пароль спросится заново (флаг в памяти гасим сразу)
    window.__walletRelock = function () {
        if (standalone() && storedAppPassword() !== '') {
            appUnlocked = false;
            show();
        }
    };

    return {
        show, hide, submit, logout, init,
        get enabled() { return authRequired; }
    };
})();
window.WalletAuth = WalletAuth;
