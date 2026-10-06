/**
 * dashboard.js — вид «Портфель»: синхронизация, KPI, графики, прогноз, жесты
 *
 * Данные: portfolio.json (пишет sync.php) — единый источник правды.
 * Конфиг инвестиций: investmentConfig из app.js (data.json через api.php).
 * Синхронизация: POST /wallet/sync.php → NDJSON-стрим (события по строке),
 * прогресс-бар растёт по event:log, брокерские чипы — по broker_status.
 *
 * Безопасность: все строки из API попадают в DOM через textContent.
 */
(() => {
    'use strict';

    // Относительная база: работает и в корне (php -S), и под префиксом /wallet (Herd)
    const BASE = '.';
    const $ = id => document.getElementById(id);

    const BROKER_TITLES = { tinkoff: 'Т-Инвестиции', finam: 'Финам' };
    const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

    // Периоды плашки роста портфеля (клик по плашке циклит их, выбор запоминается)
    // Предполагаемая инфляция для расчёта прогноза в сегодняшних рублях
    const INFLATION_DEFAULT = 14.5;

    const GROWTH_PERIODS = [
        { days: 31, label: 'за месяц' },
        { days: 183, label: 'за 6 мес' },
        { days: 365, label: 'за год' }
    ];
    function loadGrowthPeriod() {
        try {
            const v = parseInt(localStorage.getItem('wallet-growth-period'), 10);
            return (v === 1 || v === 2) ? v : 0;
        } catch (e) { return 0; }
    }

    // Русское склонение: 1 год, 2-4 года, 5-20 лет
    function yearsWord(n) {
        const n10 = n % 10, n100 = n % 100;
        if (n10 === 1 && n100 !== 11) return 'год';
        if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return 'года';
        return 'лет';
    }

    const state = {
        portfolio: null,
        syncing: false,
        horizonYears: 20,
        histRange: 0,          // период графика истории: 183/365/0 (всё)
        growthPeriod: loadGrowthPeriod(), // плашка роста: 0=месяц, 1=6 мес, 2=год
        yieldTouched: { tinkoff: false, finam: false }, // юзер печатает в поле доходности — не затирать авто
        showEmptyAccounts: (() => { try { return localStorage.getItem('wallet-accounts-empty') === '1'; } catch (e) { return false; } })(),
        amountTouched: false, // двигал ли пользователь слайдер взноса
        inflationTouched: false, // двигал ли пользователь слайдер инфляции
        htSort: { key: 'value', dir: -1 }, // сортировка таблицы активов
        htExpanded: false,     // показаны все активы (а не первые 15)
        htQuery: ''            // поисковый фильтр таблицы
    };

    // ---------- Мелкие хелперы ----------

    let toastEl = null;
    function toast(message) {
        if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
        toastEl.textContent = message;
        toastEl.classList.add('show');
        clearTimeout(toastEl._t);
        toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 3400);
    }

    function debounce(fn, ms) {
        let t = 0;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    function todayISO() {
        const d = new Date();
        return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }

    function fmtDateTime(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        if (isNaN(d)) return '—';
        return d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    }

    /** Тумблер «График / Таблица» — табличный близнец обязателен у каждого графика.
     *  opts.defaultTable: начать с таблицы (так открываем «пироги»-донаты). */
    function withTableToggle(container, chartNode, opts) {
        container.textContent = '';
        const body = document.createElement('div');
        body.className = 'chart-body';
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'chart-table-btn'; btn.textContent = 'Таблица';
        const controls = document.createElement('div');
        controls.className = 'chart-controls';
        controls.appendChild(btn);
        let table = null;
        const toggle = () => {
            if (btn.textContent === 'Таблица') {
                if (!table && typeof chartNode._table === 'function') table = chartNode._table();
                if (!table) return;
                chartNode.style.display = 'none';
                body.appendChild(table);
                btn.textContent = 'График';
            } else {
                chartNode.style.display = '';
                if (table && table.parentNode) table.parentNode.removeChild(table);
                btn.textContent = 'Таблица';
            }
        };
        btn.addEventListener('click', toggle);
        body.appendChild(chartNode);
        container.append(controls, body);
        if (opts && opts.defaultTable) toggle();
    }

    // ---------- Переключение видов ----------

    function setView(view) {
        document.body.classList.toggle('dashboard-mode', view === 'dashboard');
        document.body.classList.toggle('balance-mode', view === 'balance');
        for (const b of document.querySelectorAll('#viewNav .view-btn')) {
            b.classList.toggle('active', b.dataset.view === view);
        }
        // Шапка соответствует активному виду
        const h1 = document.querySelector('header h1');
        if (h1) h1.textContent = view === 'dashboard' ? '📈 Портфель'
            : (view === 'balance' ? '📊 Баланс по дням' : '📅 Финансовый календарь');
        try { localStorage.setItem('walletView', view); } catch (e) { /* приватный режим */ }
        window.scrollTo({ top: 0 });
        // Экран «Баланс по дням» строится лениво при входе (app.js)
        if (view === 'balance' && window.__walletShowBalance) window.__walletShowBalance();
        // Взнос из календаря мог измениться — прогноз всегда свежий при входе на вкладку
        if (view === 'dashboard' && state.portfolio && investmentConfig) renderForecast();
    }

    // ---------- Разделы портфеля (переключаются из меню ☰) ----------

    const PF_SECTIONS = ['overview', 'assets', 'payouts', 'forecast'];

    function setPfSection(section) {
        if (PF_SECTIONS.indexOf(section) === -1) section = 'overview';
        const content = $('dashboardContent');
        if (content) content.setAttribute('data-section', section);
        try { localStorage.setItem('walletPfSection', section); } catch (e) { /* приватный режим */ }
    }

    // ---------- Загрузка portfolio.json ----------

    async function loadPortfolio() {
        // Автономный режим: последний результат синхронизации лежит в localStorage
        if (window.WALLET_STANDALONE) {
            try {
                state.portfolio = JSON.parse(localStorage.getItem('walletPortfolio') || 'null');
            } catch (e) {
                state.portfolio = null;
            }
            renderPortfolio();
            return;
        }
        try {
            const resp = await fetch(BASE + '/portfolio.php?t=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            state.portfolio = await resp.json();
        } catch (e) {
            state.portfolio = null;
        }
        renderPortfolio();
    }

    // ---------- Рендер ----------

    function renderPortfolio() {
        const empty = $('dashboardEmpty'), content = $('dashboardContent');
        const p = state.portfolio;
        if (!p || !p.totals) {
            empty.hidden = false;
            content.hidden = true;
            return;
        }
        empty.hidden = true;
        content.hidden = false;
        renderSyncMeta();
        renderKpis(p);
        renderHistoryChart(p);
        renderBrokerDonut(p);
        renderTypeDonut(p);
        renderSectors(p);
        renderPaymentsChart(p);
        renderPaymentsCalendar(p);
        renderHoldingsTable(p);
        renderAccounts(p);
        renderGoal(p);
        renderForecast();
    }

    function renderSyncMeta() {
        const p = state.portfolio;
        $('syncLastTime').textContent = (p.meta && p.meta.mock ? 'Демо-данные · ' : 'Последняя синхронизация: ') + fmtDateTime(p.meta && p.meta.generatedAt);
        for (const b of ['tinkoff', 'finam']) {
            const chip = $(b === 'tinkoff' ? 'chipTinkoff' : 'chipFinam');
            const info = p.meta && p.meta.brokers ? p.meta.brokers[b] : null;
            chip.classList.remove('ok', 'error', 'running');
            if (!info || !info.configured) { chip.classList.add('absent'); continue; }
            chip.classList.remove('absent');
            if (info.status === 'ok') chip.classList.add('ok');
            else if (info.status === 'error') { chip.classList.add('error'); chip.title = info.error || ''; }
        }
    }

    function kpiCard(icon, label, value, sub, subCls, sub2, sub2Cls) {
        const card = document.createElement('div');
        card.className = 'kpi';
        const head = document.createElement('div'); head.className = 'kpi-head';
        const i = document.createElement('span'); i.className = 'kpi-icon'; i.textContent = icon;
        const l = document.createElement('span'); l.className = 'kpi-label'; l.textContent = label;
        head.append(i, l);
        const v = document.createElement('div'); v.className = 'kpi-value'; v.textContent = value;
        card.append(head, v);
        if (sub != null) {
            const s = document.createElement('div'); s.className = 'kpi-sub' + (subCls ? ' ' + subCls : '');
            s.textContent = sub;
            card.appendChild(s);
        }
        if (sub2 != null) {
            const s = document.createElement('div'); s.className = 'kpi-sub kpi-sub2' + (sub2Cls ? ' ' + sub2Cls : '');
            s.textContent = sub2;
            card.appendChild(s);
        }
        return card;
    }

    /** «за день ±»: по двум последним снапшотам истории; history<2 → null */
    function dayDelta(p, field) {
        const hist = Array.isArray(p.history) ? p.history : [];
        if (hist.length < 2) return null;
        const last = hist[hist.length - 1], prev = hist[hist.length - 2];
        if (last[field] == null || prev[field] == null) return null;
        const d = last[field] - prev[field];
        return { text: (d >= 0 ? '+' : '−') + Charts.fmt.compact(Math.abs(d)) + ' за день', cls: d >= 0 ? 'pos' : 'neg' };
    }

    /** Плашка роста портфеля в KPI «Стоимость»: клик циклит месяц → полгода → год */
    function growthPlate(p) {
        const plate = document.createElement('button');
        plate.type = 'button';
        plate.className = 'growth-plate';
        const period = GROWTH_PERIODS[state.growthPeriod] || GROWTH_PERIODS[0];
        const hist = Array.isArray(p.history) ? p.history : [];
        const last = hist[hist.length - 1];
        const target = new Date(Date.now() - period.days * 86400000).toISOString().slice(0, 10);
        // базовая точка — последний снапшот не новее target (история отсортирована по дате)
        let base = null;
        for (const h of hist) {
            if (!h.date) continue;
            if (h.date <= target) { if (h.value != null) base = h; }
            else break;
        }
        if (!last || !base || !(base.value > 0)) {
            plate.classList.add('muted');
            plate.textContent = '— ' + period.label;
            plate.title = 'История короче периода: плашка оживёт, когда накопятся синхронизации';
        } else {
            const d = (last.value || 0) - base.value;
            const pct = d / base.value * 100;
            plate.classList.add(d >= 0 ? 'pos' : 'neg');
            plate.textContent = (d >= 0 ? '▲ +' : '▼ −') + Charts.fmt.pct(Math.abs(pct)) + ' ' + period.label;
            plate.title = 'Стоимость: ' + (d >= 0 ? '+' : '−') + Charts.fmt.compact(Math.abs(d)) +
                ' · клик — сменить период (месяц → полгода → год)';
        }
        plate.addEventListener('click', () => {
            state.growthPeriod = (state.growthPeriod + 1) % GROWTH_PERIODS.length;
            try { localStorage.setItem('wallet-growth-period', String(state.growthPeriod)); } catch (e) {}
            renderKpis(state.portfolio);
        });
        return plate;
    }

    function renderKpis(p) {
        const t = p.totals;
        const row = $('kpiRow');
        row.textContent = '';
        const dValue = dayDelta(p, 'value');
        const dPnl = dayDelta(p, 'pnl');
        const valueCard = kpiCard('🏦', 'Стоимость', Charts.fmt.compact(t.value),
            'активы ' + Charts.fmt.compact(Math.max(0, (t.value || 0) - (t.cash || 0))) + ' + кэш ' + Charts.fmt.compact(t.cash),
            null, dValue ? dValue.text : null, dValue ? dValue.cls : null);
        valueCard.insertBefore(growthPlate(p), valueCard.querySelector('.kpi-sub'));
        row.appendChild(valueCard);
        row.appendChild(kpiCard('💰', 'Вложено', Charts.fmt.compact(t.cost), 'кэш у брокеров: ' + Charts.fmt.compact(t.cash)));
        row.appendChild(kpiCard('📈', 'Прибыль', (t.pnl >= 0 ? '+' : '') + Charts.fmt.compact(t.pnl),
            t.cost > 0 ? (t.pnl >= 0 ? '+' : '') + Charts.fmt.pct(t.pnlPct) + ' от вложений' : '—', t.pnl >= 0 ? 'pos' : 'neg',
            dPnl ? dPnl.text : null, dPnl ? dPnl.cls : null));
        row.appendChild(kpiCard('💵', 'Пассивный доход', Charts.fmt.compact(t.paymentsNext12m) + '/год',
            '≈ ' + Charts.fmt.compact((t.paymentsNext12m || 0) / 12) + '/мес'));
        row.appendChild(kpiCard('🪙', 'Пассивная доходность', Charts.fmt.pct(t.passiveYieldPct), '% годовых от стоимости'));
        // Выплаты в текущем месяце из paymentsByMonth
        const now = new Date();
        const curMonth = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2);
        const cm = (t.paymentsByMonth || []).find(m => m.month === curMonth);
        const cmCoupons = cm ? (cm.coupons || 0) : 0, cmDiv = cm ? (cm.dividends || 0) : 0;
        row.appendChild(kpiCard('🗓', 'Выплаты в этом месяце',
            Charts.fmt.compact(cmCoupons + cmDiv),
            (cmCoupons || cmDiv) ? 'купоны ' + Charts.fmt.compact(cmCoupons) + ' · дивиденды ' + Charts.fmt.compact(cmDiv) : 'пока не найдены',
            (cmCoupons + cmDiv) > 0 ? 'pos' : null));
    }

    function chartNote(container, text) {
        container.textContent = '';
        const note = document.createElement('p');
        note.className = 'chart-note';
        note.textContent = text;
        container.appendChild(note);
    }

    function renderHistoryChart(p) {
        const container = $('chartHistory');
        let hist = Array.isArray(p.history) ? p.history : [];
        if (hist.length < 2) {
            chartNote(container, 'График появится после второй синхронизации — история пишет один снапшот в день.');
            return;
        }
        // Период из сег-переключателя 6М/1Г/Всё (0 = всё)
        if (state.histRange > 0) {
            const cutoff = new Date(Date.now() - state.histRange * 86400000);
            const iso = cutoff.toISOString().slice(0, 10);
            const filtered = hist.filter(h => h.date >= iso);
            hist = filtered.length >= 2 ? filtered : hist.slice(-2);
        }
        const valueSeries = {
            name: 'Стоимость', color: Charts.C.primary, area: true, emphasize: true,
            points: hist.map(h => ({ x: h.date, y: h.value }))
        };
        const costSeries = {
            name: 'Вложено', color: Charts.C.deep,
            points: hist.map(h => ({ x: h.date, y: h.cost }))
        };
        withTableToggle(container, Charts.line({ series: [valueSeries, costSeries], height: 250, yFromZero: true }));
    }

    function renderBrokerDonut(p) {
        const container = $('chartBrokers');
        const bb = (p.totals.byBroker || {});
        const data = ['tinkoff', 'finam']
            .filter(b => (bb[b] ? bb[b].value : 0) > 0)
            .map(b => ({ label: BROKER_TITLES[b], value: bb[b].value, color: Charts.BROKER_COLORS[b] }));
        if (data.length === 0) {
            container.textContent = 'Нет данных о брокерах';
            return;
        }
        withTableToggle(container, Charts.donut({
            data,
            centerLabel: 'всего',
            centerValue: Charts.fmt.compact(p.totals.value)
        }), { defaultTable: true });
    }

    function renderTypeDonut(p) {
        const container = $('chartTypes');
        const byType = p.totals.byType || {};
        const order = ['share', 'bond', 'etf'];
        const extra = Object.keys(byType).filter(k => !order.includes(k) && byType[k] > 0);
        const data = [...order, ...extra]
            .filter(k => byType[k] > 0)
            .map((k, i) => ({
                label: Charts.TYPE_LABELS[k] || k,
                value: byType[k],
                color: Charts.TYPE_COLORS[k] || Charts.CATEGORICAL[i % Charts.CATEGORICAL.length]
            }));
        if (data.length === 0) { container.textContent = 'Нет позиций'; return; }
        withTableToggle(container, Charts.donut({
            data,
            centerLabel: 'активов',
            centerValue: Charts.fmt.compact(p.totals.value)
        }), { defaultTable: true });
    }

    // ---------- Секторы ----------

    const SECTOR_RU = {
        energy: 'Энергетика', financial: 'Финансы', bank: 'Банки', government: 'Госдолг',
        materials: 'Материалы', it: 'IT', tech: 'Технологии', consumer: 'Потребительский',
        retail: 'Ритейл', healthcare: 'Здравоохранение', health_care: 'Здравоохранение',
        telecom: 'Телеком', industrials: 'Промышленность', utilities: 'Коммунальные',
        estate: 'Недвижимость', real_estate: 'Недвижимость',
        other: 'Прочее'
    };

    function renderSectors(p) {
        const container = $('chartSectors');
        if (!container) return;
        const bySector = {};
        for (const h of (p.holdings || [])) {
            const label = h.sector ? (SECTOR_RU[h.sector] || h.sector) : 'Прочее';
            bySector[label] = (bySector[label] || 0) + (h.value || 0);
        }
        const entries = Object.entries(bySector).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        if (entries.length === 0 || (entries.length === 1 && entries[0][0] === 'Прочее')) {
            chartNote(container, 'Секторы появятся, когда брокер начнёт отдавать их по позициям.');
            return;
        }
        const top = entries.slice(0, 5);
        const rest = entries.slice(5);
        if (rest.length) top.push(['Другие секторы', rest.reduce((s, [, v]) => s + v, 0)]);
        const data = top.map(([label, value], i) => ({
            label, value, color: Charts.CATEGORICAL[i % Charts.CATEGORICAL.length]
        }));
        withTableToggle(container, Charts.donut({ data, centerLabel: 'секторов', centerValue: String(data.length) }), { defaultTable: true });
    }

    function renderPaymentsChart(p) {
        const container = $('chartPayments');
        const months = (p.totals.paymentsByMonth) || [];
        const groups = months.map(m => ({
            label: (m => { const [y, mo] = m.month.split('-'); return MONTHS_SHORT[+mo - 1] + (mo === '01' ? ' ’' + y.slice(2) : ''); })(m),
            segments: [
                { name: 'Купоны', value: m.coupons || 0, color: Charts.C.deep },
                { name: 'Дивиденды', value: m.dividends || 0, color: Charts.C.primary }
            ]
        }));
        if (groups.length === 0 || groups.every(g => g.segments.every(s => s.value === 0))) {
            chartNote(container, 'Предстоящие купоны и дивиденды не найдены.');
            return;
        }
        withTableToggle(container, Charts.bars({ groups, height: 230 }));
    }

    // Счёт «пустой»: нет ни стоимости позиций, ни денег
    const isEmptyAccount = a => ((a.equity || 0) <= 0) && ((a.cash || 0) <= 0);

    function renderAccounts(p) {
        const container = $('accountsList');
        container.textContent = '';
        const accounts = p.accounts || [];
        const btn = $('accEmptyToggle');
        if (accounts.length === 0) {
            container.textContent = 'Счета не найдены';
            if (btn) btn.hidden = true;
            return;
        }
        // пустые счета по умолчанию скрыты
        const emptyCount = accounts.filter(isEmptyAccount).length;
        const visible = state.showEmptyAccounts ? accounts : accounts.filter(a => !isEmptyAccount(a));
        if (btn) {
            btn.hidden = emptyCount === 0;
            btn.textContent = state.showEmptyAccounts ? 'Скрыть пустые' : 'Показать пустые (' + emptyCount + ')';
        }
        if (visible.length === 0) {
            container.textContent = 'Непустых счетов нет — покажите пустые';
            return;
        }
        for (const a of visible) {
            const item = document.createElement('div');
            item.className = 'account-item';
            const left = document.createElement('div');
            const name = document.createElement('div');
            name.className = 'acc-name';
            const dot = document.createElement('span');
            dot.className = 'acc-broker-dot';
            dot.style.background = Charts.BROKER_COLORS[a.broker] || '#E1E3E4';
            name.append(dot, document.createTextNode(a.name || BROKER_TITLES[a.broker] || a.id));
            const sub = document.createElement('div');
            sub.className = 'acc-sub';
            sub.textContent = BROKER_TITLES[a.broker] + (a.id ? ' · ' + String(a.id).slice(-6) : '') +
                (a.positionsCount ? ' · ' + a.positionsCount + ' поз.' : '') +
                ((a.futuresValue || 0) > 0 ? ' · фьючерсы: ' + Charts.fmt.compact(a.futuresValue) : '');
            left.append(name, sub);
            const right = document.createElement('div');
            right.className = 'acc-value';
            right.textContent = Charts.fmt.compact(a.equity);
            const cash = document.createElement('div');
            cash.className = 'acc-cash';
            cash.textContent = 'кэш: ' + Charts.fmt.compact(a.cash);
            right.appendChild(cash);
            item.append(left, right);
            container.appendChild(item);
        }
    }

    // ---------- Календарь будущих выплат ----------

    function renderPaymentsCalendar(p) {
        const container = $('paymentsCalendar');
        if (!container) return;
        container.textContent = '';
        const today = todayISO();
        // flatten: каждая выплата × количество бумаг
        const items = [];
        for (const h of (p.holdings || [])) {
            for (const pay of (h.payments || [])) {
                if (!pay.date || pay.date < today || !(pay.amountPerUnit > 0)) continue;
                items.push({
                    date: pay.date,
                    ticker: h.ticker || '',
                    name: h.name || h.ticker || '',
                    type: pay.type === 'dividend' ? 'dividend' : 'coupon',
                    amount: (pay.amountPerUnit || 0) * (h.quantity || 0)
                });
            }
        }
        items.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
        if (items.length === 0) {
            const note = document.createElement('p');
            note.className = 'chart-note';
            note.textContent = 'Нет запланированных выплат.';
            container.appendChild(note);
            return;
        }
        const curMonth = today.slice(0, 7);
        const groups = [
            { title: 'В этом месяце', filter: i => i.date.slice(0, 7) === curMonth },
            { title: 'Позже', filter: i => i.date.slice(0, 7) !== curMonth }
        ];
        let rendered = 0;
        for (const g of groups) {
            const rows = items.filter(g.filter).slice(0, Math.max(0, 15 - rendered));
            if (rows.length === 0) continue;
            rendered += rows.length;
            const gh = document.createElement('div');
            gh.className = 'pay-cal-group';
            gh.textContent = g.title;
            container.appendChild(gh);
            for (const it of rows) {
                const row = document.createElement('div');
                row.className = 'pay-row';
                row.dataset.date = it.date;
                const date = document.createElement('div');
                date.className = 'pay-date';
                const day = document.createElement('span'); day.className = 'pay-day';
                const dd = it.date.split('-');
                day.textContent = String(+dd[2]);
                const mon = document.createElement('span'); mon.className = 'pay-mon';
                mon.textContent = MONTHS_SHORT[+dd[1] - 1];
                date.append(day, mon);
                const who = document.createElement('div');
                who.className = 'pay-who';
                const ticker = document.createElement('span');
                ticker.className = 'pay-ticker';
                ticker.textContent = it.ticker || '—';
                const name = document.createElement('span');
                name.className = 'pay-name';
                name.textContent = it.name;
                who.append(ticker, name);
                const type = document.createElement('span');
                type.className = 'pay-type' + (it.type === 'dividend' ? ' dividend' : '');
                type.textContent = it.type === 'dividend' ? 'див' : 'купон';
                const amount = document.createElement('div');
                amount.className = 'pay-amount';
                amount.textContent = Charts.fmt.compact(it.amount);
                row.append(date, who, type, amount);
                container.appendChild(row);
            }
        }
    }

    // ---------- Полная таблица активов ----------

    const BROKER_DOT = { tcs: '#FFDD2D', tinkoff: '#FFDD2D', finam: '#428BF9' };
    const HT_COLUMNS = [
        { key: 'name', label: 'Актив', align: 'left' },
        { key: 'quantity', label: 'Кол-во' },
        { key: 'avgPrice', label: 'Средняя' },
        { key: 'cost', label: 'Вложено' },
        { key: 'value', label: 'Стоимость' },
        { key: 'pnl', label: 'Прибыль' },
        { key: 'share', label: 'Доля' },
        { key: 'yieldPct', label: 'Див-доходность' },
        { key: 'nextPay', label: 'След. выплата' },
        { key: 'brokers', label: 'Брокеры', sortable: false }
    ];

    function renderHoldingsTable(p) {
        const container = $('holdingsTable');
        if (!container) return;
        container.textContent = '';
        const all = p.holdings || [];
        $('htCount').textContent = String(all.length);
        if (all.length === 0) {
            const note = document.createElement('p');
            note.className = 'chart-note';
            note.textContent = 'Нет позиций.';
            container.appendChild(note);
            return;
        }
        const total = all.reduce((s, h) => s + (h.value || 0), 0);
        const q = state.htQuery.trim().toLowerCase();
        const list = all.map(h => {
            const nextPays = (h.payments || []).filter(x => x.date && x.amountPerUnit > 0 && x.date >= todayISO());
            nextPays.sort((a, b) => a.date < b.date ? -1 : 1);
            const next = nextPays[0];
            return {
                raw: h,
                name: h.name || h.ticker || '—',
                ticker: h.ticker || '',
                type: h.instrumentType || '',
                quantity: h.quantity,
                avgPrice: h.avgPrice,
                cost: h.cost,
                value: h.value,
                pnl: h.pnl,
                pnlPct: h.pnlPct,
                share: total > 0 ? (h.value || 0) / total * 100 : 0,
                yieldPct: h.value > 0 && h.paymentsNext12m > 0 ? h.paymentsNext12m / h.value * 100 : null,
                nextPay: next ? next.date : null,
                nextPayAmount: next ? (next.amountPerUnit || 0) * (h.quantity || 0) : null,
                brokers: h.sources || []
            };
        }).filter(h => !q || h.name.toLowerCase().includes(q) || h.ticker.toLowerCase().includes(q));

        // сортировка: null всегда в конец независимо от направления
        const { key, dir } = state.htSort;
        list.sort((a, b) => {
            const av = key === 'name' ? a.name.toLowerCase() : a[key];
            const bv = key === 'name' ? b.name.toLowerCase() : b[key];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return cmp * dir;
        });

        const table = document.createElement('table');
        table.className = 'chart-table ht-table';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const col of HT_COLUMNS) {
            const th = document.createElement('th');
            th.textContent = col.label;
            if (col.align === 'left') th.classList.add('left');
            if (col.sortable !== false) {
                th.classList.add('sortable');
                th.dataset.key = col.key;
                if (key === col.key) {
                    th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
                    th.textContent = col.label + (dir === 1 ? ' ↑' : ' ↓');
                }
            }
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const shown = state.htExpanded ? list : list.slice(0, 15);
        const tbody = document.createElement('tbody');
        for (const h of shown) {
            const tr = document.createElement('tr');
            const asset = document.createElement('td');
            const assetBox = document.createElement('div');
            assetBox.className = 'ht-asset';
            const ticker = document.createElement('span');
            ticker.className = 'ht-ticker';
            ticker.textContent = h.ticker || '—';
            const name = document.createElement('span');
            name.className = 'ht-name';
            name.textContent = h.name;
            const typeChip = document.createElement('span');
            typeChip.className = 'ht-type-chip t-' + (h.type || 'other');
            typeChip.textContent = Charts.TYPE_LABELS[h.type] || h.type || '';
            assetBox.append(ticker, name, typeChip);
            asset.appendChild(assetBox);
            const cells = [
                asset,
                cell(h.quantity != null ? (h.quantity % 1 === 0 ? h.quantity.toLocaleString('ru-RU') : h.quantity.toFixed(2)) : '—'),
                cell(h.avgPrice != null ? Charts.fmt.compact(h.avgPrice) : '—'),
                cell(Charts.fmt.compact(h.cost)),
                cell(Charts.fmt.compact(h.value)),
                cellWithSub(h.pnl != null ? (h.pnl >= 0 ? '+' : '') + Charts.fmt.compact(h.pnl) : '—',
                    h.pnlPct != null ? (h.pnl >= 0 ? '+' : '') + Charts.fmt.pct(h.pnlPct) : null,
                    h.pnl != null ? (h.pnl >= 0 ? 'ht-pos' : 'ht-neg') : null),
                cell(Charts.fmt.pct(h.share)),
                cell(h.yieldPct != null ? Charts.fmt.pct(h.yieldPct) : '—'),
                cellWithSub(h.nextPay ? h.nextPay.split('-').reverse().join('.') : '—',
                    h.nextPayAmount ? Charts.fmt.compact(h.nextPayAmount) : null, null),
                brokersCell(h.brokers)
            ];
            for (const c of cells) tr.appendChild(c);
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        container.appendChild(table);

        if (list.length > 15) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ht-toggle';
            btn.textContent = state.htExpanded ? 'Свернуть' : 'Показать все ' + list.length;
            btn.addEventListener('click', () => {
                state.htExpanded = !state.htExpanded;
                renderHoldingsTable(state.portfolio);
            });
            container.appendChild(btn);
        }
    }

    function cell(text, cls) {
        const td = document.createElement('td');
        if (cls) td.classList.add(cls);
        td.textContent = text;
        return td;
    }

    function cellWithSub(text, sub, cls, clsTd) {
        const td = document.createElement('td');
        if (clsTd) td.classList.add(clsTd);
        const main = document.createElement('div');
        if (cls) main.className = cls;
        main.textContent = text;
        td.appendChild(main);
        if (sub != null) {
            const s = document.createElement('div');
            s.className = 'kpi-sub';
            s.textContent = sub;
            td.appendChild(s);
        }
        return td;
    }

    function brokersCell(sources) {
        const td = document.createElement('td');
        const seen = new Set();
        for (const s of sources || []) {
            const norm = BROKER_DOT[s] ? (s === 'tcs' ? 'tinkoff' : s) : null;
            if (!norm || seen.has(norm)) continue;
            seen.add(norm);
            const dot = document.createElement('span');
            dot.className = 'ht-broker-dot';
            dot.style.background = BROKER_DOT[s];
            dot.title = BROKER_TITLES[norm];
            td.appendChild(dot);
        }
        if (td.childNodes.length === 0) td.textContent = '—';
        return td;
    }

    // ---------- «Моя цель» ----------

    function passivePerMonthNow(t) {
        return (t.paymentsNext12m || 0) / 12;
    }

    /** Год достижения цели при текущем взносе/доходности; null = не достигается за 20 лет */
    function goalReachYear(t) {
        const target = investmentConfig && investmentConfig.goal ? investmentConfig.goal.monthlyTarget : null;
        if (!(target > 0)) return { target: null };
        const cfg = investmentConfig;
        const brokers = configuredBrokers();
        const split = normalizedSplit();
        const bb = t.byBroker || {};
        const eff = effectiveYield(brokers.map(b => ({
            id: b,
            share: b === 'tinkoff' ? (split.tinkoff || 0) : (split.finam || 0),
            yieldPct: bb[b] ? bb[b].yieldPct : 0,
            overridePct: cfg.yieldOverrides ? cfg.yieldOverrides[b] : null
        })), cfg.defaultAnnualYieldPct);
        const fc = computeForecast({
            startValue: (t.value || 0) + (t.cash || 0),
            annualYieldPct: eff.pct,
            monthlyContribution: currentMonthlyAmount(),
            years: 20
        });
        const hit = fc.yearly.find(y => y.passiveYear / 12 >= target);
        return { target, year: hit ? hit.year : null, passiveMonthNow: passivePerMonthNow(t) };
    }

    function renderGoal(p) {
        const card = $('goalCard');
        if (!card) return;
        const cfg = investmentConfig;
        if (!cfg || !p.totals) { card.hidden = true; return; }
        card.hidden = false;
        const view = $('goalView');
        view.textContent = '';
        const editing = card.dataset.mode === 'edit';
        $('goalEditBtn').textContent = editing ? 'Отмена' : 'Изменить';

        if (editing) {
            view.appendChild(buildGoalForm(cfg));
            return;
        }

        const t = p.totals;
        const goal = goalReachYear(t);
        if (!goal.target) {
            // CTA
            const cta = document.createElement('button');
            cta.type = 'button';
            cta.className = 'goal-cta';
            cta.textContent = '🎯 Поставить цель по пассивному доходу';
            cta.addEventListener('click', () => {
                card.dataset.mode = 'edit';
                renderGoal(state.portfolio);
            });
            const sub = document.createElement('div');
            sub.className = 'goal-row';
            sub.style.color = 'var(--tui-text-2)';
            sub.style.marginTop = '10px';
            sub.textContent = 'Например: 50 000 ₽/мес — и вы живёте на купоны и дивиденды.';
            view.append(cta, sub);
            return;
        }

        const now = passivePerMonthNow(t);
        const pct = Math.min(100, goal.target > 0 ? now / goal.target * 100 : 0);
        const target = document.createElement('div');
        target.className = 'goal-target';
        target.textContent = Charts.fmt.rub(goal.target) + '/мес';
        view.appendChild(target);

        const progress = document.createElement('div');
        progress.className = 'goal-progress';
        const fill = document.createElement('div');
        fill.className = 'goal-progress-fill' + (pct >= 100 ? ' done' : '');
        fill.style.width = pct.toFixed(1) + '%';
        progress.appendChild(fill);
        view.appendChild(progress);

        const row = document.createElement('div');
        row.className = 'goal-row';
        row.textContent = Charts.fmt.compact(now) + '/мес из ' + Charts.fmt.compact(goal.target) + ' · ' + pct.toFixed(0) + '%';
        view.appendChild(row);

        const verdict = document.createElement('div');
        verdict.className = 'goal-verdict ' + (pct >= 100 ? 'ok' : (goal.year != null ? '' : 'warn'));
        if (pct >= 100) verdict.textContent = '✓ Цель достигнута — живите на купоны и дивиденды';
        else if (goal.year != null) verdict.textContent = '⚡ При текущем взносе цель достигается на ' + goal.year + '-й год';
        else verdict.textContent = '⚠ За 20 лет не достигается — увеличьте взнос или горизонт';
        view.appendChild(verdict);
    }

    function buildGoalForm(cfg) {
        const form = document.createElement('div');
        form.className = 'goal-form';
        const t = state.portfolio.totals;

        const amountLabel = document.createElement('label');
        amountLabel.textContent = 'Пассивный доход, ₽/мес';
        const amount = document.createElement('input');
        amount.type = 'number';
        amount.min = '0';
        amount.step = '1000';
        amount.placeholder = 'например, 50000';
        amount.value = cfg.goal.monthlyTarget != null ? cfg.goal.monthlyTarget : '';
        form.append(amountLabel, amount);

        const yearLabel = document.createElement('label');
        yearLabel.textContent = 'Горизонт';
        const year = document.createElement('select');
        const thisYear = new Date().getFullYear();
        const savedEnd = cfg.goal.endYear;
        let yearChosen = false;
        for (let y = thisYear + 5; y <= thisYear + 30; y += 5) {
            const opt = document.createElement('option');
            opt.value = String(y);
            opt.textContent = 'до ' + y;
            if (savedEnd === y || (!savedEnd && y === thisYear + 20)) { opt.selected = true; yearChosen = true; }
            year.appendChild(opt);
        }
        if (!yearChosen) year.value = String(savedEnd || thisYear + 20);
        form.append(yearLabel, year);

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'btn btn-primary';
        save.style.width = '100%';
        save.textContent = 'Сохранить и посчитать';
        save.addEventListener('click', () => {
            const v = parseFloat(amount.value);
            cfg.goal.monthlyTarget = v > 0 ? v : null;
            cfg.goal.endYear = +year.value || null;
            const card = $('goalCard');
            card.dataset.mode = '';
            saveConfigSoon();
            renderGoal(state.portfolio);
            renderForecast();
            toast(cfg.goal.monthlyTarget ? '🎯 Цель сохранена: ' + Charts.fmt.compact(cfg.goal.monthlyTarget) + '/мес' : 'Цель сброшена');
        });
        form.appendChild(save);

        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'goal-reset-btn';
        reset.textContent = 'Убрать цель';
        reset.addEventListener('click', () => {
            cfg.goal.monthlyTarget = null;
            cfg.goal.endYear = null;
            const card = $('goalCard');
            card.dataset.mode = '';
            saveConfigSoon();
            renderGoal(state.portfolio);
            toast('Цель убрана');
        });
        form.appendChild(reset);

        const hint = document.createElement('div');
        hint.className = 'goal-row';
        hint.style.color = 'var(--tui-text-2)';
        hint.textContent = 'Сейчас: ' + Charts.fmt.compact(passivePerMonthNow(t)) + '/мес пассивного дохода.';
        form.appendChild(hint);
        return form;
    }

    // ---------- Прогноз ----------

    function autoMonthlyAmount() {
        const cfg = investmentConfig || {};
        return monthlyInvestmentFromCalendar(cfg, transactions || [], categories || [], todayISO()).amount;
    }

    function currentMonthlyAmount() {
        const cfg = investmentConfig || {};
        if (cfg.customMonthlyAmount != null) return Math.max(0, +cfg.customMonthlyAmount || 0);
        return autoMonthlyAmount();
    }

    function configuredBrokers() {
        const meta = state.portfolio && state.portfolio.meta ? state.portfolio.meta.brokers || {} : {};
        return ['tinkoff', 'finam'].filter(b => meta[b] && meta[b].configured);
    }

    function normalizedSplit() {
        const cfg = (investmentConfig || {}).split || {};
        const brokers = configuredBrokers();
        if (brokers.length === 0) return { tinkoff: 0, finam: 0 };
        if (brokers.length === 1) { const only = {}; only[brokers[0]] = 1; return only; }
        const t = Math.max(0, +cfg.tinkoff || 0), f = Math.max(0, +cfg.finam || 0);
        const sum = t + f;
        if (sum <= 0) return { tinkoff: 0.5, finam: 0.5 };
        return { tinkoff: t / sum, finam: f / sum };
    }

    function renderForecast() {
        if (!state.portfolio || !state.portfolio.totals) return;
        const cfg = investmentConfig;
        if (!cfg) return; // календарь ещё грузится — придёт wallet:data-loaded

        const t = state.portfolio.totals;
        const brokers = configuredBrokers();
        let split = normalizedSplit();
        // пара слайдеров связана: доли всегда дают в сумме 100% —
        // если в конфиге лежат несимметричные значения, приводим к дополнительной паре
        if (brokers.length === 2
            && Math.round(+('tinkoff' in cfg.split ? cfg.split.tinkoff : 50)) + Math.round(+('finam' in cfg.split ? cfg.split.finam : 50)) !== 100) {
            const sT5 = Math.max(0, Math.min(100, Math.round(split.tinkoff * 100 / 5) * 5));
            cfg.split.tinkoff = sT5;
            cfg.split.finam = 100 - sT5;
            split = normalizedSplit();
        }
        const amount = currentMonthlyAmount();

        // --- слайдер взноса ---
        const range = $('fcAmountRange');
        const auto = autoMonthlyAmount();
        const maxAmount = Math.max(500000, Math.ceil((Math.max(auto, amount) + 1) / 50000) * 50000);
        if (+range.max !== maxAmount) range.max = String(maxAmount);
        if (!state.amountTouched) range.value = String(Math.min(amount, maxAmount));
        $('fcAmountVal').textContent = Charts.fmt.rub(amount);
        const badge = $('fcAutoBadge');
        badge.textContent = amount === 0 ? 'в календаре нет взносов категории «Инвестиции»' :
            (cfg.customMonthlyAmount != null ? 'вручную · ' : 'авто из «Инвестиции» · ');
        if (cfg.customMonthlyAmount != null && amount !== 0) {
            if (!badge.querySelector('button')) {
                const reset = document.createElement('button');
                reset.type = 'button';
                reset.textContent = 'сбросить';
                reset.className = 'link-btn';
                reset.addEventListener('click', () => {
                    cfg.customMonthlyAmount = null;
                    state.amountTouched = false;
                    saveConfigSoon();
                    renderForecast();
                });
                badge.appendChild(reset);
            }
        } else {
            badge.textContent = amount === 0 ? badge.textContent : 'авто из «Инвестиции»';
        }

        // --- распределение ---
        const rowT = $('fcSplitTinkoff').closest('.fc-control');
        const rowF = $('fcSplitFinam').closest('.fc-control');
        rowT.style.display = brokers.includes('tinkoff') ? '' : 'none';
        rowF.style.display = brokers.includes('finam') ? '' : 'none';
        if (!state.splitTouched) {
            const sT5 = Math.max(0, Math.min(100, Math.round(('tinkoff' in cfg.split ? cfg.split.tinkoff : 50) / 5) * 5));
            $('fcSplitTinkoff').value = String(sT5);
            $('fcSplitFinam').value = String(100 - sT5); // зеркало: в сумме всегда 100
        }
        const sT = split.tinkoff || 0, sF = split.finam || 0;
        $('fcSplitTinkoffVal').textContent = Math.round(sT * 100) + '% · ' + Charts.fmt.compact(amount * sT) + '/мес';
        $('fcSplitFinamVal').textContent = Math.round(sF * 100) + '% · ' + Charts.fmt.compact(amount * sF) + '/мес';

        // --- инфляция (вторая кривая и доход в сегодняшних рублях) ---
        const infRange = $('fcInflationRange');
        const inflation = cfg.inflationPct != null ? +cfg.inflationPct : INFLATION_DEFAULT;
        if (!state.inflationTouched) infRange.value = String(Math.min(30, Math.max(0, inflation)));
        $('fcInflationVal').textContent = Charts.fmt.pct(inflation) + '/год';

        // --- доходность ---
        const bb = t.byBroker || {};
        const eff = effectiveYield(brokers.map(b => ({
            id: b,
            share: b === 'tinkoff' ? sT : sF,
            yieldPct: bb[b] ? bb[b].yieldPct : 0,
            overridePct: cfg.yieldOverrides ? cfg.yieldOverrides[b] : null
        })), cfg.defaultAnnualYieldPct);
        $('fcEffectiveYield').textContent = Charts.fmt.pct(eff.pct) + ' годовых';
        $('fcDefaultNote').hidden = !eff.usesDefault;
        // Поля доходности не пустые: заполнены фактом из данных или оценкой по умолчанию
        [[$('fcYieldTinkoff'), 'tinkoff'], [$('fcYieldFinam'), 'finam']].forEach(([inp, b]) => {
            inp.disabled = !brokers.includes(b);
            const fromData = !!(bb[b] && bb[b].yieldPct > 0);
            const auto = fromData ? bb[b].yieldPct : (cfg.defaultAnnualYieldPct || 0);
            const hasOverride = !!(cfg.yieldOverrides && cfg.yieldOverrides[b] != null);
            inp.placeholder = fromData ? 'из данных' : 'нет данных';
            inp.title = bb[b] ? 'факт из данных: ' + Charts.fmt.pct(bb[b].yieldPct) : 'данных о выплатах нет';
            if (brokers.includes(b)) {
                if (hasOverride) inp.value = String(cfg.yieldOverrides[b]);
                else if (!state.yieldTouched[b]) inp.value = String(auto);
            }
        });

        // --- расчёт ---
        const startValue = (t.value || 0) + (t.cash || 0);
        const fc = computeForecast({
            startValue,
            annualYieldPct: eff.pct,
            monthlyContribution: amount,
            years: state.horizonYears,
            inflationPct: inflation
        });

        const summary = $('fcSummary');
        summary.textContent = '';
        const stat = (label, value, sub, cls, hl, sub2, sub2Cls) => {
            const d = document.createElement('div');
            d.className = 'fc-stat' + (hl ? ' hl' : '');
            const l = document.createElement('div'); l.className = 'kpi-label'; l.textContent = label;
            const v = document.createElement('strong'); v.textContent = value;
            d.append(l, v);
            if (sub) { const s = document.createElement('div'); s.className = 'kpi-sub' + (cls ? ' ' + cls : ''); s.textContent = sub; d.appendChild(s); }
            if (sub2) { const s = document.createElement('div'); s.className = 'kpi-sub' + (sub2Cls ? ' ' + sub2Cls : ''); s.textContent = sub2; d.appendChild(s); }
            summary.appendChild(d);
        };
        stat('Итог через ' + state.horizonYears + ' ' + yearsWord(state.horizonYears), Charts.fmt.compact(fc.finalValue),
            inflation > 0 ? 'в сегодняшних рублях: ' + Charts.fmt.compact(fc.finalReal) : null, null, true);
        stat('Вложено всего', Charts.fmt.compact(fc.totalInvested), 'текущие ' + Charts.fmt.compact(startValue) + ' + взносы');
        stat('Заработано', Charts.fmt.compact(fc.totalEarnings), 'проценты, купоны, дивиденды', fc.totalEarnings >= 0 ? 'pos' : 'neg');
        stat('Пассивный доход к концу', Charts.fmt.compact(fc.passiveIncomeYear) + '/год', Charts.fmt.compact(fc.passiveIncomeMonth) + '/мес', 'pos', false,
            inflation > 0 ? 'с учетом инфляции: ' + Charts.fmt.compact(fc.realPassiveIncomeYear) + '/год ≈ ' + Charts.fmt.compact(fc.realPassiveIncomeMonth) + '/мес' : null);

        // --- график (годовые точки) ---
        const chartBox = $('fcChart');
        chartBox.textContent = '';
        const years = fc.yearly;
        const valueSeries = {
            name: 'Стоимость', color: Charts.C.primary, area: true, emphasize: true,
            points: years.map(y => ({ x: y.year, y: y.value }))
        };
        const investedSeries = {
            name: 'Вложено', color: Charts.C.deep,
            points: years.map(y => ({ x: y.year, y: y.invested }))
        };
        // «тень» номинала: та же стоимость, дисконтированная на инфляцию (пунктир)
        const inflationSeries = inflation > 0 ? {
            name: 'С учетом инфляции', color: Charts.C.gray, dash: true,
            points: years.map(y => ({ x: y.year, y: y.realValue }))
        } : null;
        chartBox.appendChild(Charts.line({
            series: inflationSeries ? [valueSeries, inflationSeries, investedSeries] : [valueSeries, investedSeries],
            height: 250, yFromZero: true,
            xFormat: v => v === 0 ? 'старт' : v + ' л.'
        }));

        // --- таблица по годам ---
        // На узком экране суммы — компактным форматом («1,28 млн ₽»), на широком — полностью.
        // Таблица в обёртке с горизонтальным скроллом: колонки не сжимаются, а едут вбок.
        const tableBox = $('fcTable');
        tableBox.textContent = '';
        const compact = window.matchMedia ? window.matchMedia('(max-width: 768px)').matches : false;
        const fmtCell = compact ? Charts.fmt.compact : Charts.fmt.rub;
        const heads = ['Год', 'Вложено', 'Стоимость', 'Прибыль', 'Пассивный/год'];
        if (inflation > 0) heads.push('Реальный');
        // Длинный горизонт — показываем вехи (каждый год до 5-го, дальше каждые 5):
        // все точки остаются на графике, таблица — компактная сводка
        const shown = state.horizonYears > 10
            ? years.filter(y => y.year <= 5 || y.year % 5 === 0)
            : years;
        const rows = shown.map(y => {
            const cells = [
                { text: y.year === 0 ? 'старт' : y.year + ' ' + yearsWord(y.year) },
                { text: fmtCell(y.invested) },
                { text: fmtCell(y.value) },
                { text: fmtCell(y.earnings), color: y.earnings >= 0 ? Charts.C.income : Charts.C.expense },
                { text: fmtCell(y.passiveYear) }
            ];
            if (inflation > 0) cells.push({ text: fmtCell(y.realPassiveYear) });
            return cells;
        });
        const wrap = document.createElement('div');
        wrap.className = 'chart-scroll';
        wrap.appendChild(Charts.tableEl(heads, rows));
        tableBox.appendChild(wrap);
        if (shown.length < years.length) {
            const note = document.createElement('div');
            note.className = 'fc-table-note';
            note.textContent = 'Вехи: каждый год до 5-го, далее каждые 5 — все точки есть на графике';
            tableBox.appendChild(note);
        }
    }

    const saveConfigSoon = debounce(() => {
        if (typeof saveData === 'function') saveData();
    }, 500);

    // ---------- Синхронизация ----------

    function setSyncUI(mode, message) {
        const btn = $('syncBtn'), status = $('syncStatus'), wrap = $('syncProgressWrap');
        if (mode === 'run') {
            state.syncing = true;
            btn.disabled = true;
            btn.innerHTML = '<span class="sync-ico spin">🔄</span>';
            status.className = 'sync-status running';
            status.textContent = message || 'Подключение…';
            wrap.hidden = false;
            const fill = $('syncProgressFill');
            fill.style.width = '0%';
            fill.classList.add('live');
            for (const id of ['chipTinkoff', 'chipFinam']) $(id).classList.remove('ok', 'error', 'absent');
        } else {
            state.syncing = false;
            btn.disabled = false;
            btn.innerHTML = '<span class="sync-ico">🔄</span>';
            $('syncProgressFill').classList.remove('live');
            status.className = 'sync-status' + (mode === 'error' ? ' error' : '');
            status.textContent = message || 'Готов к синхронизации';
            setTimeout(() => { if (!state.syncing) wrap.hidden = true; }, 1500);
        }
    }

    async function runSync(mock = false) {
        if (state.syncing) return;
        setSyncUI('run', mock ? 'Генерация демо-данных…' : 'Подключение…');

        // Обработчик событий NDJSON — общий для серверного стрима (sync.php)
        // и автономного пайплайна (WalletSync в APK): формы событий совпадают.
        const brokerErrors = {}; // брокер → текст последней ошибки (для итога)
        const handle = (line) => {
            if (!line || !line.trim()) return;
            let ev;
            try { ev = JSON.parse(line); } catch (e) { return; }
            if (ev.event === 'start') {
                const b = ev.brokers || {};
                $('chipTinkoff').classList.toggle('absent', !b.tinkoff);
                $('chipFinam').classList.toggle('absent', !b.finam);
                $('chipTinkoff').classList.toggle('running', !!b.tinkoff);
                $('chipFinam').classList.toggle('running', !!b.finam);
            } else if (ev.event === 'log') {
                $('syncProgressFill').style.width = Math.round((ev.progress || 0) * 100) + '%';
                if (ev.message) $('syncStatus').textContent = ev.message;
            } else if (ev.event === 'broker_status') {
                const chip = $(ev.broker === 'tinkoff' ? 'chipTinkoff' : 'chipFinam');
                chip.classList.remove('running', 'ok', 'error', 'absent');
                if (ev.status === 'skipped') chip.classList.add('absent');
                else chip.classList.add(ev.status === 'ok' ? 'ok' : ev.status === 'error' ? 'error' : 'running');
                if (ev.status === 'error' && ev.error) {
                    brokerErrors[ev.broker] = ev.error;
                    $('syncStatus').textContent = BROKER_TITLES[ev.broker] + ': ' + ev.error;
                    chip.title = ev.error;
                    // #syncStatus на мобиле скрыт — ошибку брокера видно только тостом
                    toast('❌ ' + BROKER_TITLES[ev.broker] + ': ' + ev.error);
                } else if (ev.status === 'ok') {
                    delete brokerErrors[ev.broker];
                }
            } else if (ev.event === 'busy') {
                setSyncUI('idle', 'Синхронизация уже запущена в другой вкладке');
                toast('⏳ Синхронизация уже идёт — подождите');
            } else if (ev.event === 'error') {
                setSyncUI('error', 'Ошибка: ' + (ev.message || 'неизвестная'));
                toast('❌ ' + (ev.message || 'Ошибка синхронизации'));
            } else if (ev.event === 'done') {
                $('syncProgressFill').style.width = '100%';
                const pf = ev.portfolio || {};
                const failed = Object.keys(brokerErrors);
                if (ev.saved) {
                    setSyncUI('idle', 'Синхронизация завершена' +
                        (pf.value != null ? ' · стоимость ' + Charts.fmt.compact(pf.value) : ''));
                    if (failed.length) {
                        // часть брокеров упала — «всё хорошо» было бы враньём
                        toast('⚠️ Обновлено без ' + failed.map(b => BROKER_TITLES[b]).join(', ') +
                            ': ' + brokerErrors[failed[0]]);
                    } else {
                        toast('✅ Данные обновлены' + (pf.value != null ? ': ' + Charts.fmt.compact(pf.value) : ''));
                    }
                    loadPortfolio();
                } else {
                    setSyncUI('error', ev.message || 'Данные не сохранены');
                    toast('⚠️ ' + (ev.message || 'Не удалось сохранить данные'));
                    if (!state.portfolio) loadPortfolio(); // мог создаться файл, а у нас его нет
                }
            }
        };

        // Автономный режим: пайплайн целиком на устройстве, HTTP — через Java-мост
        if (window.WALLET_STANDALONE) {
            if (!window.WalletSync) {
                setSyncUI('error', 'Модуль синхронизации недоступен');
                toast('❌ Модуль синхронизации недоступен');
                return;
            }
            try {
                await WalletSync.runSync(mock, handle);
                if (state.syncing) setSyncUI('idle', 'Синхронизация завершена');
            } catch (e) {
                setSyncUI('error', 'Ошибка: ' + (e && e.message ? e.message : 'неизвестная'));
                toast('❌ Ошибка синхронизации');
            }
            return;
        }

        try {
            const resp = await fetch(BASE + '/sync.php', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mock: !!mock })
            });
            if (resp.status === 401) {
                setSyncUI('idle', 'Требуется вход');
                if (window.WalletAuth) WalletAuth.show();
                return;
            }
            if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let nl;
                while ((nl = buffer.indexOf('\n')) >= 0) {
                    handle(buffer.slice(0, nl));
                    buffer = buffer.slice(nl + 1);
                }
            }
            handle(buffer);
            if (state.syncing) setSyncUI('idle', 'Синхронизация завершена');
        } catch (e) {
            setSyncUI('error', 'Ошибка соединения: ' + e.message);
            toast('❌ Ошибка соединения с сервером');
        }
    }

    // ---------- Свайп между видами (только на дашборде) ----------

    function initDashboardSwipe() {
        const view = $('dashboardView');
        if (!view) return;
        let sx = 0, sy = 0, tracking = false;
        view.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) { tracking = false; return; }
            const target = e.target instanceof Element ? e.target : null;
            // не перехватываем жесты у контролов, графиков и tooltip-слоёв
            if (target && target.closest('input, select, textarea, button, svg, .no-swipe, .chart-tooltip, .chart-table')) {
                tracking = false;
                return;
            }
            tracking = true;
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
        }, { passive: true });
        view.addEventListener('touchend', (e) => {
            if (!tracking) return;
            tracking = false;
            const t = e.changedTouches[0];
            const dx = t.clientX - sx, dy = t.clientY - sy;
            if (Math.abs(dx) < 60 || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
            if (dx > 0) setView('calendar'); // свайп вправо — назад к календарю
        }, { passive: true });
    }

    // ---------- Инициализация ----------

    function bindForecastControls() {
        const amountRange = $('fcAmountRange');
        amountRange.addEventListener('input', debounce(() => {
            state.amountTouched = true;
            investmentConfig.customMonthlyAmount = Math.max(0, +amountRange.value || 0);
            saveConfigSoon();
            renderForecast();
        }, 100));

        const splitInputs = [$('fcSplitTinkoff'), $('fcSplitFinam')];
        splitInputs.forEach((inp, i) => {
            inp.addEventListener('input', debounce(() => {
                state.splitTouched = true;
                const v = Math.max(0, Math.min(100, Math.round((+inp.value || 0) / 5) * 5));
                const key = i === 0 ? 'tinkoff' : 'finam';
                const otherKey = i === 0 ? 'finam' : 'tinkoff';
                investmentConfig.split[key] = v;
                investmentConfig.split[otherKey] = 100 - v;
                splitInputs[1 - i].value = String(100 - v); // второй ползунок — зеркально
                saveConfigSoon();
                renderForecast();
            }, 100));
        });

        const inflationRange = $('fcInflationRange');
        inflationRange.addEventListener('input', debounce(() => {
            state.inflationTouched = true;
            investmentConfig.inflationPct = Math.max(0, Math.min(30, +inflationRange.value || 0));
            saveConfigSoon();
            renderForecast();
        }, 100));

        [[$('fcYieldTinkoff'), 'tinkoff'], [$('fcYieldFinam'), 'finam']].forEach(([inp, key]) => {
            // пока пользователь печатает, авто-значение не должно затирать ввод
            inp.addEventListener('input', () => { state.yieldTouched[key] = true; });
            inp.addEventListener('input', debounce(() => {
                const v = inp.value.trim();
                investmentConfig.yieldOverrides[key] = v === '' ? null : Math.max(0, Math.min(100, +v || 0));
                if (v === '') state.yieldTouched[key] = false; // пусто = авто: поле снова заполнится само
                saveConfigSoon();
                renderForecast();
            }, 300));
        });

        const accEmptyToggle = $('accEmptyToggle');
        if (accEmptyToggle) accEmptyToggle.addEventListener('click', () => {
            state.showEmptyAccounts = !state.showEmptyAccounts;
            try { localStorage.setItem('wallet-accounts-empty', state.showEmptyAccounts ? '1' : '0'); } catch (e) {}
            renderAccounts(state.portfolio);
        });

        $('fcHorizons').addEventListener('click', (e) => {
            const btn = e.target instanceof Element ? e.target.closest('button[data-years]') : null;
            if (!btn) return;
            state.horizonYears = +btn.dataset.years;
            investmentConfig.horizonYears = state.horizonYears;
            for (const b of $('fcHorizons').querySelectorAll('button')) {
                b.classList.toggle('active', b === btn);
            }
            saveConfigSoon();
            renderForecast();
        });

        // Период графика истории 6М/1Г/Всё
        const histRange = $('histRange');
        if (histRange) histRange.addEventListener('click', (e) => {
            const btn = e.target instanceof Element ? e.target.closest('button[data-range]') : null;
            if (!btn) return;
            state.histRange = +btn.dataset.range;
            for (const b of histRange.querySelectorAll('button')) {
                b.classList.toggle('active', b === btn);
            }
            if (state.portfolio) renderHistoryChart(state.portfolio);
        });

        // Таблица активов: сортировка по клику на заголовок
        const ht = $('holdingsTable');
        if (ht) ht.addEventListener('click', (e) => {
            const th = e.target instanceof Element ? e.target.closest('th.sortable') : null;
            if (!th || !th.dataset.key) return;
            if (state.htSort.key === th.dataset.key) state.htSort.dir *= -1;
            else state.htSort = { key: th.dataset.key, dir: th.dataset.key === 'name' ? 1 : -1 };
            renderHoldingsTable(state.portfolio);
        });

        // Поиск по активам
        const htSearch = $('htSearch');
        if (htSearch) htSearch.addEventListener('input', debounce(() => {
            state.htQuery = htSearch.value || '';
            state.htExpanded = false;
            renderHoldingsTable(state.portfolio);
        }, 150));

        // Цель: вход/выход из режима редактирования
        const goalEditBtn = $('goalEditBtn');
        if (goalEditBtn) goalEditBtn.addEventListener('click', () => {
            const card = $('goalCard');
            card.dataset.mode = card.dataset.mode === 'edit' ? '' : 'edit';
            renderGoal(state.portfolio);
        });
    }

    function restoreForecastInputsFromConfig() {
        const cfg = investmentConfig;
        if (!cfg) return;
        state.horizonYears = cfg.horizonYears || 20;
        for (const b of $('fcHorizons').querySelectorAll('button')) {
            b.classList.toggle('active', +b.dataset.years === state.horizonYears);
        }
        state.amountTouched = cfg.customMonthlyAmount != null;
        state.inflationTouched = cfg.inflationPct != null;
    }

    document.addEventListener('DOMContentLoaded', () => {
        // Навигация видов
        const nav = $('viewNav');
        if (nav) nav.addEventListener('click', (e) => {
            const btn = e.target instanceof Element ? e.target.closest('.view-btn') : null;
            if (btn) setView(btn.dataset.view);
        });
        let saved = null;
        try { saved = localStorage.getItem('walletView'); } catch (e) { /* ignore */ }
        setView(saved === 'dashboard' ? 'dashboard' : (saved === 'balance' ? 'balance' : 'calendar'));

        // Сохранённый раздел портфеля
        let savedPf = null;
        try { savedPf = localStorage.getItem('walletPfSection'); } catch (e) { /* ignore */ }
        setPfSection(savedPf || 'overview');

        // Меню ☰ (drawer)
        const drawerOverlay = $('drawerOverlay');
        function openDrawer() {
            // подсветка текущего пункта: раздел портфеля / экран баланса / календарь
            let cur = 'calendar';
            if (document.body.classList.contains('dashboard-mode')) {
                cur = 'pf-' + (($('dashboardContent').getAttribute('data-section')) || 'overview');
            } else if (document.body.classList.contains('balance-mode')) {
                cur = 'balance';
            }
            for (const it of document.querySelectorAll('#appDrawer .drawer-item')) {
                it.classList.toggle('active', it.dataset.nav === cur);
            }
            drawerOverlay.hidden = false;
            document.body.classList.add('drawer-open');
        }
        function closeDrawer() {
            document.body.classList.remove('drawer-open');
            // анимации уходят 0.28с — потом убираем оверлей из потока
            setTimeout(() => {
                if (!document.body.classList.contains('drawer-open')) drawerOverlay.hidden = true;
            }, 320);
        }
        $('menuBtn').addEventListener('click', openDrawer);
        $('drawerClose').addEventListener('click', closeDrawer);
        drawerOverlay.addEventListener('click', closeDrawer);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) closeDrawer();
        });
        $('appDrawer').addEventListener('click', (e) => {
            const item = e.target instanceof Element ? e.target.closest('.drawer-item') : null;
            if (!item) return;
            // категории и отмена — кнопки в шапке календаря, в меню только навигация
            const navTo = item.dataset.nav;
            if (navTo === 'calendar' || navTo === 'balance') {
                setView(navTo);
            } else {
                setView('dashboard');
                setPfSection(navTo.replace(/^pf-/, ''));
            }
            closeDrawer();
        });

        // Синхронизация
        $('syncBtn').addEventListener('click', () => runSync(false));
        $('emptySyncBtn').addEventListener('click', () => { setView('dashboard'); runSync(false); });
        $('emptyMockBtn').addEventListener('click', () => { setView('dashboard'); runSync(true); });

        bindForecastControls();
        initDashboardSwipe();

        // Календарь загрузил investmentConfig → пересобрать прогноз и цель
        document.addEventListener('wallet:data-loaded', () => {
            restoreForecastInputsFromConfig();
            if (state.portfolio) { renderForecast(); renderGoal(state.portfolio); }
        });

        // Импорт бэкапа принёс портфель в localStorage → перечитать и перерисовать
        document.addEventListener('wallet:portfolio-imported', () => {
            if (window.WALLET_STANDALONE) loadPortfolio();
        });

        // Календарь изменил операции/категории: сумма «Инвестиций» из календаря —
        // источник правды для прогноза, ручное значение слайдера уступает ей
        document.addEventListener('wallet:data-changed', () => {
            if (!investmentConfig) return; // календарь ещё грузится — придёт wallet:data-loaded
            const auto = autoMonthlyAmount();
            if (auto > 0 && investmentConfig.customMonthlyAmount != null) {
                investmentConfig.customMonthlyAmount = null;
                state.amountTouched = false;
                saveConfigSoon();
            }
            if (state.portfolio) { renderForecast(); renderGoal(state.portfolio); }
        });

        // Первая загрузка портфеля (параллельно с календарём)
        loadPortfolio().then(() => {
            if (investmentConfig) { restoreForecastInputsFromConfig(); renderForecast(); }
        });
    });
})();
