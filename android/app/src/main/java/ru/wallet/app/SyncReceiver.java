package ru.wallet.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Сработал будильник фоновой автосинхронизации (AlarmScheduler, код 1002).
 *
 * Планируем следующий запуск (завтра, из снапшота настроек) ДО старта сервиса —
 * автосинхронизация обязана работать даже если приложение больше ни разу
 * не откроют. Затем поднимаем SyncService: точный будильник даёт временной
 * allowlist на запуск foreground-сервиса из фона.
 */
public class SyncReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        AlarmScheduler.rescheduleFromSnapshot(ctx);
        try {
            Intent svc = new Intent(ctx, SyncService.class);
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc);
            else ctx.startService(svc);
        } catch (Exception e) {
            // Ограничения конкретного прошивока/версии: в следующий раз попробует
            // открытая страница (autoSyncCheck в sync-client.js)
            Log.w("WalletSync", "не удалось запустить SyncService: " + e.getMessage());
        }
    }
}
