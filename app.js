// ==================== State ====================
let transactions = [];
let categories = [];
let currentDate = new Date();
let selectedDate = null;
let occurrences = []; // Фактические occurrence'ы из бекапа
let previousState = null; // Для отмены операций

// Переменные для свайпов
let touchStartX = 0;
let touchEndX = 0;

// Категории по умолчанию
const defaultCategories = [
    { name: 'Зарплата', type: 'inc', color: '#4CAF50' },
    { name: 'Дом', type: 'exp', color: '#FF9800' },
    { name: 'ЖКХ и Услуги', type: 'exp', color: '#66A3FF' },
    { name: 'Развлечения', type: 'exp', color: '#E91E63' },
    { name: 'Транспорт', type: 'exp', color: '#2196F3' },
    { name: 'Машина', type: 'exp', color: '#607D8B' },
    { name: 'Одежда', type: 'exp', color: '#9C27B0' },
    { name: 'Образование', type: 'exp', color: '#3F51B5' },
    { name: 'Путешествия', type: 'exp', color: '#2ABBF4' },
    { name: 'Кредит', type: 'exp', color: '#F44336' },
    { name: 'Подарки', type: 'exp', color: '#E91E63' },
    { name: 'Инвестиции', type: 'exp', color: '#8BC34A' },
    { name: 'Рестораны и кафе', type: 'exp', color: '#FF5722' }
];

// Конфиг инвестиций: как деньги из категории «Инвестиции» распределяются по брокерам
// и с какими параметрами строится прогноз (редактируется на дашборде, хранится в data.json)
let investmentConfig = null;
const defaultInvestmentConfig = {
    categoryName: 'Инвестиции',
    split: { tinkoff: 50, finam: 50 },        // % пополнений на каждый счёт
    yieldOverrides: { tinkoff: null, finam: null }, // % годовых вручную; null = из данных брокера
    defaultAnnualYieldPct: 12,
    horizonYears: 20,
    customMonthlyAmount: null,                // null = авто из monthly-транзакций «Инвестиции»
    inflationPct: null,                       // предполагаемая инфляция, %/год; null = 14.5 по умолчанию
    goal: { monthlyTarget: null, endYear: null } // цель по пассивному доходу, ₽/мес; null = не задана
};

function mergeInvestmentConfig(loaded) {
    const cfg = Object.assign({}, defaultInvestmentConfig, loaded || {});
    cfg.split = Object.assign({}, defaultInvestmentConfig.split, (loaded && loaded.split) || {});
    cfg.yieldOverrides = Object.assign({}, defaultInvestmentConfig.yieldOverrides, (loaded && loaded.yieldOverrides) || {});
    cfg.goal = Object.assign({}, defaultInvestmentConfig.goal, (loaded && loaded.goal) || {});
    return cfg;
}

// ==================== Initialization ====================
document.addEventListener('DOMContentLoaded', async () => {
    await loadFromServer();
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
    updateCategorySelect();
    renderCategoriesList();
    
    // Инициализация свайпов для календаря
    initCalendarSwipe();

    // Сег-переключатели модалок, свотчи цветов, режим «скрыть суммы»
    initSegControls();
    initStealth();

    // Дашборд подписан на это событие: конфиг инвестиций и календарь загружены
    document.dispatchEvent(new CustomEvent('wallet:data-loaded'));
});

// ==================== Swipe Support ====================
function initCalendarSwipe() {
    const calendarSection = document.querySelector('.calendar-section');
    if (!calendarSection) return;
    
    calendarSection.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });
    
    calendarSection.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });
}

function handleSwipe() {
    const swipeThreshold = 50;
    const diff = touchStartX - touchEndX;
    
    if (Math.abs(diff) < swipeThreshold) return;
    
    if (diff > 0) {
        // Свайп влево - следующий месяц
        nextMonth();
    } else {
        // Свайп вправо - предыдущий месяц
        previousMonth();
    }
}

// ==================== Server Sync ====================
async function loadFromServer() {
    try {
        const response = await fetch('api.php', { credentials: 'same-origin' });
        if (response.status === 401) {
            // Требуется вход (пароль в settings.json): покажем оверлей, данные не трогаем
            if (window.WalletAuth) WalletAuth.show();
            return;
        }
        const result = await response.json();

        if (result.success && result.data) {
            transactions = result.data.transactions || [];
            categories = result.data.categories || [];
            occurrences = result.data.occurrences || [];
            investmentConfig = mergeInvestmentConfig(result.data.investmentConfig);

            // Если категорий нет, инициализируем по умолчанию
            if (categories.length === 0) {
                initDefaultCategories();
            }

            console.log('Данные загружены с сервера:', {
                transactions: transactions.length,
                categories: categories.length,
                occurrences: occurrences.length
            });

            // Сохраняем в localStorage как кэш
            saveToLocalStorage();
        } else {
            // Ошибка или нет данных - начинаем с чистых данных и категориями по умолчанию
            console.warn('Не удалось загрузить данные с сервера, начинаем с чистых данных');
            transactions = [];
            categories = [];
            occurrences = [];
            initDefaultCategories();
        }
    } catch (error) {
        console.error('Ошибка подключения к серверу:', error);
        // При ошибке начинаем с чистых данных и категориями по умолчанию
        transactions = [];
        categories = [];
        occurrences = [];
        initDefaultCategories();
    }
}

function loadFromLocalStorage() {
    const saved = localStorage.getItem('financialCalendar');
    if (saved) {
        const data = JSON.parse(saved);
        transactions = data.transactions || [];
        categories = data.categories || [];
        occurrences = data.occurrences || [];
        
        // Если категорий нет, инициализируем по умолчанию
        if (categories.length === 0) {
            initDefaultCategories();
        }
    } else {
        // Нет данных в localStorage - инициализируем категории
        initDefaultCategories();
    }
}

