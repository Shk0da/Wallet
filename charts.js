/**
 * charts.js — SVG-графики без зависимостей для дашборда WALLET
 *
 * Метод: сначала форма (задача данных), потом цвет по задаче; палитра Taiga UI
 * валидирована (dataviz validate_palette.js, светлая тема, прогон 2026-10-02):
 *   категориальный ряд (8 слотов): #428BF9 #F59200 #D08FFF #00A328 #FF7A91
 *     #2ABBF4 #FF6347 #66A3FF — ALL PASS (контраст <3:1 у части слотов —
 *     компенсировано легендой с суммами, тултипами и таблицей-близнецом)
 *   типы:     share #428BF9 / bond #F59200 / etf #D08FFF (слоты 1–3) — PASS
 *   платежи:  купоны #F59200 / дивиденды #428BF9          — PASS (ΔE 30.7)
 *   брокеры:  tinkoff #FFDD2D / finam #428BF9 — CVD PASS (ΔE 39.9), контраст
 *     жёлтого 1.31:1 — ДОКУМЕНТИРОВАННОЕ бренд-исключение (жёлтый Т-Банка не
 *     идёт в заливки других серий); спасение: чёрные %-подписи внутри сегмента,
 *     легенда с суммами, тултипы, таблица-близнец
 *   статусы:  income #00B92D / expense #F52222 — только со знаком ±
 * Общие правила: линии 2px; маркеры ≥8px с 2px «кольцом» поверхности; заливка
 * области ~10%; столбцы ≤24px, скругление 4px только у вершины (базовая линия —
 * прямая); 2px зазор поверхности между соприкасающимися отметками; сетка —
 * сплошной hairline; текст — только чернилами (ink), не цветом серии; подписи —
 * выборочно; у каждого графика есть табличный близнец (тумблер «Таблица»).
 */
