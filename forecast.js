/**
 * forecast.js — чистая математика прогноза роста инвестиций
 *
 * Модель: ежемесячная капитализация, взнос в конце месяца:
 *   v ← v·(1 + y/12) + c
 *   вложено = v₀ + c·m
 *   прибыль = v − вложено
 * Пассивный доход к концу года ≈ v(конец года) · y (проценты на проценты).
 *
 * Доходность берётся из данных брокеров (paymentsNext12m / value), но прогноз
 * консервативно смешивает: переопределение пользователя > фактическая доля
 * выплат > значение по умолчанию. Крайние случаи описаны в effectiveYield.
 */
'use strict';

/**
 * @param {object} p
 * @param {number} p.startValue          текущая стоимость, ₽
 * @param {number} p.annualYieldPct      годовая доходность, % (например 12)
 * @param {number} p.monthlyContribution взнос в месяц, ₽
 * @param {number} p.years               горизонт, лет
 * @param {number} [p.inflationPct]      предполагаемая инфляция, %/год (0 = не учитывать)
 * @returns {{monthly:Array, yearly:Array, finalValue:number, totalInvested:number,
 *            totalEarnings:number, passiveIncomeYear:number, passiveIncomeMonth:number,
 *            finalReal:number, realPassiveIncomeYear:number, realPassiveIncomeMonth:number}}
 */
function computeForecast({ startValue, annualYieldPct, monthlyContribution, years, inflationPct }) {
    const v0 = Math.max(0, +startValue || 0);
    const c = Math.max(0, +monthlyContribution || 0);
    const months = Math.max(1, Math.round(+years || 1)) * 12;
    const r = Math.max(0, +annualYieldPct || 0) / 100 / 12; // месячная ставка
    // инфляция: дисконт будущих рублей к сегодняшним, monthly.points[].real / yearly[].realValue
    const infM = Math.max(0, +inflationPct || 0) / 100 / 12;
    const defl = m => 1 / Math.pow(1 + infM, m);

    let v = v0;
    const monthly = [{ month: 0, value: v0, invested: v0, earnings: 0, real: v0 }];
    const yearly = [{ year: 0, value: v0, invested: v0, earnings: 0, passiveYear: v0 * r * 12, realValue: v0, realPassiveYear: v0 * r * 12 }];

    for (let m = 1; m <= months; m++) {
        v = v * (1 + r) + c;
        const invested = v0 + c * m;
        monthly.push({
            month: m,
            value: v,
            invested,
            earnings: v - invested,
            real: v * defl(m)
        });
        if (m % 12 === 0) {
            yearly.push({
                year: m / 12,
                value: v,
                invested,
                earnings: v - invested,
                passiveYear: v * r * 12, // пассивный доход/год на этот момент
                realValue: v * defl(m),           // стоимость в сегодняшних рублях
                realPassiveYear: v * r * 12 * defl(m) // пассивный доход в сегодняшних рублях
            });
        }
    }

    const totalInvested = v0 + c * months;
    const dEnd = defl(months);
    return {
        monthly,
        yearly,
        finalValue: v,
        totalInvested,
        totalEarnings: v - totalInvested,
        passiveIncomeYear: v * r * 12,
        passiveIncomeMonth: v * r,
        finalReal: v * dEnd,
        realPassiveIncomeYear: v * r * 12 * dEnd,
        realPassiveIncomeMonth: v * r * dEnd
    };
}

/**
 * Эффективная доходность портфеля = Σ доля_брокера × (override ?? yieldPct_брокера).
 *
 * @param {Array<{id:string, share:number, yieldPct:number, overridePct:number|null}>} brokers
 *   share — доля стоимости (или доли пополнений, оба варианта нормируются);
 *   yieldPct — фактическая доходность из portfolio.json (0, если данных нет);
 *   overridePct — ручное переопределение пользователем (null = не задано).
 * @param {number} defaultPct  доходность по умолчанию, если у брокера нет данных
 * @returns {{pct:number, usesDefault:boolean, parts:Array}}
 *   usesDefault = true, если хоть одна доля взяла defaultPct (или брокеров нет) —
 *   UI показывает заметку «оценка по умолчанию».
 */
function effectiveYield(brokers, defaultPct) {
    const active = (brokers || []).filter(b => b.share > 0);
    if (active.length === 0) {
        return { pct: +defaultPct || 0, usesDefault: true, parts: [] };
    }
    const sum = active.reduce((s, b) => s + b.share, 0) || 1;
    let pct = 0;
    let usesDefault = false;
    const parts = [];
    for (const b of active) {
        const w = b.share / sum;
        let y = b.overridePct;
        let fromDefault = false;
        if (y == null) {
            y = b.yieldPct > 0 ? b.yieldPct : defaultPct;
            fromDefault = !(b.yieldPct > 0);
        }
        if (fromDefault) usesDefault = true;
        pct += w * y;
        parts.push({ id: b.id, weight: w, yieldPct: y, fromDefault });
    }
    return { pct, usesDefault, parts };
}

/**
 * Авто-сумма взносов: активные monthly-транзакции категории «Инвестиции».
 *
 * @param {object} cfg     investmentConfig (categoryName)
 * @param {Array}  transactions
 * @param {Array}  categories
 * @param {string} today   'YYYY-MM-DD'
 * @returns {{amount:number, count:number}}
 */
function monthlyInvestmentFromCalendar(cfg, transactions, categories, today) {
    const name = ((cfg && cfg.categoryName) || 'Инвестиции').trim().toLowerCase();
    const cat = (categories || []).find(c =>
        c && (c.name || '').trim().toLowerCase() === name && (c.type === 'exp' || c.type === 'expense'));
    if (!cat) return { amount: 0, count: 0 };

    let amount = 0, count = 0;
    for (const t of (transactions || [])) {
        if (!t || t.type !== 'expense' || (t.period !== 'monthly' && t.period !== 'biweekly') || t.category !== cat.id) continue;
        if (t.endDate && t.endDate < today) continue; // завершённые серии не считаем
        // серия, чей ближайший взнос уже за датой окончания (правка «с текущей даты»), больше не платит
        if (t.endDate && typeof getNextOccurrenceDate === 'function') {
            const next = getNextOccurrenceDate(t, today);
            const nextStr = next
                ? next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0') + '-' + String(next.getDate()).padStart(2, '0')
                : null;
            if (nextStr && nextStr > t.endDate) continue;
        }
        // раз в 2 недели = 26 выплат в год → в пересчёте на месяц ×26/12
        amount += t.period === 'biweekly' ? (+t.amount || 0) * 26 / 12 : (+t.amount || 0);
        count++;
    }
    return { amount, count };
}

// Экспорт для проверки в консоли и для dashboard.js
if (typeof window !== 'undefined') {
    window.computeForecast = computeForecast;
    window.effectiveYield = effectiveYield;
    window.monthlyInvestmentFromCalendar = monthlyInvestmentFromCalendar;
}