function saveToLocalStorage() {
    localStorage.setItem('financialCalendar', JSON.stringify({
        transactions,
        categories,
        occurrences,
        investmentConfig
    }));
}

async function saveToServer() {
    try {
        const response = await fetch('api.php', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                transactions,
                categories,
                occurrences,
                investmentConfig
            })
        });

        if (response.status === 401) {
            // Сессия истекла: покажем вход, данные сохраняем локально до входа
            if (window.WalletAuth) WalletAuth.show('Сессия истекла — войдите заново');
            saveToLocalStorage();
            return false;
        }
        const result = await response.json();

        if (result.success) {
            saveToLocalStorage();
            return true;
        } else {
            console.error('Ошибка сохранения данных:', result.error);
            saveToLocalStorage();
            return false;
        }
    } catch (error) {
        console.error('Ошибка подключения к серверу:', error);
        saveToLocalStorage();
        return false;
    }
}

// Явное сохранение по кнопке
function saveDataToServer() {
    saveToServer().then(success => {
        if (success) {
            alert('Данные успешно сохранены на сервере');
        } else {
            alert('Данные сохранены локально (ошибка соединения с сервером)');
        }
    });
}

// ==================== Data Management ====================
function saveData() {
    saveToLocalStorage();
    saveToServer();
}

// Сохранение состояния перед изменениями
function savePreviousState() {
    previousState = {
        transactions: JSON.parse(JSON.stringify(transactions)),
        categories: JSON.parse(JSON.stringify(categories)),
        occurrences: JSON.parse(JSON.stringify(occurrences))
    };
}

// Отмена последней операции
function undoLastOperation() {
    if (!previousState) {
        alert('Нечего отменять');
        return;
    }
    
    transactions = previousState.transactions;
    categories = previousState.categories;
    occurrences = previousState.occurrences;
    previousState = null;
    
    saveData();
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
    renderCategoriesList();
    updateCategorySelect();
    
    alert('Последняя операция отменена');
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Инициализация категорий по умолчанию
function initDefaultCategories() {
    categories = defaultCategories.map(cat => ({
        id: generateId(),
        name: cat.name,
        type: cat.type,
        color: cat.color,
        index: categories.length,
        icon: cat.type === 'inc' ? 10 : 20,
        uid: generateId()
    }));
    saveToLocalStorage();
    saveToServer();
}

// ==================== Calendar Rendering ====================
function renderCalendar() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    // Update month display
    const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
                       'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    document.getElementById('currentMonth').textContent = `${monthNames[month]} ${year}`;
    
    // Get first day of month and total days
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const totalDays = lastDay.getDate();
    
    // Adjust for Monday start (0 = Sunday in JS, we want Monday = 0)
    let startDay = firstDay.getDay() - 1;
    if (startDay === -1) startDay = 6;
    
    // Get previous month's last days
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    
    const calendarDays = document.getElementById('calendarDays');
    calendarDays.innerHTML = '';
    
    const today = new Date();
    
    // Previous month days
    for (let i = startDay - 1; i >= 0; i--) {
        const day = prevMonthLastDay - i;
        const date = new Date(year, month - 1, day);
        calendarDays.appendChild(createDayCell(date, true));
    }
    
    // Current month days
    for (let day = 1; day <= totalDays; day++) {
        const date = new Date(year, month, day);
        const isToday = date.toDateString() === today.toDateString();
        calendarDays.appendChild(createDayCell(date, false, isToday));
    }
    
    // Next month days
    const totalCells = startDay + totalDays;
    const nextMonthDays = 42 - totalCells; // 6 rows * 7 days = 42
    for (let day = 1; day <= nextMonthDays; day++) {
        const date = new Date(year, month + 1, day);
        calendarDays.appendChild(createDayCell(date, true));
    }
}

function createDayCell(date, isOtherMonth, isToday = false) {
    const cell = document.createElement('div');
    cell.className = `day-cell${isOtherMonth ? ' other-month' : ''}${isToday ? ' today' : ''}`;
    cell.onclick = () => openDayModal(date);

    const cumulativeBalance = getCumulativeBalance(date);
    const balanceClass = cumulativeBalance >= 0 ? 'positive' : 'negative';
    const dayTransactions = getDayTransactions(date);

    let transactionsHtml = '';
    dayTransactions.slice(0, 3).forEach(t => {
        const typeClass = t.type === 'income' ? 'income' : 'expense';
        const sign = t.type === 'income' ? '+' : '-';
        transactionsHtml += `<div class="day-transaction ${typeClass}">${sign}${Math.abs(t.amount).toLocaleString()} ₽</div>`;
    });
    if (dayTransactions.length > 3) {
        transactionsHtml += `<div style="color: #888; font-size: 0.7rem;">+${dayTransactions.length - 3} ещё</div>`;
    }

    cell.innerHTML = `
        <div class="day-number">${date.getDate()}</div>
        <div class="day-balance ${balanceClass}">${cumulativeBalance.toLocaleString()} ₽</div>
        <div class="day-transactions">${transactionsHtml}</div>
    `;

    return cell;
}

function previousMonth() {
    currentDate.setMonth(currentDate.getMonth() - 1);
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
}

function nextMonth() {
    currentDate.setMonth(currentDate.getMonth() + 1);
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
}

function goToToday() {
    const today = new Date();
    currentDate = new Date(today.getFullYear(), today.getMonth(), 1);
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
}

