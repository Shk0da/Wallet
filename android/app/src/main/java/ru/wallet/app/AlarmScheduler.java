package ru.wallet.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Планирование будильников через AlarmManager: утреннее уведомление (1001)
 * и фоновая автосинхронизация брокеров (1002 → SyncReceiver → SyncService).
 *
 * Точный будильник (setExactAndAllowWhileIdle); на Android 12+ без разрешения
 * «Будильники и напоминания» — фолбэк на неточный setAndAllowWhileIdle (окно ~15 мин).
 * Время следующего срабатывания — сегодня hour:minute, если уже прошло — завтра.
 */
public final class AlarmScheduler {

    static final String SNAPSHOT_FILE = "wallet-snapshot.json";
    private static final int REQUEST_CODE = 1001;
    private static final int REQUEST_CODE_SYNC = 1002;

    private AlarmScheduler() { }

    private static PendingIntent pendingIntent(Context ctx) {
        Intent intent = new Intent(ctx, NotifyReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, REQUEST_CODE, intent, flags);
    }

    private static PendingIntent syncPendingIntent(Context ctx) {
        Intent intent = new Intent(ctx, SyncReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, REQUEST_CODE_SYNC, intent, flags);
    }

    /** Общее ядро: сегодня hour:minute (уже прошло — завтра), точный будильник
     *  с фолбэком на неточный. */
    private static void scheduleAt(Context ctx, int hour, int minute, PendingIntent pi) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        java.util.Calendar cal = java.util.Calendar.getInstance();
        cal.set(java.util.Calendar.HOUR_OF_DAY, Math.max(0, Math.min(23, hour)));
        cal.set(java.util.Calendar.MINUTE, Math.max(0, Math.min(59, minute)));
        cal.set(java.util.Calendar.SECOND, 0);
        cal.set(java.util.Calendar.MILLISECOND, 0);
        if (cal.getTimeInMillis() <= System.currentTimeMillis()) {
            cal.add(java.util.Calendar.DAY_OF_YEAR, 1);
        }

        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
        } else {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
        }
    }

    public static void scheduleSync(Context ctx, int hour, int minute) {
        scheduleAt(ctx, hour, minute, syncPendingIntent(ctx));
    }

    public static void cancelSync(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(syncPendingIntent(ctx));
    }

    public static void schedule(Context ctx, int hour, int minute) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        java.util.Calendar cal = java.util.Calendar.getInstance();
        cal.set(java.util.Calendar.HOUR_OF_DAY, Math.max(0, Math.min(23, hour)));
        cal.set(java.util.Calendar.MINUTE, Math.max(0, Math.min(59, minute)));
        cal.set(java.util.Calendar.SECOND, 0);
        cal.set(java.util.Calendar.MILLISECOND, 0);
        if (cal.getTimeInMillis() <= System.currentTimeMillis()) {
            cal.add(java.util.Calendar.DAY_OF_YEAR, 1);
        }

        PendingIntent pi = pendingIntent(ctx);
        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
        } else {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
        }
    }

    public static void cancel(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(pendingIntent(ctx));
    }

    /**
     * Восстановить будильники из снапшота — вызывается при запуске Activity
     * и после перезагрузки (BootReceiver). Снапшот пишется JS-мостом при
     * каждом сохранении данных/настроек. Кроме утреннего уведомления
     * восстанавливает фоновую автосинхронизацию — она обязана срабатывать,
     * даже если приложение после перезагрузки ни разу не открывали.
     */
    static void rescheduleFromSnapshot(Context ctx) {
        try {
            JSONObject snap = readSnapshot(ctx);
            if (snap == null) return;
            JSONObject settings = snap.optJSONObject("settings");
            JSONObject n = settings == null ? null : settings.optJSONObject("notifications");
            if (n != null && n.optBoolean("enabled", false)) {
                schedule(ctx, n.optInt("hour", 8), n.optInt("minute", 0));
            } else {
                cancel(ctx);
            }
            JSONObject a = settings == null ? null : settings.optJSONObject("autoSync");
            if (a != null && a.optBoolean("enabled", false)) {
                scheduleSync(ctx, a.optInt("hour", 9), a.optInt("minute", 0));
            } else {
                cancelSync(ctx);
            }
        } catch (Exception ignored) { }
    }

    static JSONObject readSnapshot(Context ctx) throws Exception {
        File f = new File(ctx.getFilesDir(), SNAPSHOT_FILE);
        if (!f.isFile()) return null;
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        }
        return new JSONObject(new String(bo.toByteArray(), StandardCharsets.UTF_8));
    }
}
