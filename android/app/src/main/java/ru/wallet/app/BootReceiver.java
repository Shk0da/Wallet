package ru.wallet.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * После перезагрузки AlarmManager чист — восстанавливаем утренний будильник
 * из снапшота (wallet-snapshot.json), который JS-мост обновляет при каждом
 * сохранении данных и настроек.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            AlarmScheduler.rescheduleFromSnapshot(ctx);
        }
    }
}