// ==================== Transaction Calculations ====================
function getDayTransactions(date) {
    const dateStr = formatDate(date);
    const dayTransactions = [];
    
    const hasOccurrences = occurrences.length > 0;
    
    if (hasOccurrences) {
        const sortedOccurrences = [...occurrences].sort((a, b) => new Date(a.date) - new Date(b.date));
        const lastOccurrenceDate = sortedOccurrences[sortedOccurrences.length - 1].date;
        
        // Если дата в пределах occurrence'ов - используем их
        if (dateStr <= lastOccurrenceDate) {
            occurrences.forEach(occ => {
                if (occ.date === dateStr) {
                    const transaction = transactions.find(t => t.id === occ.transactionId);
                    dayTransactions.push({
                        id: occ.transactionId,
                        type: occ.type,
                        amount: occ.amount,
                        name: transaction ? transaction.name : 'Операция',
                        note: transaction ? transaction.note : null,
                        category: transaction ? transaction.category : null
                    });
                }
            });
            
            // Добавляем новые периодические операции (не из импорта)
            transactions.forEach(t => {
                if (t.period !== 'once' && isTransactionActiveOnDate(t, date)) {
                    const existsInOccurrences = occurrences.some(occ => 
                        occ.transactionId === t.id && occ.date === dateStr
                    );
                    if (!existsInOccurrences) {
                        dayTransactions.push({
                            ...t,
                            amount: t.amount
                        });
                    }
                }
            });
            
            return dayTransactions;
        }
        
        // Для будущих дат генерируем из периодических операций
        transactions.forEach(t => {
            if (t.period !== 'once') {
                const startDate = parseLocalDate(t.date);
                const endDate = t.endDate ? parseLocalDate(t.endDate) : null;

                let current = getNextOccurrenceDate(t, parseLocalDate(lastOccurrenceDate));
                while (current <= (endDate || new Date(2100, 0, 1))) {
                    if (formatDate(current) === dateStr) {
                        dayTransactions.push({
                            ...t,
                            amount: t.amount
                        });
                    }
                    current = getNextOccurrenceDate(t, current);
                }
            } else if (t.date === dateStr) {
                // Однократные операции
                dayTransactions.push({
                    ...t,
                    amount: t.amount
                });
            }
        });
        return dayTransactions;
    }
    
    // Нет occurrence'ов - генерируем по периоду (для новых операций)
    transactions.forEach(t => {
        if (isTransactionActiveOnDate(t, date)) {
            dayTransactions.push({
                ...t,
                amount: getTransactionAmountForDate(t, date)
            });
        }
    });
    
    return dayTransactions.sort((a, b) => b.amount - a.amount);
}

function isTransactionActiveOnDate(transaction, date) {
    const startDate = parseLocalDate(transaction.date);
    const endDate = transaction.endDate ? parseLocalDate(transaction.endDate) : null;

    if (date < startDate) return false;
    if (endDate && date > endDate) return false;

    if (transaction.period === 'once') {
        return formatDate(date) === formatDate(startDate);
    }

    if (transaction.period === 'daily') {
        return true;
    }

    if (transaction.period === 'weekly' || transaction.period === 'biweekly') {
        const stepDays = transaction.period === 'biweekly' ? 14 : 7;
        const daysDiff = Math.floor((date - startDate) / (1000 * 60 * 60 * 24));
        return daysDiff % stepDays === 0;
    }

    if (transaction.period === 'monthly') {
        return date.getDate() === startDate.getDate();
    }

    if (transaction.period === 'yearly') {
        return date.getDate() === startDate.getDate() &&
               date.getMonth() === startDate.getMonth();
    }

    return false;
}

function parseLocalDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split('-');
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

function getTransactionAmountForDate(transaction, date) {
    // For most periods, amount is constant
    // Could be extended for variable amounts
    return transaction.amount;
}

function getDayBalance(date) {
    const dayTransactions = getDayTransactions(date);
    return dayTransactions.reduce((sum, t) => {
        return t.type === 'income' ? sum + t.amount : sum - t.amount;
    }, 0);
}

