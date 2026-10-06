package ru.wallet.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Утреннее уведомление о платежах сегодняшнего дня.
 *
 * Логика «что происходит в этот день» — порт notify-today.php (txFiresOn +
 * dayItems), который сам является портом app.js: occurrences за дату плюс
 * периодические серии, не представленные в occurrences; для будущих дат —
 * генерация по периоду с «прищемлением» 31-го числа к концу месяца
 * (старт 31 января → 28 февраля → 31 марта → 30 апреля…).
 * При правке календарной логики в app.js правьте и этот файл.
 */
public class NotifyReceiver extends BroadcastReceiver {

    private static final String CHANNEL_ID = "wallet_daily";

    private static final String[] MONTHS_GENITIVE = {
            "января", "февраля", "марта", "апреля", "мая", "июня",
            "июля", "августа", "сентября", "октября", "ноября", "декабря"
    };

    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            JSONObject snap = AlarmScheduler.readSnapshot(ctx);

            // Сразу перепланируем следующий день — независимо от наличия платежей
            if (snap != null) {
                JSONObject settings = snap.optJSONObject("settings");
                JSONObject n = settings == null ? null : settings.optJSONObject("notifications");
                if (n != null && n.optBoolean("enabled", false)) {
                    AlarmScheduler.schedule(ctx, n.optInt("hour", 8), n.optInt("minute", 0));
                }
            }

            if (snap == null) return; // данных ещё нет — тихо
            JSONObject cal = snap.optJSONObject("calendar");
            if (cal == null) return;
            JSONArray transactions = cal.optJSONArray("transactions");
            JSONArray occurrences = cal.optJSONArray("occurrences");
            if (transactions == null) return;

            Calendar now = Calendar.getInstance();
            String dateStr = String.format(Locale.US, "%04d-%02d-%02d",
                    now.get(Calendar.YEAR), now.get(Calendar.MONTH) + 1, now.get(Calendar.DAY_OF_MONTH));

            List<Item> items = dayItems(transactions, occurrences != null ? occurrences : new JSONArray(), dateStr);
            if (items.isEmpty()) return; // пустой день — без уведомления

            int month = Integer.parseInt(dateStr.substring(5, 7));
            int day = Integer.parseInt(dateStr.substring(8, 10));
            String dateHuman = day + " " + MONTHS_GENITIVE[month - 1];

