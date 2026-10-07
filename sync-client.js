// sync-client.js — автономная синхронизация брокерских счетов (T-Invest + Finam)
// для offline-сборки APK. Порт бизнес-логики sync.php на JavaScript: тот же
// пайплайн (счета → позиции → слияние → купоны/дивиденды → итоги), те же
// события NDJSON, что читает dashboard.js.handle().
//
// Отличия от sync.php только в среде исполнения:
//   HTTP       — только через Java-мост WalletAndroid.http (никаких fetch/XHR):
//                WalletAndroid.http(json) → '{"status":200,"body":"…","error":null}';
//                status 0 — сетевая ошибка (аналог code 0 из httpCall в sync.php),
//                trustAll — мост применяет доверие всем SSL-сертификатам
//                (паритет с CURLOPT_SSL_VERIFYPEER = false);
//   файлы      — portfolio.json → localStorage['walletPortfolio'],
//                bonds-cache.json → localStorage['walletBondsCache'],
//                settings.json → WalletSettings / localStorage['walletSettings'];
//   блокировка — sync.lock не нужен: повторный вход контролирует dashboard.js.
//
// Токены НИКОГДА не попадают в события и в сохраняемый портфель.
const WalletSync = (() => {

    // ---------- Константы (базы API — как в sync.php) ----------

    const TCS_BASE   = 'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1.';
    const FINAM_BASE = 'https://api.finam.ru';

    const PORTFOLIO_KEY = 'walletPortfolio';   // вместо portfolio.json
    const BONDS_KEY     = 'walletBondsCache';  // вместо bonds-cache.json
    const SETTINGS_KEY  = 'walletSettings';    // вместо settings.json

    // Аналог секции sync в settings.json (UI для этих параметров в приложении нет)
    const REQUEST_TIMEOUT_SEC   = 30;
    const BONDS_CACHE_TTL_HOURS = 24;
    const HISTORY_LIMIT         = 365;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // ---------- Приведение скаляров (паритет с PHP-кастами) ----------

    // PHP is_numeric(): число или числовая строка
    function isNumeric(v) {
        if (typeof v === 'number') return isFinite(v);
        if (typeof v === 'string') return v.trim() !== '' && !isNaN(Number(v));
        return false;
    }

    // PHP (float): мусорные строки и null → 0.0
    function phpFloat(v) {
        const n = Number(v);
        return isNaN(n) ? 0.0 : n;
    }

    // PHP (int): усечение к целому, мусор → 0
    function phpInt(v) {
        const n = parseInt(v, 10);
        return isNaN(n) ? 0 : n;
    }

    // PHP round(): половина округляется ОТ НУЛЯ (Math.round уводит -2.5 к -2)
    function round(value, pts) {
        const f = Math.pow(10, pts || 0);
        const x = value * f;
        const r = x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
        return r / f;
    }

    function errMsg(e, limit) {
        const s = String(e && e.message ? e.message : e);
        return limit === undefined ? s : s.slice(0, limit);
    }

    // ---------- Даты (PHP живёт в Europe/Moscow) ----------

    // «Сегодня» по Москве в виде {y, m, d}; фолбэк — UTC
    function moscowParts(date) {
        const d = date || new Date();
        try {
            const s = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(d);
            const p = s.split('-');
            return { y: +p[0], m: +p[1], d: +p[2] };
        } catch (e) {
            const iso = d.toISOString();
            return { y: +iso.slice(0, 4), m: +iso.slice(5, 7), d: +iso.slice(8, 10) };
        }
    }

    function ymd(p) {
        return p.y + '-' + ('0' + p.m).slice(-2) + '-' + ('0' + p.d).slice(-2);
    }

    // Аналог DateTime::modify('±n months'): переполнение дня скатывается дальше
    // (31 января + 1 месяц → 3 марта), new Date() делает то же самое
    function addMonths(p, n) {
        const dt = new Date(p.y, p.m - 1 + n, p.d);
        return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
    }

    function shiftDays(p, n) {
        const dt = new Date(p.y, p.m - 1, p.d + n);
        return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
    }

    // Ключ месяца 'Y-m' через n месяцев (учитывает переполнение дня, как modify)
    function monthKeyPlus(p, n) {
        const dt = new Date(p.y, p.m - 1 + n, p.d);
        return dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2);
    }

    // ---------- HTTP через Java-мост ----------
    //
    // Аналог httpCall() из sync.php: возвращает [httpCode, body] или бросает
    // исключение при сетевой ошибке (status 0 в ответе моста).

    function httpCall(method, url, body, headers, timeoutSec, insecure) {
        if (!window.WalletAndroid || typeof window.WalletAndroid.http !== 'function') {
            throw new Error('network: Java-мост WalletAndroid.http недоступен');
        }
        const resp = JSON.parse(window.WalletAndroid.http(JSON.stringify({
            method: method,
            url: url,
            headers: headers,
            body: body === undefined ? null : body,
            timeoutMs: Math.max(5, timeoutSec) * 1000,  // CURLOPT_TIMEOUT = max(5, sec)
            trustAll: insecure
        })));
        const status = Number(resp && resp.status) || 0;
        if (status === 0) {
            throw new Error('network: ' + (resp && resp.error ? resp.error : 'unknown error'));
        }
        return [status, resp.body == null ? '' : String(resp.body)];
    }

    // ---------- Разбор денежных величин ----------

    // Quotation T-Invest {units, nano} и Finam {units, nanos} → float
    function qv(q, def) {
        const d = def === undefined ? 0.0 : def;
        if (q === null || q === undefined) return d;
        if (typeof q === 'object') {
            const units = q.units === null || q.units === undefined ? 0.0 : phpFloat(q.units);
            let nano = 0;
            if (q.nano !== null && q.nano !== undefined) nano = phpInt(q.nano);
            else if (q.nanos !== null && q.nanos !== undefined) nano = phpInt(q.nanos);
            return units + nano / 1e9;
        }
        return isNumeric(q) ? phpFloat(q) : d;
    }

    // Обёртка Finam {value:"123.45"} → float
    function vv(v, def) {
        const d = def === undefined ? 0.0 : def;
        if (v === null || v === undefined) return d;
        if (typeof v === 'object') return v.value !== null && v.value !== undefined ? phpFloat(v.value) : d;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') return v !== '' ? phpFloat(v) : d;
        return d;
    }

    // '2041-05-15T00:00:00Z' → '2041-05-15'; null → ''
    function dayPart(iso) {
        return iso === null || iso === undefined ? '' : String(iso).split('T')[0];
    }

    // Тикер из Finam-символа "SU26238RMFS4@TQOB" → "SU26238RMFS4"
    function tickerFromSymbol(symbol) {
        return String(symbol).split('@')[0];
    }

    // Базовый тикер: T-Invest помечает внебиржевые площадки суффиксом "@" (TMON@ → TMON).
    // Один инструмент на разных площадках имеет РАЗНЫЕ figi — для слияния сравниваем базовый тикер.
    function baseTicker(ticker) {
        return String(ticker).split('@')[0];
    }

    // ---------- Прогресс ----------

    class Progress {
        // steps: {ключ: вес}; emit — функция стрима
        constructor(steps, emit) {
            this.steps = steps;
            this.emit = emit;
            this.finished = {};   // завершённые шаги (finish идемпотентен)
            this.total = Math.max(1.0, Object.keys(steps).reduce((s, k) => s + steps[k], 0.0));
            this.done = 0.0;
        }

        // Частичный прогресс внутри шага (0..1) + сообщение
        step(key, fraction, message, broker) {
            const w = this.steps[key] === undefined ? 0.0 : this.steps[key];
            const f = Math.max(0.0, Math.min(1.0, fraction));
            const p = (this.done + w * f) / this.total;
            this.emit({ event: 'log', broker: broker || 'system', message: message, progress: round(p, 4) });
        }

        // Завершить шаг; повторный вызов с тем же ключом игнорируется
        finish(key, message, broker) {
            if (this.finished[key]) return;
            this.finished[key] = true;
            this.done += this.steps[key] === undefined ? 0.0 : this.steps[key];
            this.step(key, 0.0, message, broker);
        }
    }

    // ---------- Клиент T-Invest ----------

    class TinkoffClient {
        constructor(apiKey, timeout, insecure) {
            this.apiKey = apiKey;
            this.timeout = timeout;
            this.insecure = insecure;
            this.lastCall = 0.0;
        }

        // Pacing 150 мс между последовательными вызовами (защита от 429)
        async pace() {
            const remain = 150 - (Date.now() - this.lastCall);
            if (remain > 0) await sleep(remain);
            this.lastCall = Date.now();
        }

        // POST к gRPC-gateway. Декодированный JSON или null после исчерпания ретраев.
        async post(method, body, retries) {
            const n = retries === undefined ? 3 : retries;
            const url = TCS_BASE + method;
            for (let attempt = 1; attempt <= n; attempt++) {
                try {
                    await this.pace();
                    const pair = httpCall('POST', url, JSON.stringify(body), {
                        'Authorization': 'Bearer ' + this.apiKey,
                        'Content-Type': 'application/json'
                    }, this.timeout, this.insecure);
                    const code = pair[0], respBody = pair[1];
                    if (code === 429) {
                        if (attempt < n) { await sleep(3000); continue; }
                        return null;
                    }
                    if (code !== 200) {
                        if (attempt < n) { await sleep(2000); continue; }
                        return null;
                    }
                    let data = null;
                    try { data = JSON.parse(respBody); } catch (e) { data = null; }
                    return data && typeof data === 'object' ? data : null;
                } catch (e) {
                    if (attempt < n) { await sleep(2000); continue; }
                    return null;
                }
            }
            return null;
        }

        // Счета: [{id, name, status, type}]
        async getAccounts() {
            const data = await this.post('UsersService/GetAccounts', { status: 'ACCOUNT_STATUS_OPEN' });
            const out = [];
            for (const a of (data && data.accounts) || []) {
                if (!a || typeof a !== 'object') continue;
                out.push({
                    id: String(a.id == null ? '' : a.id),
                    name: String(a.name == null ? '' : a.name),
                    status: String(a.status == null ? '' : a.status),
                    type: String(a.type == null ? '' : a.type)
                });
            }
            return out;
        }

        // Позиции портфеля: figi, instrumentType, quantity, avg/cur price, ticker, classCode
        async getPositions(accountId) {
            const data = await this.post('OperationsService/GetPortfolio',
                { accountId: accountId, currency: 'RUB' });
            const out = [];
            for (const p of (data && data.positions) || []) {
                if (!p || typeof p !== 'object') continue;
                out.push({
                    figi: String(p.figi == null ? '' : p.figi),
                    instrumentType: String(p.instrumentType == null ? '' : p.instrumentType),
                    quantity: qv(p.quantity === undefined ? null : p.quantity),
                    avgPrice: p.averagePositionPrice != null ? qv(p.averagePositionPrice) : null,
                    curPrice: p.currentPrice != null ? qv(p.currentPrice) : null,
                    ticker: String(p.ticker == null ? '' : p.ticker),
                    classCode: String(p.classCode == null ? '' : p.classCode)
                });
            }
            return out;
        }

        // Свободные рубли счёта: Σ money[rub] − заблокированное ГО (GetWithdrawLimits)
        async getCash(accountId) {
            const data = await this.post('OperationsService/GetWithdrawLimits', { accountId: accountId });
            if (data === null) return 0.0;
            let total = 0.0;
            for (const m of data.money || []) {
                if (!m || typeof m !== 'object') continue;
                if (String(m.currency == null ? '' : m.currency).toLowerCase() === 'rub') total += qv(m);
            }
            // blockedGuarantee приоритетнее blocked (как в kts)
            for (const key of ['blockedGuarantee', 'blocked']) {
                let blocked = 0.0;
                for (const m of data[key] || []) {
                    if (!m || typeof m !== 'object') continue;
                    if (String(m.currency == null ? '' : m.currency).toLowerCase() === 'rub') blocked += qv(m);
                }
                if (blocked > 0) { total -= blocked; break; }
            }
            return total;
        }

        // Реестр облигаций: ticker/name/figi/nominal/sector/couponPerYear/maturityDate
        async getAllBonds() {
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await this.pace();
                    const pair = httpCall('POST', TCS_BASE + 'InstrumentsService/Bonds',
                        JSON.stringify({ instrumentStatus: 'INSTRUMENT_STATUS_BASE' }),
                        { 'Authorization': 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
                        Math.max(this.timeout, 60.0),  // реестр тяжёлый (мегабайты)
                        this.insecure);
                    const code = pair[0], respBody = pair[1];
                    if (code === 429) { await sleep(5000); continue; }
                    if (code !== 200) throw new Error('HTTP ' + code);
                    let data = null;
                    try { data = JSON.parse(respBody); } catch (e) { data = null; }
                    const out = [];
                    for (const b of (data && data.instruments) || []) {
                        if (!b || typeof b !== 'object') continue;
                        out.push({
                            ticker: String(b.ticker == null ? '' : b.ticker),
                            name: String(b.name == null ? '' : b.name),
                            figi: String(b.figi == null ? '' : b.figi),
                            nominal: b.nominal != null ? qv(b.nominal, 1000.0) : 1000.0,
                            sector: String(b.sector == null ? '' : b.sector),
                            couponPerYear: phpInt(b.couponQuantityPerYear == null ? 0 : b.couponQuantityPerYear),
                            maturityDate: dayPart(b.maturityDate == null ? '' : String(b.maturityDate))
                        });
                    }
                    return out;
                } catch (e) {
                    if (attempt === 3) throw new Error('getAllBonds: попытки исчерпаны');
                    await sleep(3000);
                }
            }
            return [];
        }

        // Будущие купоны по облигации
        async getCoupons(figi) {
            const data = await this.post('InstrumentsService/GetBondCoupons', { figi: figi });
            const out = [];
            for (const e of (data && data.events) || []) {
                if (!e || typeof e !== 'object') continue;
                out.push({
                    date: dayPart(e.couponDate == null ? '' : String(e.couponDate)),
                    amountPerUnit: e.payOneBond != null ? qv(e.payOneBond) : 0.0,
                    type: 'coupon',
                    currency: String(e.currency == null ? 'rub' : e.currency).toLowerCase()
                });
            }
            return out;
        }

        // Дивиденды по акции/ETF (dividendNet либо dividendAmount, paymentDate либо recordDate)
        async getDividends(figi) {
            const data = await this.post('InstrumentsService/GetDividends', { instrumentId: figi }, 2);
            const out = [];
            for (const d of (data && data.dividends) || []) {
                if (!d || typeof d !== 'object') continue;
                const amount = d.dividendNet != null ? qv(d.dividendNet)
                    : (d.dividendAmount != null ? qv(d.dividendAmount) : 0.0);
                if (amount <= 0) continue;
                let date = dayPart(d.paymentDate == null ? '' : String(d.paymentDate));
                if (date === '') date = dayPart(d.recordDate == null ? '' : String(d.recordDate));
                out.push({
                    date: date,
                    amountPerUnit: amount,
                    type: 'dividend',
                    currency: String(d.currency == null ? 'rub' : d.currency).toLowerCase()
                });
            }
            return out;
        }

        // Поиск инструмента по тикеру для названия акции/ETF
        async findInstrument(query, kind, classCode) {
            const body = { query: query };
            if (kind !== '') body.instrumentKind = kind;
            const data = await this.post('InstrumentsService/FindInstrument', body, 2);
            const want = kind.toLowerCase().replace('instrument_type_', '');
            for (const i of (data && data.instruments) || []) {
                if (!i || typeof i !== 'object') continue;
                if (kind !== '' && String(i.instrumentType == null ? '' : i.instrumentType).toLowerCase() !== want) continue;
                if (String(i.ticker == null ? '' : i.ticker) !== query) continue;
                if (classCode !== '' && String(i.classCode == null ? '' : i.classCode) !== classCode) continue;
                return { name: String(i.name == null ? '' : i.name), ticker: String(i.ticker == null ? '' : i.ticker) };
            }
            return null;
        }
    }

    // ---------- Клиент Finam ----------

    // Хвост ошибки из тела ответа Finam: там JSON с message («Api token could
    // not be verified» и т.п.) — без него «HTTP 401» не говорит ничего.
    function finamErrTail(body) {
        let msg = '';
        try {
            const d = JSON.parse(body);
            if (d && typeof d.message === 'string') msg = d.message;
        } catch (e) { }
        if (msg === '' && body) msg = String(body).replace(/\s+/g, ' ');
        return msg !== '' ? ' — ' + msg.slice(0, 140) : '';
    }

    class FinamClient {
        constructor(secret, timeout, insecure) {
            this.secret = secret;
            this.timeout = timeout;
            this.insecure = insecure;
            this.token = '';
        }

        async authenticate() {
            const pair = httpCall('POST', FINAM_BASE + '/v1/sessions',
                JSON.stringify({ secret: this.secret }),
                { 'Content-Type': 'application/json' }, this.timeout, this.insecure);
            if (pair[0] !== 200) throw new Error('Finam auth: HTTP ' + pair[0] + finamErrTail(pair[1]));
            let data = null;
            try { data = JSON.parse(pair[1]); } catch (e) { data = null; }
            const token = String(data && data.token != null ? data.token : '');
            if (token === '') throw new Error('Finam auth: токен не получен');
            this.token = token;
        }

        // id счетов
        async getAccountIds() {
            const pair = httpCall('POST', FINAM_BASE + '/v1/sessions/details',
                JSON.stringify({ token: this.token }),
                { 'Content-Type': 'application/json' }, this.timeout, this.insecure);
            if (pair[0] !== 200) throw new Error('Finam details: HTTP ' + pair[0] + finamErrTail(pair[1]));
            let data = null;
            try { data = JSON.parse(pair[1]); } catch (e) { data = null; }
            const ids = data && Array.isArray(data.account_ids) ? data.account_ids : [];
            return ids.filter(id => typeof id === 'string' && id !== '');
        }

        // Счёт: equity, cash, позиции (цены облигаций в % от номинала)
        async getAccount(accountId) {
            const pair = httpCall('GET', FINAM_BASE + '/v1/accounts/' + encodeURIComponent(accountId), null,
                { 'Authorization': 'Bearer ' + this.token }, this.timeout, this.insecure);
            if (pair[0] !== 200) throw new Error('Finam account: HTTP ' + pair[0] + finamErrTail(pair[1]));
            let data = null;
            try { data = JSON.parse(pair[1]); } catch (e) { data = null; }
            const positions = [];
            for (const p of (data && data.positions) || []) {
                if (!p || typeof p !== 'object') continue;
                positions.push({
                    symbol: String(p.symbol == null ? '' : p.symbol),
                    quantity: vv(p.quantity === undefined ? null : p.quantity),
                    averagePrice: vv(p.average_price === undefined ? null : p.average_price),
                    currentPrice: vv(p.current_price === undefined ? null : p.current_price)
                });
            }
            return {
                equity: vv(data && data.equity !== undefined ? data.equity : null),
                cash: qv(data && data.cash !== undefined ? data.cash : null),
                positions: positions
            };
        }

        // Будущие дивиденды по символу; ошибки не фатальны
        async getFutureDividends(symbol) {
            try {
                const pair = httpCall('GET',
                    FINAM_BASE + '/v1/future-dividends?symbol=' + encodeURIComponent(symbol) + '&sort_direction=asc&limit=50',
                    null, { 'Authorization': 'Bearer ' + this.token }, this.timeout, this.insecure);
                if (pair[0] !== 200) return [];
                let data = null;
                try { data = JSON.parse(pair[1]); } catch (e) { data = null; }
                const out = [];
                for (const e of (data && data.events) || []) {
                    if (!e || typeof e !== 'object') continue;
                    const amount = e.dividend_amount != null ? qv(e.dividend_amount)
                        : (e.amount != null ? qv(e.amount) : 0.0);
                    let date = dayPart(e.dividend_date == null ? '' : String(e.dividend_date));
                    if (date === '') date = dayPart(e.date == null ? '' : String(e.date));
                    if (date === '' || amount <= 0) continue;
                    out.push({
                        date: date,
                        amountPerUnit: amount,
                        type: 'dividend',
                        currency: String(e.currency == null ? 'rub' : e.currency).toLowerCase()
                    });
                }
                return out;
            } catch (e) {
                return [];
            }
        }
    }

    // ---------- Справочник облигаций ----------

    // Индексы реестра: точное совпадение по тикеру и figi
    function buildBondLookup(bonds) {
        const byTicker = {};
        const byFigi = {};
        for (const b of bonds) {
            if (b.ticker !== '') byTicker[b.ticker] = b;
            if (b.figi !== '') byFigi[b.figi] = b;
        }
        return { ticker: byTicker, figi: byFigi, all: bonds };
    }

    // Поиск облигации по тикеру/figi: точное совпадение, затем префикс
    function findBond(lookup, key) {
        if (key === '') return null;
        if (lookup.ticker[key] !== undefined) return lookup.ticker[key];
        if (lookup.figi[key] !== undefined) return lookup.figi[key];
        for (const b of lookup.all) {
            if (b.ticker === '') continue;
            if (key.startsWith(b.ticker) || b.ticker.startsWith(key)) return b;
        }
        return null;
    }

    // Finam-символ похож на облигацию? (длинный буквенно-цифровой тикер)
    function isBondSymbol(ticker) {
        return ticker.length >= 10 && /^[0-9A-Za-z]+$/.test(ticker);
    }

    // Конвертация и слияние позиции Finam в общий список holdings.
    // Цены облигаций приходят в % от номинала → ₽ через nominal/100 (как в kts).
    function mergeFinamPosition(holdings, pos, bond) {
        const ticker = tickerFromSymbol(pos.symbol);
        const nominal = bond != null && bond.nominal != null ? bond.nominal : 1000.0;
        const avgPriceRub = pos.averagePrice * nominal / 100.0;
        const curPriceRub = pos.currentPrice * nominal / 100.0;
        let key = bond != null && bond.figi !== '' ? bond.figi : ticker;

        // figi-ключ не найден — пробуем слить по базовому тикеру и типу
        // (один инструмент = разные figi на разных площадках)
        if (holdings[key] === undefined) {
            for (const k of Object.keys(holdings)) {
                const h = holdings[k];
                if (baseTicker(h.ticker) === ticker &&
                    h.instrumentType === (bond != null || isBondSymbol(ticker) ? 'bond' : 'share')) {
                    key = k;
                    break;
                }
            }
        }

        if (holdings[key] !== undefined) {
            const h = holdings[key];
            const newQty = h.quantity + pos.quantity;
            h.avgPrice = newQty > 0
                ? (h.quantity * h.avgPrice + pos.quantity * avgPriceRub) / newQty
                : h.avgPrice;
            h.quantity = newQty;
            h.brokerQty.finam = (h.brokerQty.finam || 0) + pos.quantity;
            h.sources.push('finam');
            h.sources = Array.from(new Set(h.sources));
            return;
        }

        holdings[key] = {
            figi: bond != null && bond.figi != null ? bond.figi : '',
            ticker: ticker,
            name: bond != null && bond.name != null ? bond.name : ticker,
            instrumentType: bond != null ? 'bond' : (isBondSymbol(ticker) ? 'bond' : 'share'),
            quantity: pos.quantity,
            avgPrice: avgPriceRub,
            curPrice: curPriceRub,
            nominal: nominal,
            sector: bond != null && bond.sector != null ? bond.sector : '',
            couponPerYear: bond != null && bond.couponPerYear != null ? bond.couponPerYear : 0,
            maturityDate: bond != null && bond.maturityDate != null ? bond.maturityDate : '',
            sources: ['finam'],
            brokerQty: { tinkoff: 0, finam: pos.quantity },
            payments: []
        };
    }

    // ---------- Итоги ----------

    // Считает итоговую структуру holdings/totals для портфеля.
    // holdings: ключ → holding (работаем с копиями; внутреннее поле brokerQty наружу не отдаётся)
    function computeTotals(holdings, accounts) {
        const todayParts = moscowParts();
        const today = ymd(todayParts);
        const in12m = ymd(addMonths(todayParts, 12));

        // Только ликвидные позиции с ненулевым количеством, по убыванию стоимости
        const list = Object.keys(holdings)
            .map(k => Object.assign({}, holdings[k]))
            .filter(h => h.quantity > 0 && h.instrumentType !== 'futures');
        list.sort((a, b) => b.quantity * b.curPrice - a.quantity * a.curPrice);

        let value = 0.0, cost = 0.0, payingValue = 0.0, payments12m = 0.0;
        const byMonth = {};  // "YYYY-MM" => {coupons, dividends, total}
        const byType = {};   // тип => стоимость
        const byBroker = {
            tinkoff: { value: 0.0, cost: 0.0, cash: 0.0, paymentsNext12m: 0.0 },
            finam:   { value: 0.0, cost: 0.0, cash: 0.0, paymentsNext12m: 0.0 }
        };

        for (const h of list) {
            h.value = round(h.quantity * h.curPrice, 2);
            h.cost = round(h.quantity * h.avgPrice, 2);
            h.pnl = round(h.value - h.cost, 2);
            h.pnlPct = h.cost > 0 ? round(h.pnl / h.cost * 100, 2) : null;
            value += h.value;
            cost += h.cost;
            byType[h.instrumentType] = (byType[h.instrumentType] || 0) + h.value;

            let hPayments12m = 0.0;
            let hasFuturePayments = false;
            for (const p of h.payments || []) {
                if (p.currency !== 'rub' || p.date < today) continue;
                hasFuturePayments = true;
                if (p.date > in12m) continue;
                const total = p.amountPerUnit * h.quantity;
                hPayments12m += total;
                const mk = p.date.slice(0, 7);
                if (byMonth[mk] === undefined) byMonth[mk] = { coupons: 0.0, dividends: 0.0, total: 0.0 };
                const kind = p.type === 'coupon' ? 'coupons' : 'dividends';
                byMonth[mk][kind] += total;
                byMonth[mk].total += total;
            }
            payments12m += hPayments12m;
            if (hasFuturePayments) payingValue += h.value;

            // Разнесение по брокерам пропорционально количеству у каждого
            for (const b of ['tinkoff', 'finam']) {
                const qty = h.brokerQty !== undefined && h.brokerQty[b] !== undefined ? h.brokerQty[b] : 0.0;
                if (qty <= 0) continue;
                byBroker[b].value += qty * h.curPrice;
                byBroker[b].cost += qty * h.avgPrice;
                if (h.quantity > 0) byBroker[b].paymentsNext12m += hPayments12m * qty / h.quantity;
            }

            h.paymentsNext12m = round(hPayments12m, 2);
            delete h.brokerQty;  // внутреннее поле — наружу не отдаём
        }

        for (const acc of accounts) {
            if (byBroker[acc.broker] !== undefined) byBroker[acc.broker].cash += acc.cash;
        }
        for (const b of Object.keys(byBroker)) {
            const bb = byBroker[b];
            bb.paymentsNext12m = round(bb.paymentsNext12m, 2);
            bb.yieldPct = bb.value > 0 ? round(bb.paymentsNext12m / bb.value * 100, 2) : 0.0;
        }

        // 12 календарных месяцев (включая текущий), нулевые месяцы тоже — для ровного графика
        const paymentsByMonth = [];
        for (let i = 0; i < 12; i++) {
            const mk = monthKeyPlus({ y: todayParts.y, m: todayParts.m, d: 1 }, i);
            const row = byMonth[mk] !== undefined ? byMonth[mk] : { coupons: 0.0, dividends: 0.0, total: 0.0 };
            paymentsByMonth.push({
                month: mk,
                coupons: round(row.coupons, 2),
                dividends: round(row.dividends, 2),
                total: round(row.total, 2)
            });
        }

        const pnl = value - cost;
        let cash = 0.0;
        for (const a of accounts) cash += a.cash;

        const byTypeRounded = {};
        for (const k of Object.keys(byType)) byTypeRounded[k] = round(byType[k], 2);

        return {
            holdings: list,
            totals: {
                value: round(value, 2),
                cost: round(cost, 2),
                pnl: round(pnl, 2),
                pnlPct: cost > 0 ? round(pnl / cost * 100, 2) : null,
                cash: round(cash, 2),
                payingValue: round(payingValue, 2),
                paymentsNext12m: round(payments12m, 2),
                passiveYieldPct: value > 0 ? round(payments12m / value * 100, 2) : 0.0,
                paymentsByMonth: paymentsByMonth,
                byBroker: byBroker,
                byType: byTypeRounded
            }
        };
    }

    // ---------- Mock-данные (детерминированные, без сети) ----------

    function buildMockPortfolio() {
        const t = moscowParts();
        const today = ymd(t);

        // Регулярные выплаты: каждые 12/perYear месяцев, 14-го числа
        const mkPayments = (perYear, amount, type) => {
            const out = [];
            const step = Math.max(1, Math.floor(12 / perYear));
            for (let m = 0; m < 12; m += step) {
                let d = ymd(addMonths(t, m)).slice(0, 8) + '14';
                if (d < today) d = ymd(addMonths(t, m + step)).slice(0, 8) + '14';
                if (d.slice(0, 7) > monthKeyPlus(t, 11)) continue;
                out.push({ date: d, amountPerUnit: amount, type: type, currency: 'rub' });
            }
            return out;
        };

        const holdings = [
            { figi: 'BBG00RPRPXV0', ticker: 'SU26238RMFS4', name: 'ОФЗ 26238', instrumentType: 'bond',
              quantity: 400, avgPrice: 542.3, curPrice: 568.9, nominal: 1000.0, sector: 'government',
              couponPerYear: 2, maturityDate: '2041-05-15', sources: ['tinkoff', 'finam'],
              brokerQty: { tinkoff: 250, finam: 150 }, payments: mkPayments(2, 31.12, 'coupon') },
            { figi: 'BBG00YXY1W39', ticker: 'RU000A105SD9', name: 'Сбербанк-002Р-01D', instrumentType: 'bond',
              quantity: 150, avgPrice: 963.0, curPrice: 991.5, nominal: 1000.0, sector: 'bank',
              couponPerYear: 4, maturityDate: '2027-11-10', sources: ['tinkoff'],
              brokerQty: { tinkoff: 150, finam: 0 }, payments: mkPayments(4, 24.8, 'coupon') },
            { figi: 'BBG004730N88', ticker: 'SBER', name: 'Сбербанк, ао', instrumentType: 'share',
              quantity: 900, avgPrice: 246.1, curPrice: 318.4, nominal: 0.0, sector: 'financial',
              couponPerYear: 0, maturityDate: '', sources: ['tinkoff'],
              brokerQty: { tinkoff: 900, finam: 0 }, payments: mkPayments(1, 33.3, 'dividend') },
            { figi: 'BBG00475K6C3', ticker: 'GAZP', name: 'Газпром, ао', instrumentType: 'share',
              quantity: 1200, avgPrice: 128.5, curPrice: 142.7, nominal: 0.0, sector: 'energy',
              couponPerYear: 0, maturityDate: '', sources: ['tinkoff', 'finam'],
              brokerQty: { tinkoff: 700, finam: 500 }, payments: mkPayments(1, 8.97, 'dividend') },
            { figi: 'BBG00B3X0GQ1', ticker: 'LKOH', name: 'ЛУКОЙЛ, ао', instrumentType: 'share',
              quantity: 60, avgPrice: 6890.0, curPrice: 7245.0, nominal: 0.0, sector: 'energy',
              couponPerYear: 0, maturityDate: '', sources: ['finam'],
              brokerQty: { tinkoff: 0, finam: 60 }, payments: mkPayments(1, 84.0, 'dividend') },
            { figi: 'BBG004HV8V33', ticker: 'LQDT', name: 'LQDT Ликвидность', instrumentType: 'etf',
              quantity: 3000, avgPrice: 1.42, curPrice: 1.51, nominal: 0.0, sector: '',
              couponPerYear: 0, maturityDate: '', sources: ['tinkoff'],
              brokerQty: { tinkoff: 3000, finam: 0 }, payments: [] },
            { figi: 'BBG00T6KXWX8', ticker: 'TMOS', name: 'Т-Капитал Индекс МосБиржи', instrumentType: 'etf',
              quantity: 850, avgPrice: 7.24, curPrice: 7.86, nominal: 0.0, sector: '',
              couponPerYear: 0, maturityDate: '', sources: ['finam'],
              brokerQty: { tinkoff: 0, finam: 850 }, payments: [] }
        ];

        const rawAccounts = [
            { broker: 'tinkoff', id: '2000123456', name: 'Брокерский счёт', type: 'ACCOUNT_TYPE_TINKOFF',
              cash: 42000.0, positionsCount: 5 },
            { broker: 'tinkoff', id: '2000123457', name: 'ИИС', type: 'ACCOUNT_TYPE_TINKOFF_IIS',
              cash: 8500.0, positionsCount: 2 },
            { broker: 'finam', id: 'FAB00012345', name: 'Finam Брокерский', type: '',
              cash: 12300.0, positionsCount: 3 }
        ];

        const result = computeTotals(holdings, rawAccounts);
        // equity счетов распределяем по брокерам (для мока достаточно)
        const tcsTotal = result.totals.byBroker.tinkoff.value + 42000.0 + 8500.0;
        const finamTotal = result.totals.byBroker.finam.value + 12300.0;
        result.accounts = [
            { broker: 'tinkoff', id: '2000123456', name: 'Брокерский счёт', type: 'ACCOUNT_TYPE_TINKOFF',
              equity: round(tcsTotal * 0.78, 2), cash: 42000.0, futuresValue: 0, positionsCount: 5 },
            { broker: 'tinkoff', id: '2000123457', name: 'ИИС', type: 'ACCOUNT_TYPE_TINKOFF_IIS',
              equity: round(tcsTotal * 0.22, 2), cash: 8500.0, futuresValue: 0, positionsCount: 2 },
            { broker: 'finam', id: 'FAB00012345', name: 'Finam Брокерский', type: '',
              equity: round(finamTotal, 2), cash: 12300.0, futuresValue: 0, positionsCount: 3 }
        ];

        // История за 90 дней: детерминированная волатильность
        const history = [];
        const v0 = result.totals.value;
        const c0 = result.totals.cost;
        for (let i = 90; i >= 1; i--) {
            const d = ymd(shiftDays(t, -i));
            const wave = Math.sin(i / 7) * 0.006 + Math.sin(i / 23 + 1.3) * 0.011;
            const growth = (i / 90) * 0.055;  // от −5,5% к 0
            history.push({
                date: d,
                value: round(v0 * (1 - growth + wave), 2),
                cost: round(c0 * (1 - growth * 0.6), 2),
                pnl: round(v0 * (1 - growth + wave) - c0 * (1 - growth * 0.6), 2),
                cash: round(result.totals.cash * (1 - growth), 2)
            });
        }

        result.meta = {
            version: 1,
            generatedAt: new Date().toISOString(),
            mock: true,
            durationMs: 0,
            brokers: {
                tinkoff: { configured: true, status: 'ok', error: null, accounts: 2, durationMs: 0 },
                finam:   { configured: true, status: 'ok', error: null, accounts: 1, durationMs: 0 }
            }
        };
        result.history = history;
        return result;
    }

    // ---------- Настройки ----------

    // Токены берём из модуля настроек приложения; фолбэк — сырой localStorage
    // (те же дефолты, что у WalletSettings). Пустой токен = брокер выключен.
    function loadSyncSettings() {
        if (window.WalletSettings && typeof window.WalletSettings.load === 'function') {
            const s = window.WalletSettings.load();
            return {
                // trim и здесь: значение, сохранённое до фикса, могло тянуть
                // хвостовой перевод строки — Finam отвечал на такой секрет 401
                tinkoffToken: typeof s.tinkoffToken === 'string' ? s.tinkoffToken.trim() : '',
                finamToken: typeof s.finamToken === 'string' ? s.finamToken.trim() : '',
                trustAllCerts: s.trustAllCerts !== false
            };
        }
        let raw = null;
        try { raw = localStorage.getItem(SETTINGS_KEY); } catch (e) { raw = null; }
        if (raw === null || raw === '') {
            return { tinkoffToken: '', finamToken: '', trustAllCerts: true };
        }
        let s;
        try { s = JSON.parse(raw); } catch (e) { throw new Error('Настройки повреждены (неверный JSON)'); }
        if (!s || typeof s !== 'object') throw new Error('Настройки повреждены (неверный JSON)');
        return {
            tinkoffToken: typeof s.tinkoffToken === 'string' ? s.tinkoffToken.trim() : '',
            finamToken: typeof s.finamToken === 'string' ? s.finamToken.trim() : '',
            trustAllCerts: s.trustAllCerts !== false
        };
    }

    // ---------- Хранилище ----------

    function writePortfolio(p) {
        // Аналог atomicWrite(): пишем целиком, обновление атомарно само по себе
        try { localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(p)); return true; }
        catch (e) { return false; }  // приватный режим / нет места
    }

    // ---------- Точка входа ----------

    // mock=true — детерминированные данные без сети; emit(line) принимает
    // JSON-строку события (тот же NDJSON-протокол, что у sync.php).
    async function runSync(mock, emitLine) {
        const push = typeof emitLine === 'function' ? emitLine : function () {};
        const emit = ev => { push(JSON.stringify(ev)); };
        const startedAt = Date.now();

        try {
            // ---------- MOCK ----------
            if (mock) {
                emit({ event: 'start', mock: true, version: 1, brokers: { tinkoff: true, finam: true } });
                const mockSteps = [
                    ['settings', 'system', 'Чтение настроек…'],
                    ['finam_auth', 'finam', 'Авторизация в Finam API…'],
                    ['finam_accounts', 'finam', 'Получение счетов Finam…'],
                    ['tcs_accounts', 'tcs', 'Получение счетов T-Invest…'],
                    ['tcs_portfolios', 'tcs', 'Загрузка портфелей T-Invest…'],
                    ['bonds', 'tcs', 'Загрузка справочника облигаций…'],
                    ['payments', 'tcs', 'Купоны и дивиденды по позициям…'],
                    ['finalize', 'system', 'Расчёт итогов…'],
                    ['write', 'system', 'Сохранение портфеля…']
                ];
                for (let i = 0; i < mockSteps.length; i++) {
                    emit({ event: 'log', broker: mockSteps[i][1], message: mockSteps[i][2],
                        progress: round(i / mockSteps.length, 4) });
                    await sleep(130);
                }
                const portfolio = buildMockPortfolio();
                let saved = false;
                // Мок не перезаписывает реальные данные: пишет только при первом запуске (демо)
                let existed = true;
                try { existed = localStorage.getItem(PORTFOLIO_KEY) !== null; } catch (e) { existed = true; }
                if (!existed) saved = writePortfolio(portfolio);
                emit({ event: 'broker_status', broker: 'tinkoff', status: 'ok', error: null });
                emit({ event: 'broker_status', broker: 'finam', status: 'ok', error: null });
                emit({ event: 'done', mock: true, saved: saved,
                    totalMs: Date.now() - startedAt, portfolio: portfolio });
                return;
            }

            // ---------- Реальная синхронизация ----------

            const settings = loadSyncSettings();
            const tcsEnabled = settings.tinkoffToken.trim() !== '';
            const finamEnabled = settings.finamToken.trim() !== '';

            // Шаги прогресса; шаги выключенных брокеров исключаются (веса нормируются)
            const steps = {
                settings: 2,
                finam_auth: 7, finam_accounts: 8,
                tcs_accounts: 5, tcs_portfolios: 15,
                bonds: 20, payments: 32,
                finalize: 3, write: 8
            };
            if (!tcsEnabled) { delete steps.tcs_accounts; delete steps.tcs_portfolios; }
            if (!finamEnabled) { delete steps.finam_auth; delete steps.finam_accounts; }
            if (!tcsEnabled && !finamEnabled) {
                delete steps.bonds; delete steps.payments; delete steps.finalize; delete steps.write;
            }

            const progress = new Progress(steps, emit);
            emit({ event: 'start', version: 1, brokers: { tinkoff: tcsEnabled, finam: finamEnabled } });
            progress.finish('settings', 'Настройки загружены');
            emit({ event: 'broker_status', broker: 'tinkoff', status: tcsEnabled ? 'running' : 'skipped',
                error: tcsEnabled ? null : 'Токен не задан в настройках' });
            emit({ event: 'broker_status', broker: 'finam', status: finamEnabled ? 'running' : 'skipped',
                error: finamEnabled ? null : 'Токен не задан в настройках' });

            // Оба брокера не настроены — говорить нечего
            if (!tcsEnabled && !finamEnabled) {
                emit({ event: 'done', saved: false, totalMs: Date.now() - startedAt,
                    message: 'Нет настроенных брокеров — задайте токены в настройках' });
                return;
            }

            const timeout = REQUEST_TIMEOUT_SEC;
            const insecure = settings.trustAllCerts;
            const todayParts = moscowParts();
            const today = ymd(todayParts);

            const brokerMeta = {
                tinkoff: { configured: tcsEnabled, status: 'skipped', error: null, accounts: 0, durationMs: 0 },
                finam:   { configured: finamEnabled, status: 'skipped', error: null, accounts: 0, durationMs: 0 }
            };
            let accounts = [];               // список счетов для портфеля
            const holdings = {};             // ключ → объединённая позиция
            const holdingsByBase = {};       // базовый тикер → ключ (слияние площадок: TMON@ + TMON)
            const finamRawPositions = [];    // [позиция, …] — конвертируются после реестра облигаций
            const finamPositionsByTicker = {};  // тикер → полный символ Finam (для future-dividends)
            let tcsClient = null;
            let finamClient = null;
            let bonds = [];

            // ---------- Этап 1: Finam (auth + счета + сырые позиции) ----------
            if (finamEnabled) {
                const t0 = Date.now();
                try {
                    finamClient = new FinamClient(settings.finamToken, timeout, insecure);
                    progress.step('finam_auth', 0.5, 'Авторизация в Finam API…', 'finam');
                    await finamClient.authenticate();
                    progress.finish('finam_auth', 'Finam: авторизация OK', 'finam');

                    progress.step('finam_accounts', 0.3, 'Получение счетов Finam…', 'finam');
                    // все счета токена — фильтр по конкретному счёту убран
                    let ids = await finamClient.getAccountIds();
                    brokerMeta.finam.accounts = ids.length;
                    if (ids.length === 0) throw new Error('Finam: счета не найдены');

                    let ai = 0;
                    for (const id of ids) {
                        ai++;
                        progress.step('finam_accounts', 0.3 + 0.7 * ai / ids.length,
                            'Счёт Finam ' + id + ': позиции…', 'finam');
                        const acc = await finamClient.getAccount(id);
                        accounts.push({
                            broker: 'finam', id: id, name: 'Finam ' + String(id).slice(-4), type: '',
                            equity: round(acc.equity, 2), cash: round(acc.cash, 2),
                            futuresValue: 0, positionsCount: acc.positions.length
                        });
                        for (const pos of acc.positions) {
                            if (pos.quantity <= 0) continue;
                            finamRawPositions.push(pos);
                            finamPositionsByTicker[tickerFromSymbol(pos.symbol)] = pos.symbol;
                        }
                    }
                    progress.finish('finam_accounts', 'Finam: счетов ' + ids.length, 'finam');
                    brokerMeta.finam.status = 'ok';
                } catch (e) {
                    brokerMeta.finam.status = 'error';
                    brokerMeta.finam.error = errMsg(e, 200);
                    finamClient = null;
                    accounts = accounts.filter(a => a.broker !== 'finam');
                    emit({ event: 'broker_status', broker: 'finam', status: 'error', error: brokerMeta.finam.error });
                    progress.finish('finam_auth', 'Finam: ошибка — ' + brokerMeta.finam.error, 'finam');
                    progress.finish('finam_accounts', '', 'finam');
                }
                brokerMeta.finam.durationMs = Date.now() - t0;
            }

            // ---------- Этап 2: T-Invest (счета + портфели + кэш) ----------
            if (tcsEnabled) {
                const t0 = Date.now();
                try {
                    tcsClient = new TinkoffClient(settings.tinkoffToken, timeout, insecure);

                    progress.step('tcs_accounts', 0.5, 'Получение счетов T-Invest…', 'tcs');
                    const tcsAccounts = await tcsClient.getAccounts();
                    if (tcsAccounts.length === 0) throw new Error('GetAccounts: пусто или ошибка API');
                    brokerMeta.tinkoff.accounts = tcsAccounts.length;
                    progress.finish('tcs_accounts', 'T-Invest: счетов ' + tcsAccounts.length, 'tcs');

                    const nameCache = {};
                    let ai = 0;
                    for (const acc of tcsAccounts) {
                        ai++;
                        progress.step('tcs_portfolios', ai / tcsAccounts.length,
                            'Счёт «' + acc.name + '»: портфель…', 'tcs');
                        const positions = await tcsClient.getPositions(acc.id);

                        let accountEquity = 0.0, futuresValue = 0.0;
                        for (const p of positions) {
                            const v = p.quantity * (p.curPrice != null ? p.curPrice : 0.0);
                            if (p.instrumentType.toLowerCase() === 'futures') futuresValue += v;
                            else accountEquity += v;
                        }
                        accounts.push({
                            broker: 'tinkoff', id: acc.id, name: acc.name, type: acc.type,
                            equity: round(accountEquity, 2), cash: round(await tcsClient.getCash(acc.id), 2),
                            futuresValue: round(futuresValue, 2), positionsCount: positions.length
                        });

                        // В holdings идут только ценные бумаги (bond/share/etf);
                        // метаданные облигаций подтянутся после загрузки реестра
                        for (const p of positions) {
                            if (['bond', 'share', 'etf'].indexOf(p.instrumentType) === -1 || p.quantity <= 0) continue;

                            let ticker, name, nominal, sector, couponPerYear, maturity;
                            if (p.instrumentType === 'bond') {
                                ticker = p.ticker !== '' ? p.ticker : p.figi;
                                name = ticker;
                                nominal = 1000.0; sector = ''; couponPerYear = 0; maturity = '';
                            } else {
                                const kind = p.instrumentType === 'share' ? 'INSTRUMENT_TYPE_SHARE' : 'INSTRUMENT_TYPE_ETF';
                                if (p.ticker !== '' && nameCache[p.ticker] === undefined) {
                                    const info = await tcsClient.findInstrument(p.ticker, kind, p.classCode);
                                    nameCache[p.ticker] = info != null && info.name != null ? info.name : p.ticker;
                                }
                                ticker = p.ticker !== '' ? p.ticker : p.figi;
                                name = nameCache[p.ticker] !== undefined ? nameCache[p.ticker] : ticker;
                                nominal = 0.0; sector = ''; couponPerYear = 0; maturity = '';
                            }

                            const avgPriceRub = p.avgPrice != null ? p.avgPrice : 0.0;
                            const curPriceRub = p.curPrice != null ? p.curPrice : 0.0;
                            ticker = baseTicker(ticker);  // на хранение — тикер без суффикса площадки

                            // Один инструмент на разных площадках = разные figi (TMON@ и TMON):
                            // сначала figi, затем фолбэк по базовому тикеру и типу инструмента.
                            const base = baseTicker(ticker);
                            let key = p.figi;
                            if (holdings[key] === undefined) {
                                for (const bk of Object.keys(holdingsByBase)) {
                                    const hk = holdingsByBase[bk];
                                    if (bk === base && (holdings[hk] ? holdings[hk].instrumentType : '') === p.instrumentType) {
                                        key = hk;
                                        break;
                                    }
                                }
                            }

                            if (holdings[key] !== undefined) {
                                const h = holdings[key];
                                const newQty = h.quantity + p.quantity;
                                if (newQty > 0 && avgPriceRub > 0) {
                                    h.avgPrice = (h.quantity * h.avgPrice + p.quantity * avgPriceRub) / newQty;
                                }
                                h.quantity = newQty;
                                h.brokerQty.tinkoff = (h.brokerQty.tinkoff || 0) + p.quantity;
                                h.sources.push('tcs');
                                h.sources = Array.from(new Set(h.sources));
                                holdingsByBase[base] = key;
                            } else {
                                holdingsByBase[base] = key;
                                holdings[key] = {
                                    figi: p.figi, ticker: ticker, name: name,
                                    instrumentType: p.instrumentType,
                                    quantity: p.quantity, avgPrice: avgPriceRub, curPrice: curPriceRub,
                                    nominal: nominal, sector: sector, couponPerYear: couponPerYear,
                                    maturityDate: maturity,
                                    sources: ['tcs'], brokerQty: { tinkoff: p.quantity, finam: 0 },
                                    payments: []
                                };
                            }
                        }
                    }
                    progress.finish('tcs_portfolios', 'T-Invest: портфели загружены', 'tcs');
                    brokerMeta.tinkoff.status = 'ok';
                } catch (e) {
                    brokerMeta.tinkoff.status = 'error';
                    brokerMeta.tinkoff.error = errMsg(e, 200);
                    tcsClient = null;
                    accounts = accounts.filter(a => a.broker !== 'tinkoff');
                    emit({ event: 'broker_status', broker: 'tinkoff', status: 'error', error: brokerMeta.tinkoff.error });
                    progress.finish('tcs_accounts', 'T-Invest: ошибка — ' + brokerMeta.tinkoff.error, 'tcs');
                    progress.finish('tcs_portfolios', '', 'tcs');
                }
                brokerMeta.tinkoff.durationMs = Date.now() - t0;
            }

            // ---------- Этап 3: реестр облигаций (T-Invest или кэш) ----------
            let cachedBonds = null;
            try {
                const raw = localStorage.getItem(BONDS_KEY);
                if (raw !== null) {
                    cachedBonds = JSON.parse(raw);
                    if (cachedBonds === null || typeof cachedBonds !== 'object' || cachedBonds.bonds == null) {
                        cachedBonds = null;
                    }
                }
            } catch (e) { cachedBonds = null; }
            const ttl = BONDS_CACHE_TTL_HOURS * 3600;

            if (tcsClient !== null) {
                progress.step('bonds', 0.15, 'Справочник облигаций T-Invest…', 'tcs');
                const cachedAt = cachedBonds !== null ? Date.parse(cachedBonds.cachedAt) / 1000 : NaN;
                const cacheFresh = cachedBonds !== null && (Date.now() / 1000 - cachedAt) < ttl;
                if (cacheFresh) {
                    bonds = Array.isArray(cachedBonds.bonds) ? cachedBonds.bonds : [];
                    progress.finish('bonds', 'Справочник облигаций: из кэша (' + bonds.length + ')', 'tcs');
                } else {
                    progress.step('bonds', 0.4, 'Загрузка справочника облигаций (может занять минуту)…', 'tcs');
                    try {
                        bonds = await tcsClient.getAllBonds();
                        try {
                            localStorage.setItem(BONDS_KEY,
                                JSON.stringify({ cachedAt: new Date().toISOString(), bonds: bonds }));
                        } catch (e2) { /* приватный режим — обойдёмся без кэша */ }
                        progress.finish('bonds', 'Справочник облигаций: ' + bonds.length + ' шт (обновлён)', 'tcs');
                    } catch (e) {
                        // Протухший кэш лучше, чем ничего: номиналы нужны для конвертации Finam
                        if (cachedBonds !== null) {
                            bonds = Array.isArray(cachedBonds.bonds) ? cachedBonds.bonds : [];
                            progress.finish('bonds',
                                'Справочник: обновление не удалось, используется кэш (' + bonds.length + ')', 'tcs');
                        } else {
                            progress.finish('bonds', 'Справочник облигаций недоступен: ' + errMsg(e, 120), 'tcs');
                        }
                    }
                }
            } else if (cachedBonds !== null) {
                // Finam-only режим: номиналы облигаций берём из кэша
                bonds = Array.isArray(cachedBonds.bonds) ? cachedBonds.bonds : [];
                progress.finish('bonds', 'Справочник облигаций: из кэша (' + bonds.length + ')', 'system');
            } else {
                progress.finish('bonds', 'Справочник облигаций недоступен (номинал по умолчанию 1000 ₽)', 'system');
            }

            // ---------- Этап 4: конвертация Finam-позиций + обогащение облигаций ----------
            progress.finish('finalize', 'Слияние позиций и расчёт итогов…');

            const bondLookup = buildBondLookup(bonds);
            for (const pos of finamRawPositions) {
                mergeFinamPosition(holdings, pos, findBond(bondLookup, tickerFromSymbol(pos.symbol)));
            }
            for (const k of Object.keys(holdings)) {
                const h = holdings[k];
                if (h.instrumentType !== 'bond') continue;
                const bond = findBond(bondLookup, h.ticker !== '' ? h.ticker : h.figi);
                if (bond === null) continue;
                if (bond.ticker !== '') h.ticker = bond.ticker;
                if (bond.name !== '') h.name = bond.name;
                h.nominal = bond.nominal;
                h.sector = bond.sector;
                h.couponPerYear = bond.couponPerYear;
                h.maturityDate = bond.maturityDate;
            }

            // ---------- Этап 5: платежи (купоны + дивиденды) ----------
            const anyOk = brokerMeta.tinkoff.status === 'ok' || brokerMeta.finam.status === 'ok';
            const holdingKeys = Object.keys(holdings);
            if (anyOk && holdingKeys.length > 0) {
                const n = holdingKeys.length;
                let i = 0;
                for (const key of holdingKeys) {
                    i++;
                    const h = holdings[key];
                    progress.step('payments', i / n,
                        'Выплаты: ' + (h.ticker ? h.ticker : String(h.name).slice(0, 20)), 'tcs');
                    let payments = [];

                    if (tcsClient !== null && h.figi !== '') {
                        if (h.instrumentType === 'bond') {
                            for (const c of await tcsClient.getCoupons(h.figi)) {
                                if (c.currency === 'rub' && c.date >= today) payments.push(c);
                            }
                        } else if (h.instrumentType === 'share' || h.instrumentType === 'etf') {
                            for (const d of await tcsClient.getDividends(h.figi)) {
                                if (d.currency === 'rub' && d.date >= today) payments.push(d);
                            }
                        }
                    }

                    // Fallback: Finam future-dividends для позиций без выплат (нужен полный символ с «@»)
                    if (payments.length === 0 && finamClient !== null) {
                        const symbol = finamPositionsByTicker[h.ticker];
                        if (symbol !== undefined) {
                            for (const d of await finamClient.getFutureDividends(symbol)) {
                                if (d.currency === 'rub' && d.date >= today) payments.push(d);
                            }
                        }
                    }

                    payments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
                    for (const p of payments) p.amountPerUnit = round(p.amountPerUnit, 4);
                    h.payments = payments;
                }
                progress.finish('payments', 'Выплаты загружены', 'system');
            } else {
                progress.finish('payments',
                    holdingKeys.length === 0 ? 'Нет позиций' : 'Пропущено (нет связи с брокерами)', 'system');
            }

            // Все включённые брокеры упали — не перезаписываем последний хороший портфель
            if (!anyOk) {
                emit({ event: 'done', saved: false,
                    totalMs: Date.now() - startedAt,
                    brokers: brokerMeta,
                    message: 'Все брокеры недоступны — сохранены прежние данные' });
                return;
            }

            // ---------- Этап 6: итоги + история + запись ----------
            const result = computeTotals(holdings, accounts);
            const totalMs = Date.now() - startedAt;

            const portfolio = {
                meta: {
                    version: 1,
                    generatedAt: new Date().toISOString(),
                    durationMs: totalMs,
                    brokers: brokerMeta
                },
                accounts: accounts,
                holdings: result.holdings,
                totals: result.totals,
                history: []
            };

            // История: один снапшот на день; мок-история не смешивается с реальной
            let prev = null;
            try { prev = JSON.parse(localStorage.getItem(PORTFOLIO_KEY) || 'null'); } catch (e) { prev = null; }
            let history = (prev && typeof prev === 'object' && !(prev.meta && prev.meta.mock) && Array.isArray(prev.history))
                ? prev.history
                : [];
            history = history.filter(e => e && typeof e === 'object' && (e.date !== undefined ? e.date : '') !== today);
            history.push({
                date: today,
                value: portfolio.totals.value,
                cost: portfolio.totals.cost,
                pnl: portfolio.totals.pnl,
                cash: portfolio.totals.cash
            });
            history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
            if (history.length > HISTORY_LIMIT) history = history.slice(history.length - HISTORY_LIMIT);
            portfolio.history = history;

            progress.finish('write', 'Сохранение портфеля…');
            const saved = writePortfolio(portfolio);

            emit({ event: 'broker_status', broker: 'tinkoff', status: brokerMeta.tinkoff.status, error: brokerMeta.tinkoff.error });
            emit({ event: 'broker_status', broker: 'finam', status: brokerMeta.finam.status, error: brokerMeta.finam.error });
            emit({ event: 'done', saved: saved, totalMs: totalMs, brokers: brokerMeta, portfolio: portfolio });
        } catch (e) {
            // Аналог fail() в sync.php: неожиданная ошибка → сообщаем и выходим
            emit({ event: 'error', message: errMsg(e) });
        }
    }

    return { runSync };
})();
window.WalletSync = WalletSync;