function getCumulativeBalance(date) {
    const targetDate = new Date(date);
    targetDate.setHours(23, 59, 59, 999);

    let balance = 0;

    // Считаем по occurrence'ам (фактические данные из импорта)
    const sortedOccurrences = [...occurrences].sort((a, b) => parseLocalDate(a.date) - parseLocalDate(b.date));

    sortedOccurrences.forEach(occ => {
        const occDate = parseLocalDate(occ.date);
        if (occDate <= targetDate) {
            if (occ.type === 'income') {
                balance += occ.amount;
            } else {
                balance -= occ.amount;
            }
        }
    });

    // Для будущих дат (после последнего occurrence) добавляем периодические операции
    const lastOccurrenceDate = sortedOccurrences.length > 0
        ? parseLocalDate(sortedOccurrences[sortedOccurrences.length - 1].date)
        : null;

    if (lastOccurrenceDate && targetDate > lastOccurrenceDate) {
        // Есть occurrence'ы, добавляем периодические операции после последней даты
        transactions.forEach(t => {
            if (t.period !== 'once') {
                const startDate = parseLocalDate(t.date);
                const endDate = t.endDate ? parseLocalDate(t.endDate) : null;

                // Генерируем occurrence'ы после последней фактической даты
                let current = getNextOccurrenceDate(t, lastOccurrenceDate);

                while (current <= targetDate && (!endDate || current <= endDate)) {
                    if (current > lastOccurrenceDate) {
                        if (t.type === 'income') {
                            balance += t.amount;
                        } else {
                            balance -= t.amount;
                        }
                    }

                    current = getNextOccurrenceDate(t, current);
                }
            } else {
                // Однократные операции в будущем
                const tDate = parseLocalDate(t.date);
                if (tDate > lastOccurrenceDate && tDate <= targetDate) {
                    if (t.type === 'income') {
                        balance += t.amount;
                    } else {
                        balance -= t.amount;
                    }
                }
            }
        });
    } else if (!lastOccurrenceDate) {
        // Нет occurrence'ов вообще, считаем по периоду
        const allDates = [];
        transactions.forEach(t => {
            const startDate = parseLocalDate(t.date);
            const endDate = t.endDate ? parseLocalDate(t.endDate) : null;

            if (t.period === 'once') {
                if (startDate <= targetDate) {
                    allDates.push({date: new Date(startDate), transaction: t});
                }
            } else if (t.period === 'daily') {
                let current = new Date(startDate);
                while (current <= targetDate && (!endDate || current <= endDate)) {
                    allDates.push({date: new Date(current), transaction: t});
                    current.setDate(current.getDate() + 1);
                    if (allDates.length > 10000) break;
                }
            } else if (t.period === 'weekly') {
                let current = new Date(startDate);
                while (current <= targetDate && (!endDate || current <= endDate)) {
                    allDates.push({date: new Date(current), transaction: t});
                    current.setDate(current.getDate() + 7);
                }
            } else if (t.period === 'biweekly') {
                let current = new Date(startDate);
                while (current <= targetDate && (!endDate || current <= endDate)) {
                    allDates.push({date: new Date(current), transaction: t});
                    current.setDate(current.getDate() + 14);
                }
            } else if (t.period === 'monthly') {
                let current = new Date(startDate);
                while (current <= targetDate && (!endDate || current <= endDate)) {
                    allDates.push({date: new Date(current), transaction: t});
                    current.setMonth(current.getMonth() + 1);
                }
            } else if (t.period === 'yearly') {
                let current = new Date(startDate);
                while (current <= targetDate && (!endDate || current <= endDate)) {
                    allDates.push({date: new Date(current), transaction: t});
                    current.setFullYear(current.getFullYear() + 1);
                }
            }
        });

        allDates.sort((a, b) => a.date - b.date);

        const processed = new Set();
        allDates.forEach(item => {
            const key = item.transaction.id + '-' + item.date.toDateString();
            if (!processed.has(key)) {
                processed.add(key);
                if (item.transaction.type === 'income') {
                    balance += item.transaction.amount;
                } else {
                    balance -= item.transaction.amount;
                }
            }
        });
    }
    
    return balance;
}

function getNextOccurrenceDate(transaction, afterDate) {
    const startDate = parseLocalDate(transaction.date);
    const after = parseLocalDate(afterDate);

    if (transaction.period === 'daily') {
        return new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1);
    }

    if (transaction.period === 'weekly') {
        const daysSinceStart = Math.floor((after - startDate) / (1000 * 60 * 60 * 24));
        const nextWeek = Math.ceil((daysSinceStart + 1) / 7) * 7;
        return new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + nextWeek);
    }

    if (transaction.period === 'biweekly') {
        const daysSinceStart = Math.floor((after - startDate) / (1000 * 60 * 60 * 24));
        const next = Math.ceil((daysSinceStart + 1) / 14) * 14;
        return new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + next);
    }

    if (transaction.period === 'monthly') {
        let monthsSinceStart = (after.getFullYear() - startDate.getFullYear()) * 12 + (after.getMonth() - startDate.getMonth());
        // если «день серии» в текущем месяце ещё впереди — ближайшее вхождение в этом же месяце
        if (after.getDate() < startDate.getDate()) monthsSinceStart -= 1;
        const nextMonth = monthsSinceStart + 1;
        const year = startDate.getFullYear() + Math.floor(nextMonth / 12);
        const month = startDate.getMonth() + (nextMonth % 12);
        const day = Math.min(startDate.getDate(), new Date(year, month + 1, 0).getDate());
        return new Date(year, month, day);
    }

    if (transaction.period === 'yearly') {
        let yearsSinceStart = after.getFullYear() - startDate.getFullYear();
        // если дата серии в текущем году ещё впереди — ближайшее вхождение в этом же году
        if (after.getMonth() < startDate.getMonth() ||
            (after.getMonth() === startDate.getMonth() && after.getDate() < startDate.getDate())) yearsSinceStart -= 1;
        const nextYear = yearsSinceStart + 1;
        const year = startDate.getFullYear() + nextYear;
        const month = startDate.getMonth();
        const day = Math.min(startDate.getDate(), new Date(year, month + 1, 0).getDate());
        return new Date(year, month, day);
    }

    return new Date(startDate);
}

function getMonthBalance() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    let income = 0;
    let expense = 0;
    
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0);
    
    const hasOccurrences = occurrences.length > 0;

    if (hasOccurrences) {
        const sortedOccurrences = [...occurrences].sort((a, b) => parseLocalDate(a.date) - parseLocalDate(b.date));
        const lastOccurrenceDate = sortedOccurrences.length > 0
            ? parseLocalDate(sortedOccurrences[sortedOccurrences.length - 1].date)
            : null;

        // Считаем occurrence'ы за этот месяц
        sortedOccurrences.forEach(occ => {
            const occDate = parseLocalDate(occ.date);
            if (occDate.getFullYear() === year && occDate.getMonth() === month) {
                if (occ.type === 'income') {
                    income += occ.amount;
                } else {
                    expense += occ.amount;
                }
            }
        });

        // Добавляем периодические операции для будущих дат
        if (lastOccurrenceDate && monthEnd > lastOccurrenceDate) {
            transactions.forEach(t => {
                if (t.period !== 'once') {
                    const startDate = parseLocalDate(t.date);
                    const endDate = t.endDate ? parseLocalDate(t.endDate) : null;

                    let current = getNextOccurrenceDate(t, lastOccurrenceDate);
                    while (current <= (endDate || new Date(2100, 0, 1))) {
                        if (current > lastOccurrenceDate && current >= monthStart && current <= monthEnd) {
                            if (t.type === 'income') {
                                income += t.amount;
                            } else {
                                expense += t.amount;
                            }
                        }
                        current = getNextOccurrenceDate(t, current);
                    }
                } else {
                    const tDate = parseLocalDate(t.date);
                    if (tDate > lastOccurrenceDate && tDate >= monthStart && tDate <= monthEnd) {
                        if (t.type === 'income') {
                            income += t.amount;
                        } else {
                            expense += t.amount;
                        }
                    }
                }
            });
        }
    } else {
        // Нет occurrence'ов - генерируем по периоду
        const daysInMonth = monthEnd.getDate();
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(year, month, day);
            const dayTransactions = getDayTransactions(date);
            
            dayTransactions.forEach(t => {
                if (t.type === 'income') {
                    income += t.amount;
                } else {
                    expense += Math.abs(t.amount);
                }
            });
        }
    }
    
    return { income, expense, balance: income - expense };
}