            StringBuilder sb = new StringBuilder();
            double total = 0;
            for (Item item : items) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(item.amount >= 0 ? "🟢 " : "🔴 ").append(item.name).append(": ").append(fmtAmount(item.amount));
                total += item.amount;
            }
            sb.append("\n\nИтог дня: ").append(fmtAmount(total));

            showNotification(ctx, "📅 Сегодня, " + dateHuman, sb.toString());
        } catch (Exception e) {
            // Уведомление некритично: тихо логируем в logcat и не роняем будильник
            android.util.Log.w("WalletNotify", "notification failed", e);
        }
    }

    // ==================== Уведомление ====================

    private void showNotification(Context ctx, String title, String message) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Платежи дня",
                    NotificationManager.IMPORTANCE_HIGH);
            nm.createNotificationChannel(ch);
            b = new Notification.Builder(ctx, CHANNEL_ID);
        } else {
            b = new Notification.Builder(ctx); // устаревший конструктор для API 24–25
            b.setPriority(Notification.PRIORITY_HIGH);
        }

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new Notification.BigTextStyle().bigText(message))
                .setContentIntent(pi)
                .setAutoCancel(true);

        nm.notify(1001, b.build());
    }

    // ==================== Что происходит в этот день (порт notify-today.php) ====================

    private static class Item {
        final String name;
        final double amount;

        Item(String name, double amount) {
            this.name = name;
            this.amount = amount;
        }
    }

    static List<Item> dayItems(JSONArray transactions, JSONArray occurrences, String dateStr) {
        List<Item> items = new ArrayList<>();

        // Знаковый размер: доход +, расход −
        // Имя берётся из серии, если вхождение ссылается на transactionId
        Map<String, JSONObject> byId = new HashMap<>();
        for (int i = 0; i < transactions.length(); i++) {
            JSONObject t = transactions.optJSONObject(i);
            if (t != null && !t.optString("id", "").isEmpty()) byId.put(t.optString("id"), t);
        }

        if (occurrences.length() > 0) {
            String lastOcc = "";
            for (int i = 0; i < occurrences.length(); i++) {
                JSONObject occ = occurrences.optJSONObject(i);
                if (occ != null) {
                    String d = occ.optString("date", "");
                    if (d.compareTo(lastOcc) > 0) lastOcc = d;
                }
            }

            if (dateStr.compareTo(lastOcc) <= 0) {
                // Фактические вхождения за дату + новые серии, не попавшие в occurrences
                for (int i = 0; i < occurrences.length(); i++) {
                    JSONObject occ = occurrences.optJSONObject(i);
                    if (occ != null && occ.optString("date", "").equals(dateStr)) {
                        push(items, byId, occ, occ.optDouble("amount", 0));
                    }
                }
                for (int i = 0; i < transactions.length(); i++) {
                    JSONObject t = transactions.optJSONObject(i);
                    if (t == null) continue;
                    if (t.optString("period", "once").equals("once") || !txFiresOn(t, dateStr, false)) continue;
                    boolean dup = false;
                    for (int j = 0; j < occurrences.length(); j++) {
                        JSONObject occ = occurrences.optJSONObject(j);
                        if (occ == null) continue;
                        if (occ.optString("transactionId", "").equals(t.optString("id", ""))
                                && occ.optString("date", "").equals(dateStr)) {
                            dup = true;
                            break;
                        }
                    }
                    if (!dup) push(items, byId, t, signed(t));
                }
            } else {
                // Будущая дата: генерация по периоду (+ однократные попаданием в дату)
                for (int i = 0; i < transactions.length(); i++) {
                    JSONObject t = transactions.optJSONObject(i);
                    if (t == null) continue;
                    if (!t.optString("period", "once").equals("once")) {
                        if (txFiresOn(t, dateStr, true)) push(items, byId, t, signed(t));
                    } else if (t.optString("date", "").equals(dateStr)) {
                        push(items, byId, t, signed(t));
                    }
                }
            }
        } else {
            // Совсем без occurrences — всё решает период
            for (int i = 0; i < transactions.length(); i++) {
                JSONObject t = transactions.optJSONObject(i);
                if (t != null && txFiresOn(t, dateStr, false)) push(items, byId, t, signed(t));
            }
        }

        items.sort(Comparator.comparingDouble((Item it) -> it.amount).reversed());
        return items;
    }

    private static void push(List<Item> items, Map<String, JSONObject> byId, JSONObject t, double amount) {
        String tid = t.optString("transactionId", "");
        String name;
        if (!tid.isEmpty()) {
            JSONObject src = byId.get(tid);
            name = src != null ? src.optString("name", "Операция") : "Операция";
        } else {
            name = t.optString("name", "Операция");
        }
        items.add(new Item(name, amount));
    }

    private static double signed(JSONObject t) {
        double a = t.optDouble("amount", 0);
        return t.optString("type", "expense").equals("income") ? a : -a;
    }

    /**
     * Активна ли серия в дату dateStr.
     * clamp=false — «жёсткое» совпадение дня (прошлые даты, как isTransactionActiveOnDate);
     * clamp=true — 31-е число прищемляется к последнему дню месяца (генерация будущих,
     * как getNextOccurrenceDate).
     */
    private static boolean txFiresOn(JSONObject t, String dateStr, boolean clamp) {
        String start = t.optString("date", "");
        if (start.isEmpty() || start.compareTo(dateStr) > 0) return false;
        String endDate = t.optString("endDate", "");
        if (!endDate.isEmpty() && endDate.compareTo(dateStr) < 0) return false;

        String period = t.optString("period", "once");
        if (period.equals("once")) return start.equals(dateStr);
        if (period.equals("daily")) return true;

        int y = Integer.parseInt(dateStr.substring(0, 4));
        int m = Integer.parseInt(dateStr.substring(5, 7));
        int d = Integer.parseInt(dateStr.substring(8, 10));
        int sm = Integer.parseInt(start.substring(5, 7));
        int sd = Integer.parseInt(start.substring(8, 10));

        if (period.equals("weekly") || period.equals("biweekly")) {
            int step = period.equals("biweekly") ? 14 : 7;
            long days = diffDays(start, dateStr);
            return days >= 0 && days % step == 0;
        }
        if (period.equals("monthly")) {
            return d == (clamp ? Math.min(sd, daysInMonth(y, m)) : sd);
        }
        if (period.equals("yearly")) {
            if (m != sm) return false;
            return d == (clamp ? Math.min(sd, daysInMonth(y, m)) : sd);
        }
        return false;
    }

    /** Разница в днях между двумя датами YYYY-MM-DD; −1 при кривой дате (серия не срабатывает). */
    private static long diffDays(String from, String to) {
        try {
            return (millisAt(to) - millisAt(from)) / 86400000L;
        } catch (Exception e) {
            return -1;
        }
    }

    private static long millisAt(String ymd) {
        Calendar c = Calendar.getInstance();
        c.clear();
        c.set(Integer.parseInt(ymd.substring(0, 4)),
                Integer.parseInt(ymd.substring(5, 7)) - 1,
                Integer.parseInt(ymd.substring(8, 10)));
        return c.getTimeInMillis();
    }

    private static int daysInMonth(int year, int month) {
        Calendar c = Calendar.getInstance();
        c.clear();
        c.set(year, month - 1, 1);
        return c.getActualMaximum(Calendar.DAY_OF_MONTH);
    }

    // ==================== Формат (паритет с notify-today.php) ====================

    private static String fmtAmount(double value) {
        return (value >= 0 ? "+" : "−") + thousandSep(Math.round(Math.abs(value))) + " ₽";
    }

    private static String thousandSep(long v) {
        String s = Long.toString(v);
        StringBuilder sb = new StringBuilder();
        int len = s.length();
        for (int i = 0; i < len; i++) {
            sb.append(s.charAt(i));
            int rem = len - 1 - i;
            if (rem > 0 && rem % 3 == 0) sb.append(' ');
        }
        return sb.toString();
    }
}