const Charts = (() => {
    'use strict';

    // ---------- Палитра (Taiga UI; проверена валидатором, светлая тема) ----------
    // Цвета серий фиксированы (тема их не меняет), а чернила/сетка/поверхность —
    // токены темы через var(): уже нарисованные SVG перекрашиваются сами при
    // переключении html.dark, без перерендера. var() живёт только в style,
    // поэтому el() ниже переносит такие fill/stroke из атрибутов в style.
    const C = {
        primary: '#428BF9', deep: '#F59200', teal: '#2ABBF4',
        tinkoff: '#FFDD2D', finam: '#428BF9',
        income: '#00B92D', expense: '#F52222',
        ink: 'var(--tui-text)', ink2: 'var(--tui-text-2)',
        grid: 'var(--tui-border-soft)', surface: 'var(--tui-surface)',
        gray: 'var(--tui-text)'
    };
    // Категориальный ряд — фиксированный порядок, не цикл смещений (dataviz)
    const CATEGORICAL = ['#428BF9', '#F59200', '#D08FFF', '#00A328', '#FF7A91', '#2ABBF4', '#FF6347', '#66A3FF'];
    // Чернила для подписи НАД заливкой: светлый фон (жёлтый) → тёмный текст
    function labelInkOn(hex) {
        const h = hex.replace('#', '');
        const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return lum > 0.55 ? '#333333' : '#ffffff';
    }
    const BROKER_COLORS = { tinkoff: C.tinkoff, finam: C.finam };
    const TYPE_COLORS = { share: C.primary, bond: C.deep, etf: '#D08FFF', futures: C.teal };
    const TYPE_LABELS = { share: 'Акции', bond: 'Облигации', etf: 'ETF', futures: 'Фьючерсы' };

    // Базовая ширина viewBox; масштабируется равномерно. На телефоне рендерим
    // уже (360): при 640, ужатых CSS до ~340px, все подписи мельчают до ~53%.
    // Пересчитывается перед каждым рендером (см. chartWidth ниже).
    let W = 640;
    function chartWidth() {
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
        W = (vw > 0 && vw < 500) ? 360 : 640;
    }

    // ---------- Форматирование ----------
    const fmt = {
        rub: v => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(v)) + ' ₽',
        compact(v) { // 1,28 млн ₽ / 4,2 млн ₽
            const a = Math.abs(v);
            if (a >= 1e9) return (v / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' млрд ₽';
            if (a >= 1e6) return (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' млн ₽';
            if (a >= 1e4) return Math.round(v / 1e3).toLocaleString('ru-RU') + ' тыс ₽';
            return Math.round(v).toLocaleString('ru-RU') + ' ₽';
        },
        compactNum(v) {
            const a = Math.abs(v);
            if (a >= 1e6) return (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' млн';
            if (a >= 1e3) return (v / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' тыс';
            return Math.round(v).toLocaleString('ru-RU');
        },
        pct: v => (v == null ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + '%'),
        date(iso) {
            const m = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
            const [y, mo, d] = iso.split('-').map(Number);
            return d + ' ' + (m[mo - 1] || '') + (mo === 1 ? ' ' + String(y).slice(2) : '');
        }
    };

    // ---------- SVG-хелперы ----------
    function el(name, attrs = {}, parent = null) {
        const n = document.createElementNS('http://www.w3.org/2000/svg', name);
        for (const k in attrs) {
            const v = attrs[k];
            // var()-значения — только в style: презентационные атрибуты SVG
            // кастомные свойства не понимают (Chromium 57 это уже умеет в CSS)
            if ((k === 'fill' || k === 'stroke') && typeof v === 'string' && v.indexOf('var(') === 0) n.style[k] = v;
            else n.setAttribute(k, v);
        }
        if (parent) parent.appendChild(n);
        return n;
    }
    // Текст всегда textContent — имена серий приходят из API
    function txt(parent, x, y, str, attrs = {}) {
        const t = el('text', Object.assign({
            x, y, fill: attrs.fill || C.ink2, 'font-size': attrs.size || 11,
            'text-anchor': attrs.anchor || 'start', 'font-family': 'inherit'
        }, attrs), parent);
        t.textContent = str;
        if (attrs.transform) t.setAttribute('transform', attrs.transform);
        return t;
    }

    // Красивые деления оси: 1 / 2 / 2.5 / 5 × 10^k
    function niceStep(range, count) {
        const raw = range / Math.max(1, count);
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
        return 10 * mag;
    }

    // ---------- Тултип (один на контейнер) ----------
    // Значения — сильным элементом, имя серии — вторичным; ключ серии — штрих цвета
    function tooltipFor(container) {
        let tip = container.querySelector(':scope > .chart-tooltip');
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'chart-tooltip';
            tip.setAttribute('role', 'status');
            container.appendChild(tip);
        }
        return {
            show(atX, atY, title, rows) {
                tip.textContent = '';
                if (title) { const h = document.createElement('div'); h.className = 'ct-title'; h.textContent = title; tip.appendChild(h); }
                for (const r of rows) {
                    const row = document.createElement('div'); row.className = 'ct-row';
                    const key = document.createElement('span'); key.className = 'ct-key';
                    key.style.background = r.color || C.ink2;               // штрих цвета серии
                    const val = document.createElement('strong'); val.textContent = r.value; // значение ведёт
                    const name = document.createElement('span'); name.className = 'ct-name'; name.textContent = r.name;
                    row.append(key, val, name); tip.appendChild(row);
                }
                tip.style.visibility = 'hidden'; tip.style.display = 'block';
                const cw = container.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
                let x = atX + 14; if (x + tw > cw - 6) x = atX - tw - 14; if (x < 6) x = 6;
                let y = Math.max(6, atY - th - 12); if (y + th > container.clientHeight - 4) y = container.clientHeight - th - 4;
                tip.style.left = x + 'px'; tip.style.top = y + 'px'; tip.style.visibility = 'visible';
            },
            hide() { tip.style.display = 'none'; }
        };
    }

    // Тумблер «График / Таблица» + каркас карточки (табличный близнец обязателен)
    function makeInteractive(card, buildSvg, buildTable) {
        const body = document.createElement('div');
        body.className = 'chart-body';
        const controls = document.createElement('div');
        controls.className = 'chart-controls';
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'chart-table-btn'; btn.textContent = 'Таблица';
        let mode = 'chart', tableEl = null, svgEl = buildSvg();
        const swap = () => {
            if (mode === 'chart') {
                mode = 'table';
                if (!tableEl) tableEl = buildTable();
                svgEl.style.display = 'none'; body.appendChild(tableEl);
                btn.textContent = 'График';
            } else {
                mode = 'chart';
                tableEl.style.display = 'none'; svgEl.style.display = '';
                btn.textContent = 'Таблица';
            }
        };
        btn.addEventListener('click', swap);
        controls.appendChild(btn);
        body.appendChild(svgEl);
        card.append(controls, body);
        return body;
    }

    function tableEl(columns, rows) {
        const t = document.createElement('table');
        t.className = 'chart-table';
        const thead = t.createTHead().insertRow();
        for (const c of columns) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = c; thead.appendChild(th); }
        const tb = t.createTBody();
        for (const r of rows) {
            const tr = tb.insertRow();
            for (const cell of r) {
                const td = tr.insertCell();
                if (cell && cell.color) { const dot = document.createElement('span'); dot.className = 'td-dot'; dot.style.background = cell.color; td.appendChild(dot); }
                td.appendChild(document.createTextNode(cell && cell.text != null ? cell.text : String(cell)));
            }
        }
        return t;
    }

    // ---------- Легенда ----------
    function legend(items, marker = 'rect') {
        const div = document.createElement('div');
        div.className = 'chart-legend';
        for (const it of items) {
            const item = document.createElement('span'); item.className = 'legend-item';
            const sw = document.createElement('span');
            sw.className = marker === 'line' ? 'legend-line' : 'legend-swatch';
            // пунктирная серия — пунктир и в легенде
            sw.style.background = (marker === 'line' && it.dash)
                ? 'repeating-linear-gradient(90deg, ' + it.color + ' 0 4px, transparent 4px 8px)'
                : it.color;
            const label = document.createElement('span'); label.textContent = it.label;
            item.append(sw, label); div.appendChild(item);
        }
        return div;
    }

    // ---------- Линии / область (история портфеля) ----------
    // series: [{name, color, points:[{x, y}], area?:bool, emphasize?:bool}]
    // xFormat(v) — подпись оси X и заголовок тултипа (по умолчанию — дата)
    // Перекрестие ловит X по всей ширине; тултип перечисляет все серии.
    function line(opts) {
        const { series, height = 240 } = opts;
        const xFormat = opts.xFormat || fmt.date;
        chartWidth();
        const wrap = document.createElement('div'); wrap.className = 'chart-wrap';
        const svg = el('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart-svg', role: 'img' });
        wrap.appendChild(svg);

        const padL = 56, padR = 16, padT = 14, padB = 26;
        const iw = W - padL - padR, ih = height - padT - padB;
        const n = series[0].points.length;
        const allY = [].concat.apply([], series.map(s => s.points.map(p => p.y)));
        let yMin = opts.yFromZero ? 0 : Math.min(...allY);
        let yMax = Math.max(...allY, yMin + 1);
        const pad = (yMax - yMin) * 0.08 || yMax * 0.08 || 1;
        if (opts.yFromZero) yMin = 0; else yMin = Math.max(0, yMin - pad);
        yMax += pad;
        const step = niceStep(yMax - yMin, 4);
        yMax = Math.ceil(yMax / step) * step;

        const X = i => padL + (n <= 1 ? iw / 2 : i * iw / (n - 1));
        const Y = v => padT + ih - (v - yMin) / (yMax - yMin || 1) * ih;

        // Сетка: сплошные hairline, значения слева (чистые числа)
        for (let v = yMin; v <= yMax + 1e-9; v += step) {
            const y = Y(v);
            el('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: C.grid, 'stroke-width': 1 }, svg);
            txt(svg, padL - 8, y + 4, fmt.compactNum(v), { anchor: 'end', 'font-size': 10 });
        }
        // Подписи X: первая / середина / последняя дата
        for (const i of [0, Math.floor((n - 1) / 2), n - 1]) {
            if (i >= 0 && i < n) txt(svg, X(i), height - 8, xFormat(series[0].points[i].x), { anchor: i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', 'font-size': 10 });
        }

        const tip = tooltipFor(wrap);
        const markerLayer = el('g', {}, svg);
        const cross = el('line', { y1: padT, y2: padT + ih, stroke: C.ink2, 'stroke-width': 1, visibility: 'hidden' }, svg);
        const dots = series.map(() => el('circle', { r: 4, fill: C.surface, visibility: 'hidden' }, markerLayer));

        series.forEach((s, si) => {
            const d = s.points.map((p, i) => (i === 0 ? 'M' : 'L') + X(i).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join(' ');
            if (s.area) {
                const a = el('path', { d: `M${X(0)},${Y(s.points[0].y)} ` + s.points.map((p, i) => 'L' + X(i).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join(' ') + ` L${X(n - 1)},${padT + ih} L${X(0)},${padT + ih} Z`, fill: s.color, 'fill-opacity': 0.1 }, svg);
            }
            const line = el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
            if (s.dash) line.setAttribute('stroke-dasharray', '6 4'); // производная серия (напр., «с учетом инфляции»)
            dots[si].setAttribute('stroke', s.color); dots[si].setAttribute('stroke-width', 2); dots[si].style.fill = C.surface;
        });
        // Выборочная прямая подпись: конечная точка серии-истории (emphasize)
        const main = series.find(s => s.emphasize) || series[0];
        const last = main.points[n - 1];
        txt(svg, Math.min(X(n - 1) + 2, W - padR - 4), Y(last.y) - 8, fmt.compact(last.y), { anchor: 'end', size: 11, fill: C.ink, 'font-weight': 600 });

        // Слой перекрестия: ловим X по всей области (цель больше отметки)
        const hit = el('rect', { x: padL, y: padT, width: iw, height: ih, fill: 'transparent', tabindex: 0, role: 'slider', 'aria-label': 'Точка на графике' }, svg);
        const move = (clientX) => {
            const r = svg.getBoundingClientRect();
            const px = (clientX - r.left) / r.width * W;
            const i = Math.max(0, Math.min(n - 1, Math.round((px - padL) / (iw / Math.max(1, n - 1)))));
            cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
            series.forEach((s, si) => {
                dots[si].setAttribute('cx', X(i)); dots[si].setAttribute('cy', Y(s.points[i].y)); dots[si].setAttribute('visibility', 'visible');
            });
            const rows = series.map(s => ({ name: s.name, value: fmt.rub(s.points[i].y), color: s.color }));
            tip.show(X(i) / W * r.width, Y(main.points[i].y) / height * r.height, xFormat(main.points[i].x), rows);
        };
        hit.addEventListener('pointermove', e => move(e.clientX));
        hit.addEventListener('pointerdown', e => move(e.clientX));
        hit.addEventListener('pointerleave', tip.hide);
        hit.addEventListener('blur', tip.hide);
        hit.addEventListener('keydown', e => {
            const cur = dots[0].getAttribute('cx');
            if (!(e.key === 'ArrowLeft' || e.key === 'ArrowRight') || cur == null) return;
            e.preventDefault();
            const r = svg.getBoundingClientRect();
            move(r.left + (+cur + (e.key === 'ArrowLeft' ? -iw / (n - 1) : iw / (n - 1))) / W * r.width);
        });

        const out = document.createElement('div');
        out.append(wrap);
        if (series.length >= 2) out.appendChild(legend(series.map(s => ({ label: s.name, color: s.color, dash: s.dash })), 'line'));
        out._table = () => tableEl(['Дата', ...series.map(s => s.name)],
            series[0].points.map((p, i) => [{ text: p.x }, ...series.map(s => ({ text: fmt.rub(s.points[i].y), color: s.color }))]));
        return out;
    }

    // ---------- Кольцевая диаграмма (брокеры / типы активов) ----------
    // ≤6 сегментов; центр — итог; % внутри сегмента, если помещается; иначе легенда+тултип.
    function donut(opts) {
        const { data, centerLabel, centerValue, size = 200 } = opts; // data:[{label, value, color}]
        const wrap = document.createElement('div'); wrap.className = 'chart-wrap donut-wrap';
        const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, class: 'chart-svg donut-svg', role: 'img' });
        wrap.appendChild(svg);
        const tip = tooltipFor(wrap);

        const total = data.reduce((s, d) => s + d.value, 0) || 1;
        const cx = size / 2, cy = size / 2, R = size / 2 - 6, r = R * 0.62;
        let a = -Math.PI / 2;
        const rows = [];
        data.forEach((d) => {
            const frac = d.value / total;
            const a2 = a + frac * Math.PI * 2;
            const large = a2 - a > Math.PI ? 1 : 0;
            const p = (rad, ang) => cx + rad * Math.cos(ang) + ',' + (cy + rad * Math.sin(ang));
            const d0 = `M${p(R, a)} A${R},${R} 0 ${large} 1 ${p(R, a2)} L${p(r, a2)} A${r},${r} 0 ${large} 0 ${p(r, a)} Z`;
            // 2px «зазор поверхности»: обводка цветом карточки, не рамка вокруг данных
            const seg = el('path', { d: d0, fill: d.color, stroke: C.surface, 'stroke-width': 2, tabindex: 0, role: 'img', 'aria-label': d.label + ' ' + Math.round(frac * 100) + '%' }, svg);
            const mid = (a + a2) / 2;
            // % внутри сегмента — только если помещается; чернила по яркости заливки
            if (frac >= 0.09) txt(svg, cx + (R + r) / 2 * Math.cos(mid), cy + (R + r) / 2 * Math.sin(mid) + 4,
                Math.round(frac * 100) + '%', { anchor: 'middle', size: 12, fill: labelInkOn(d.color), 'font-weight': 600 });
            const show = () => tip.show(cx + R * Math.cos(mid) - 40, cy + R * Math.sin(mid) - 40, d.label, [
                { name: fmt.pct(frac * 100) + ' от ' + fmt.compact(total), value: fmt.rub(d.value), color: d.color }
            ]);
            seg.addEventListener('pointermove', show); seg.addEventListener('focus', show);
            seg.addEventListener('pointerleave', tip.hide); seg.addEventListener('blur', tip.hide);
            rows.push([{ text: d.label, color: d.color }, { text: fmt.rub(d.value) }, { text: fmt.pct(frac * 100) }]);
            a = a2;
        });
        txt(svg, cx, cy - 4, centerValue, { anchor: 'middle', size: 17, fill: C.ink, 'font-weight': 700 });
        txt(svg, cx, cy + 15, centerLabel, { anchor: 'middle', size: 10.5 });

        const out = document.createElement('div');
        out.append(wrap);
        out.appendChild(legend(data.map(d => ({ label: d.label + ' · ' + fmt.compact(d.value), color: d.color }))));
        out._table = () => tableEl(['Категория', 'Стоимость', 'Доля'], rows);
        return out;
    }

    // ---------- Столбцы (платежи по месяцам, stacked) ----------
    // groups: [{label, segments:[{value, color, name}]}]
    function bars(opts) {
        const { groups, height = 220 } = opts;
        chartWidth();
        const wrap = document.createElement('div'); wrap.className = 'chart-wrap';
        const svg = el('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart-svg', role: 'img' });
        wrap.appendChild(svg);
        const tip = tooltipFor(wrap);

        const padL = 56, padR = 10, padT = 12, padB = 26;
        const iw = W - padL - padR, ih = height - padT - padB;
        const yMax = Math.max(1, ...groups.map(g => g.segments.reduce((s, x) => s + x.value, 0)));
        const step = niceStep(yMax, 4);
        const top = Math.ceil(yMax / step) * step;
        const Y = v => padT + ih - v / top * ih;
        const band = iw / groups.length;
        const bw = Math.min(24, band * 0.6); // ≤24px, остальное — воздух

        for (let v = 0; v <= top + 1e-9; v += step) {
            const y = Y(v);
            el('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: C.grid, 'stroke-width': 1 }, svg);
            txt(svg, padL - 8, y + 4, fmt.compactNum(v), { anchor: 'end', 'font-size': 10 });
        }

        const rows = [];
        groups.forEach((g, i) => {
            const x = padL + i * band + (band - bw) / 2;
            let y = padT + ih;
            g.segments.forEach((s2) => {
                const h = s2.value / top * ih;
                y -= h;
                // скругление 4px — только на верхушке стопки (верхний ненулевой сегмент)
                const isTop = s2 === [...g.segments].reverse().find(z => z.value > 0);
                const r = isTop && h > 4 ? 4 : 0;
                const rect = el('rect', {
                    x, y, width: bw, height: Math.max(h, 0), fill: s2.color,
                    rx: r, stroke: C.surface, 'stroke-width': 2, tabindex: 0,
                    'aria-label': g.label + ' ' + s2.name + ' ' + Math.round(s2.value)
                }, svg);
                const show = () => tip.show(x + bw / 2, y - 10, g.label, g.segments.filter(z => z.value > 0)
                    .map(z => ({ name: z.name, value: fmt.rub(z.value), color: z.color })));
                rect.addEventListener('pointermove', show); rect.addEventListener('focus', show);
                rect.addEventListener('pointerleave', tip.hide); rect.addEventListener('blur', tip.hide);
            });
            txt(svg, x + bw / 2, height - 8, g.label, { anchor: 'middle', 'font-size': 9.5 });
            rows.push([{ text: g.label }, ...g.segments.map(z => ({ text: fmt.rub(z.value), color: z.color }))]);
        });

        const out = document.createElement('div');
        out.append(wrap);
        const names = [...new Set([].concat.apply([], groups.map(g => g.segments.map(s2 => s2.name))))];
        const colorByName = {};
        groups.forEach(g => g.segments.forEach(s2 => { if (s2.value > 0 && !colorByName[s2.name]) colorByName[s2.name] = s2.color; }));
        out.appendChild(legend(names.map(n => ({ label: n, color: colorByName[n] || C.primary }))));
        out._table = () => tableEl(['Месяц', ...names], rows);
        return out;
    }

    // ---------- Горизонтальные полосы (топ позиций) ----------
    // Одна мера ⇒ один цвет; значение у вершины полосы; бейдж PnL — статус со знаком.
    // rows: [{label, sub?, value, valueLabel, badge?:{text, positive}}]
    function hbars(opts) {
        const { rows, height } = opts;
        chartWidth();
        const rowH = 46, head = 6;
        const h = height || head + rows.length * rowH + 10;
        const wrap = document.createElement('div'); wrap.className = 'chart-wrap';
        const svg = el('svg', { viewBox: `0 0 ${W} ${h}`, class: 'chart-svg', role: 'img' });
        wrap.appendChild(svg);
        const tip = tooltipFor(wrap);

        const labelW = 150, valW = 92, padR = 10;
        const iw = W - labelW - valW - padR;
        const max = Math.max(1, ...rows.map(r => r.value));
        const barH = 14; // ≤24px, тонкие полосы

        rows.forEach((r, i) => {
            const y = head + i * rowH;
            const name = txt(svg, 0, y + 13, r.label, { 'font-size': 11.5, fill: C.ink, 'font-weight': 600 });
            if (r.sub) txt(svg, 0, y + 27, r.sub, { 'font-size': 10 });
            const bw = Math.max(2, r.value / max * iw);
            el('rect', { x: labelW, y: y + 5, width: bw, height: barH, rx: 4, fill: C.primary, stroke: C.surface, 'stroke-width': 2 }, svg);
            // Значение у вершины полосы (снаружи — всегда помещается)
            txt(svg, labelW + bw + 8, y + 16, r.valueLabel, { 'font-size': 11.5, fill: C.ink, 'font-weight': 600 });
            if (r.badge) txt(svg, W - padR, y + 16, r.badge.text, {
                anchor: 'end', 'font-size': 11, 'font-weight': 600, fill: r.badge.positive ? C.income : C.expense
            });
            // Хит-зона шире отметки
            const hit = el('rect', { x: 0, y, width: W, height: rowH - 8, fill: 'transparent', tabindex: 0, 'aria-label': r.label + ' ' + r.valueLabel }, svg);
            const show = () => tip.show(labelW + bw / 2, y, r.label, [
                { name: r.sub || '', value: r.valueLabel, color: C.primary },
                ...(r.badge ? [{ name: 'PnL', value: r.badge.text, color: r.badge.positive ? C.income : C.expense }] : [])
            ].filter(x => x.name !== null));
            hit.addEventListener('pointermove', show); hit.addEventListener('focus', show);
            hit.addEventListener('pointerleave', tip.hide); hit.addEventListener('blur', tip.hide);
        });

        const out = document.createElement('div');
        out.append(wrap); // одна серия — легенды нет, название в заголовке карточки
        out._table = () => tableEl(['Позиция', 'Стоимость', 'PnL'],
            rows.map(r => [{ text: r.label }, { text: r.valueLabel }, { text: r.badge ? r.badge.text : '—' }]));
        return out;
    }

    return { C, CATEGORICAL, labelInkOn, BROKER_COLORS, TYPE_COLORS, TYPE_LABELS, fmt, line, donut, bars, hbars, legend, tableEl, makeInteractive, tooltipFor };
})();