// ==================== Balance Summary ====================
function updateBalanceSummary() {
    const { income, expense, balance } = getMonthBalance();
    const todayBalance = getCumulativeBalance(new Date());

    document.getElementById('monthIncome').textContent = `+${income.toLocaleString()} ₽`;
    document.getElementById('monthExpense').textContent = `-${expense.toLocaleString()} ₽`;

    const balanceEl = document.getElementById('monthBalance');
    balanceEl.textContent = `${balance >= 0 ? '+' : ''}${balance.toLocaleString()} ₽`;
    balanceEl.className = `balance-value ${balance >= 0 ? 'income' : 'expense'}`;

    // Update header balance - баланс на текущий день
    const headerBalanceEl = document.getElementById('headerBalance');
    headerBalanceEl.textContent = `${todayBalance.toLocaleString()} ₽`;
}

// ==================== Transactions List ====================
function renderTransactionsList() {
    const container = document.getElementById('transactionsList');
    
    // Используем выбранный месяц из currentDate
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0);
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Собираем предстоящие транзакции за выбранный месяц
    const upcomingTransactions = [];
    
    for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
        // Показываем только будущие транзакции
        if (d < today) continue;
        
        const dayTrans = getDayTransactions(new Date(d));
        dayTrans.forEach(t => {
            upcomingTransactions.push({
                ...t,
                displayDate: new Date(d)
            });
        });
    }
    
    // Удаляем дубликаты и сортируем по дате
    const seen = new Set();
    const unique = upcomingTransactions.filter(t => {
        const key = `${t.id}-${t.displayDate.toISOString()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    
    const sorted = unique.sort((a, b) => a.displayDate - b.displayDate).slice(0, 30);

    if (sorted.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: #888; padding: 20px;">Нет предстоящих операций</div>';
        return;
    }

    container.innerHTML = sorted.map(t => {
        const amountClass = t.type === 'income' ? 'income' : 'expense';
        const sign = t.type === 'income' ? '+' : '-';
        const category = getCategoryById(t.category);
        const categoryBadge = category
            ? `<span class="transaction-category-badge" style="background: ${category.color}20; color: ${category.color}; border: 1px solid ${category.color}">${escapeHtml(category.name)}</span>`
            : '';
        
        const dateStr = t.displayDate.toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'short'
        });

        return `
            <div class="transaction-item">
                <div class="transaction-info">
                    <div class="transaction-name">${escapeHtml(t.name)} ${categoryBadge}</div>
                    <div class="transaction-meta">
                        📅 ${dateStr}
                    </div>
                </div>
                <div class="transaction-amount ${amountClass}">
                    ${sign}${Math.abs(t.amount).toLocaleString()} ₽
                </div>
            </div>
        `;
    }).join('');
}

// ==================== Modal Functions ====================
// ==================== Segmented controls / swatches ====================
// Синхронизируют кнопку-«сег» со скрытым input: у формы остаётся контракт .value
function syncSeg(segId, value) {
    const seg = document.getElementById(segId);
    if (!seg) return;
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === value));
}

function wireSeg(segId, inputId, onChange) {
    const seg = document.getElementById(segId);
    const input = document.getElementById(inputId);
    if (!seg || !input) return;
    seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-value]');
        if (!btn) return;
        input.value = btn.dataset.value;
        syncSeg(segId, input.value);
        if (onChange) onChange();
    });
}

// Палитра свотчей категорий — валидированный Taiga-категориальный набор + зелёный дефолт
const CATEGORY_SWATCHES = ['#8BC34A', '#428BF9', '#F59200', '#D08FFF', '#00A328', '#FF7A91', '#2ABBF4', '#FF6347'];

function renderSwatches(activeColor) {
    const box = document.getElementById('categoryColorSwatches');
    const input = document.getElementById('categoryColor');
    if (!box || !input) return;
    const current = (activeColor || input.value || CATEGORY_SWATCHES[0]).toUpperCase();
    box.innerHTML = '';
    CATEGORY_SWATCHES.forEach(hex => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch' + (hex.toUpperCase() === current ? ' active' : '');
        b.style.background = hex;
        b.title = hex;
        b.setAttribute('aria-label', 'Цвет ' + hex);
        b.addEventListener('click', () => {
            input.value = hex;
            renderSwatches(hex);
        });
        box.appendChild(b);
    });
}

function initSegControls() {
    wireSeg('transactionTypeSeg', 'transactionType', () => updateCategorySelectByType());
    wireSeg('transactionPeriodSeg', 'transactionPeriod', () => { togglePeriodInfo(); updateScopeVisibility(); });
    wireSeg('transactionScopeSeg', 'transactionScope', () => updateScopeInfo());
    wireSeg('categoryTypeSeg', 'categoryType', null);
}

// ==================== Stealth mode (скрыть суммы) ====================
function initStealth() {
    const btn = document.getElementById('stealthBtn');
    if (!btn) return;
    const apply = (on) => {
        document.body.classList.toggle('stealth', on);
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
        btn.title = on ? 'Показать суммы' : 'Скрыть суммы';
    };
    apply(localStorage.getItem('wallet-stealth') === '1');
    btn.addEventListener('click', () => {
        const on = !document.body.classList.contains('stealth');
        apply(on);
        localStorage.setItem('wallet-stealth', on ? '1' : '0');
    });
}

function openTransactionModal(date = null) {
    document.getElementById('transactionForm').reset();
    document.getElementById('transactionId').value = '';
    document.getElementById('modalTitle').textContent = 'Добавить операцию';
    document.getElementById('transactionDate').value = date ? formatDate(date) : formatDate(new Date());
    document.getElementById('periodInfo').textContent = '';
    // reset() возвращает скрытым input их value-атрибуты; сеги синхронизируем вручную
    syncSeg('transactionTypeSeg', document.getElementById('transactionType').value);
    syncSeg('transactionPeriodSeg', document.getElementById('transactionPeriod').value);
    document.getElementById('transactionDeleteBtn').hidden = true;
    document.getElementById('transactionScopeGroup').hidden = true;
    document.getElementById('scopeInfo').textContent = '';
    syncSeg('transactionScopeSeg', document.getElementById('transactionScope').value);

    updateCategorySelectByType();

    document.getElementById('transactionModal').classList.add('active');
}

function closeTransactionModal() {
    document.getElementById('transactionModal').classList.remove('active');
}

function openDayModal(date) {
    selectedDate = date;
    const dateStr = date.toLocaleDateString('ru-RU', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    
    document.getElementById('dayModalTitle').textContent = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
    
    const dayTransactions = getDayTransactions(date);
    const cumulativeBalance = getCumulativeBalance(date);
    
    let content = `
        <div class="dm-balance-card${cumulativeBalance < 0 ? ' neg' : ''}">
            <div class="dm-balance-label">Баланс на конец дня</div>
            <div class="dm-balance-value">${cumulativeBalance.toLocaleString()} ₽</div>
        </div>
    `;

    if (dayTransactions.length === 0) {
        content += '<div class="dm-empty">Нет операций</div>';
    } else {
        content += '<div class="transactions-list">';
        dayTransactions.forEach(t => {
            const amountClass = t.type === 'income' ? 'income' : 'expense';
            const sign = t.type === 'income' ? '+' : '-';
            const category = getCategoryById(t.category);
            const categoryBadge = category
                ? `<span class="cat-badge" style="background: ${category.color}20; color: ${category.color};">${escapeHtml(category.name)}</span>`
                : '';
            content += `
                <div class="transaction-item">
                    <div class="transaction-info">
                        <div class="transaction-name">${escapeHtml(t.name)} ${categoryBadge}</div>
                        <div class="transaction-meta">${t.note ? escapeHtml(t.note) : ''}</div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div class="transaction-amount ${amountClass}">
                            ${sign}${Math.abs(t.amount).toLocaleString()} ₽
                        </div>
                        <div class="transaction-actions">
                            <button onclick="editTransaction('${t.id}')" title="Редактировать">✏️</button>
                            <button onclick="deleteTransaction('${t.id}')" title="Удалить">🗑️</button>
                        </div>
                    </div>
                </div>
            `;
        });
        content += '</div>';
    }
    
    content += `
        <button class="btn btn-primary" onclick="closeDayModal(); openTransactionModal(selectedDate);" style="width: 100%; margin-top: 15px;">
            + Добавить операцию
        </button>
    `;
    
    document.getElementById('dayModalContent').innerHTML = content;
    document.getElementById('dayModal').classList.add('active');
}

function closeDayModal() {
    document.getElementById('dayModal').classList.remove('active');
}

// ==================== Form Handling ====================
function saveTransaction(event) {
    event.preventDefault();

    // Сохраняем состояние перед изменением
    savePreviousState();

    const id = document.getElementById('transactionId').value;
    const transaction = {
        id: id || generateId(),
        type: document.getElementById('transactionType').value,
        name: document.getElementById('transactionName').value,
        amount: parseFloat(document.getElementById('transactionAmount').value),
        date: document.getElementById('transactionDate').value,
        endDate: document.getElementById('transactionEndDate').value || null,
        period: document.getElementById('transactionPeriod').value,
        category: document.getElementById('transactionCategory').value || null,
        note: document.getElementById('transactionNote').value || null
    };

    if (id) {
        const index = transactions.findIndex(t => t.id === id);
        if (index !== -1) {
            const existing = transactions[index];
            const split = document.getElementById('transactionScope').value === 'future'
                ? seriesSplitPoint(existing) : null;
            if (split) {
                // «С текущей даты»: прошлое не меняем — старая серия заканчивается накануне разреза,
                // с точки разреза работает новая серия с параметрами из формы
                transactions[index] = Object.assign({}, existing, { endDate: split.prev });
                transactions.push(Object.assign({}, transaction, {
                    id: generateId(),
                    date: transaction.date > split.split ? transaction.date : split.split,
                    endDate: existing.endDate || null
                }));
            } else {
                transactions[index] = transaction;
            }
        }
    } else {
        transactions.push(transaction);
    }

    saveData();
    closeTransactionModal();

    // Всегда обновляем календарь и баланс после сохранения
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
    // Прогноз на вкладке «Портфель» должен увидеть новую сумму «Инвестиций»
    document.dispatchEvent(new CustomEvent('wallet:data-changed'));

    // Reopen day modal if we were editing from day view
    if (selectedDate) {
        setTimeout(() => openDayModal(selectedDate), 100);
    }
}

function editTransaction(id) {
    const transaction = transactions.find(t => t.id === id);
    if (!transaction) return;
    
    document.getElementById('transactionId').value = transaction.id;
    document.getElementById('transactionType').value = transaction.type;
    document.getElementById('transactionName').value = transaction.name;
    document.getElementById('transactionAmount').value = transaction.amount;
    document.getElementById('transactionDate').value = transaction.date;
    document.getElementById('transactionEndDate').value = transaction.endDate || '';
    document.getElementById('transactionPeriod').value = transaction.period;
    document.getElementById('transactionNote').value = transaction.note || '';
    syncSeg('transactionTypeSeg', transaction.type);
    syncSeg('transactionPeriodSeg', transaction.period);
    togglePeriodInfo();
    // по умолчанию правка серии не трогает прошлые записи
    document.getElementById('transactionScope').value = 'future';
    syncSeg('transactionScopeSeg', 'future');
    updateScopeVisibility();
    document.getElementById('transactionDeleteBtn').hidden = false;

    document.getElementById('modalTitle').textContent = 'Редактировать операцию';
    updateCategorySelectByType();
    // категорию выставляем после перестройки списка опций, иначе выбор сбрасывается
    document.getElementById('transactionCategory').value = transaction.category || '';
    
    // Close day modal if open
    document.getElementById('dayModal').classList.remove('active');
    document.getElementById('transactionModal').classList.add('active');
}

// Удаление прямо из открытой модалки редактирования
function deleteTransactionFromModal() {
    const id = document.getElementById('transactionId').value;
    if (!id) return;
    document.getElementById('transactionModal').classList.remove('active');
    deleteTransaction(id);
}

function deleteTransaction(id) {
    if (!confirm('Вы уверены, что хотите удалить эту операцию?')) return;

    // Сохраняем состояние перед удалением
    savePreviousState();

    transactions = transactions.filter(t => t.id !== id);

    // Also remove from occurrences if present
    occurrences = occurrences.filter(occ => occ.transactionId !== id);

    saveData();

    // Close day modal if open
    document.getElementById('dayModal').classList.remove('active');

    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
    document.dispatchEvent(new CustomEvent('wallet:data-changed'));
}

function togglePeriodInfo() {
    const period = document.getElementById('transactionPeriod').value;
    const infoEl = document.getElementById('periodInfo');
    
    const info = {
        once: '',
        daily: 'Будет повторяться каждый день',
        weekly: 'Будет повторяться раз в неделю',
        biweekly: 'Будет повторяться раз в 2 недели',
        monthly: 'Будет повторяться каждый месяц в эту дату',
        yearly: 'Будет повторяться каждый год в эту дату'
    };
    
    infoEl.textContent = info[period];
}

// Точка разреза серии для правки «с текущей даты»: первое будущее вхождение и день перед ним.
// null — править серию целиком (однократная, ещё не началась, уже закончилась или вхождений впереди нет).
function seriesSplitPoint(transaction) {
    if (!transaction || transaction.period === 'once') return null;
    const today = new Date();
    const todayStr = formatDate(today);
    if (transaction.date >= todayStr) return null;
    if (transaction.endDate && transaction.endDate <= todayStr) return null;
    const splitDate = isTransactionActiveOnDate(transaction, today) ? today : getNextOccurrenceDate(transaction, todayStr);
    if (!splitDate) return null;
    const splitStr = formatDate(splitDate);
    if (transaction.endDate && transaction.endDate < splitStr) return null;
    const prev = parseLocalDate(splitStr);
    return { split: splitStr, prev: formatDate(new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() - 1)) };
}

// Сег «Применить изменения» виден только при редактировании повторяющейся операции
function updateScopeVisibility() {
    const group = document.getElementById('transactionScopeGroup');
    if (!group) return;
    const editing = document.getElementById('transactionId').value !== '';
    const recurring = document.getElementById('transactionPeriod').value !== 'once';
    group.hidden = !(editing && recurring);
    updateScopeInfo();
}

function updateScopeInfo() {
    const infoEl = document.getElementById('scopeInfo');
    if (!infoEl) return;
    if (document.getElementById('transactionScope').value !== 'future') {
        infoEl.textContent = '';
        return;
    }
    const t = transactions.find(x => x.id === document.getElementById('transactionId').value);
    const split = t ? seriesSplitPoint(t) : null;
    infoEl.textContent = split
        ? 'Записи до ' + formatDDMMYYYY(split.split) + ' — с прежней суммой, с ' + formatDDMMYYYY(split.split) + ' — новая'
        : 'Прошлых записей нет — изменения применятся ко всей серии';
}

function formatDDMMYYYY(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
}

function generateOccurrences(transaction) {
    const occurrences = [];
    const startDate = new Date(transaction.date);
    const endDate = transaction.endDate ? new Date(transaction.endDate) : null;
    
    if (transaction.period === 'once') {
        occurrences.push({
            date: formatDDMMYYYY(transaction.date),
            amount: transaction.type === 'income' ? transaction.amount : -transaction.amount,
            active: true
        });
        return occurrences;
    }
    
    // Generate occurrences up to 12 instances or until end date
    let currentDate = new Date(startDate);
    let count = 0;
    const maxOccurrences = 12;
    
    while (count < maxOccurrences) {
        if (endDate && currentDate > endDate) break;
        
        const dateStr = formatDDMMYYYY(currentDate);
        const amount = transaction.type === 'income' ? transaction.amount : -transaction.amount;
        
        occurrences.push({
            date: dateStr,
            amount: amount,
            active: true
        });
        
        count++;
        
        // Move to next occurrence based on period
        switch (transaction.period) {
            case 'daily':
                currentDate.setDate(currentDate.getDate() + 1);
                break;
            case 'weekly':
                currentDate.setDate(currentDate.getDate() + 7);
                break;
            case 'monthly':
                currentDate.setMonth(currentDate.getMonth() + 1);
                break;
            case 'yearly':
                currentDate.setFullYear(currentDate.getFullYear() + 1);
                break;
        }
        
        // Handle invalid dates (e.g., 31st in months with 30 days)
        if (currentDate.getDate() !== startDate.getDate() && transaction.period !== 'daily') {
            currentDate.setDate(0); // Set to last day of previous month
        }
    }
    
    return occurrences;
}

// ==================== Utilities ====================
function formatDate(date) {
    if (!date) return '';
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDateDisplay(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString('ru-RU');
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateCategorySelect() {
    const select = document.getElementById('transactionCategory');
    const currentType = document.getElementById('transactionType')?.value || 'expense';
    
    // Map 'expense'/'income' to 'exp'/'inc'
    const typeMap = { 'expense': 'exp', 'income': 'inc' };
    const targetType = typeMap[currentType] || currentType;
    
    select.innerHTML = '<option value="">Без категории</option>';

    categories.filter(cat => cat.type === targetType).forEach(cat => {
        const option = document.createElement('option');
        option.value = cat.id;
        option.textContent = cat.name;
        select.appendChild(option);
    });
}

function updateCategorySelectByType() {
    updateCategorySelect();
}

// ==================== Categories Management ====================
function renderCategoriesList() {
    const container = document.getElementById('categoriesList');
    if (!container) return;

    if (categories.length === 0) {
        container.innerHTML = '<div class="cat-list-note">Нет категорий</div>';
        return;
    }

    const sorted = [...categories].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'inc' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    container.innerHTML = sorted.map(cat => `
        <div class="cat-row">
            <span class="cat-dot" style="background: ${cat.color}"></span>
            <span class="cat-name">${escapeHtml(cat.name)}</span>
            <span class="cat-type">${cat.type === 'inc' ? 'Доход' : 'Расход'}</span>
            <span class="cat-actions">
                <button onclick="editCategory('${cat.id}')" title="Редактировать">✏️</button>
                <button onclick="deleteCategory('${cat.id}')" title="Удалить">🗑️</button>
            </span>
        </div>
    `).join('');
}

function openCategoriesModal() {
    renderCategoriesList();
    document.getElementById('addCategoryForm').classList.add('hidden');
    document.getElementById('categoriesModal').classList.add('active');
}

function closeCategoriesModal() {
    document.getElementById('categoriesModal').classList.remove('active');
    document.getElementById('addCategoryForm').classList.add('hidden');
}

function openAddCategoryForm() {
    document.getElementById('editCategoryId').value = '';
    document.getElementById('categoryName').value = '';
    document.getElementById('categoryType').value = 'exp';
    document.getElementById('categoryColor').value = '#8BC34A';
    syncSeg('categoryTypeSeg', 'exp');
    renderSwatches('#8BC34A');
    document.getElementById('categoryFormTitle').textContent = 'Новая категория';
    document.getElementById('addCategoryForm').classList.remove('hidden');
}

function cancelCategoryForm() {
    document.getElementById('addCategoryForm').classList.add('hidden');
}

function editCategory(id) {
    const category = categories.find(c => c.id === id);
    if (!category) return;

    document.getElementById('editCategoryId').value = category.id;
    document.getElementById('categoryName').value = category.name;
    document.getElementById('categoryType').value = category.type;
    document.getElementById('categoryColor').value = category.color;
    syncSeg('categoryTypeSeg', category.type);
    renderSwatches(category.color);
    document.getElementById('categoryFormTitle').textContent = 'Редактировать категорию';
    document.getElementById('addCategoryForm').classList.remove('hidden');
}

function saveCategory() {
    const id = document.getElementById('editCategoryId').value;
    const name = document.getElementById('categoryName').value.trim();
    const type = document.getElementById('categoryType').value;
    const color = document.getElementById('categoryColor').value;

    if (!name) {
        alert('Введите название категории');
        return;
    }

    // Сохраняем состояние перед изменением
    savePreviousState();

    if (id) {
        // Edit existing
        const index = categories.findIndex(c => c.id === id);
        if (index !== -1) {
            categories[index] = {
                ...categories[index],
                name,
                type,
                color
            };
        }
    } else {
        // Add new
        categories.push({
            id: generateId(),
            name,
            type,
            color,
            index: categories.length,
            icon: type === 'inc' ? 10 : 20,
            uid: generateId()
        });
    }

    saveData();
    renderCategoriesList();
    updateCategorySelect();
    renderTransactionsList();
    cancelCategoryForm();
    document.dispatchEvent(new CustomEvent('wallet:data-changed'));
}

function deleteCategory(id) {
    if (!confirm('Удалить эту категорию? Операции останутся без категории.')) return;

    // Сохраняем состояние перед удалением
    savePreviousState();

    categories = categories.filter(c => c.id !== id);
    
    // Remove category from transactions
    transactions.forEach(t => {
        if (t.category === id) {
            t.category = null;
        }
    });
    
    saveData();
    renderCategoriesList();
    updateCategorySelect();
    renderTransactionsList();
    document.dispatchEvent(new CustomEvent('wallet:data-changed'));
}

function getCategoryById(id) {
    return categories.find(c => c.id === id);
}