// ---------- Автосинхронизация (APK) ----------
// Раз в день в заданное время (настройки → «Синхронизация»): пока приложение
// открыто, время пришло и сегодня автосинка ещё не было — запускаем штатную
// синхронизацию, ту же, что у кнопки «Обновить» в портфеле. День отмечаем
// ДО запуска: неудача не должна превращаться в ретраи каждые 30 секунд.
//
// ФОНОВЫЙ запуск: ?autosync=1 в адресе значит, что страницу поднял SyncService
// по будильнику (приложение пользователь не открывал). Время сверять не нужно —
// будильник уже сработал; после завершения зовём WalletAndroid.syncDone(),
// чтобы сервис погасил WebView. День отмечаем ПОСЛЕ успешного прогона —
// ретраев в фоне нет, а неудачная синхронизация должна повториться, когда
// пользователь откроет приложение.
(function () {
    const AUTO_SYNC_DATE_KEY = 'walletAutoSyncDate';
    const BACKGROUND = location.search.indexOf('autosync=1') !== -1;

    function todayKey() {
        const n = new Date();
        return n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2)
            + '-' + ('0' + n.getDate()).slice(-2);
    }

    function signalDone() {
        if (window.WalletAndroid && WalletAndroid.syncDone) {
            try { WalletAndroid.syncDone(); } catch (e) { /* сервис уже погашен */ }
        }
    }

    if (BACKGROUND) {
        setTimeout(function () {
            try {
                let last = '';
                try { last = localStorage.getItem(AUTO_SYNC_DATE_KEY) || ''; } catch (e) { /* приватный */ }
                if (last === todayKey() || !window.__walletRunSync) { signalDone(); return; }
                const p = window.__walletRunSync(false);
                if (p && typeof p.then === 'function') {
                    p.then(function () {
                        try { localStorage.setItem(AUTO_SYNC_DATE_KEY, todayKey()); } catch (e) {}
                        signalDone();
                    }, signalDone);
                } else {
                    signalDone();
                }
            } catch (e) { signalDone(); }
        }, 1500); // app.js должен успеть подняться: токены и данные — в localStorage
        return;
    }

    function autoSyncCheck() {
        let s = null;
        try { s = JSON.parse(localStorage.getItem('walletSettings') || '{}'); } catch (e) { s = {}; }
        const cfg = s && s.autoSync;
        if (!cfg || !cfg.enabled) return;
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
            Math.min(23, parseInt(cfg.hour, 10) || 0), Math.min(59, parseInt(cfg.minute, 10) || 0));
        if (now < target) return;
        const today = todayKey();
        let last = '';
        try { last = localStorage.getItem(AUTO_SYNC_DATE_KEY) || ''; } catch (e) { /* приватный режим */ }
        if (last === today) return;
        try { localStorage.setItem(AUTO_SYNC_DATE_KEY, today); } catch (e) { /* приватный режим */ }
        if (window.__walletRunSync) window.__walletRunSync(false);
    }

    setInterval(autoSyncCheck, 30000);
    // запуск приложения: если время уже пришло — не ждём первого тика
    setTimeout(autoSyncCheck, 4000);
})();
