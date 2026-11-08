package com.qqagent.xrelay;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class RelayActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        ComponentName listener = new ComponentName(this, XListener.class);
        getPackageManager().setComponentEnabledSetting(listener, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
        NotificationListenerService.requestRebind(listener);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(24, 24, 24, 24);
        TextView title = new TextView(this);
        title.setText("X 通知转发\n指定账号的新帖通知将转发到已绑定的 QQ 私聊。");
        layout.addView(title);
        Button access = new Button(this);
        access.setText("打开通知访问设置");
        access.setOnClickListener(view -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        layout.addView(access);
        Button test = new Button(this);
        test.setText("8 秒后发一条测试通知");
        test.setOnClickListener(view -> {
            test.setEnabled(false);
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                postTest();
                test.setEnabled(true);
            }, 8000);
        });
        layout.addView(test);
        setContentView(layout);
    }

    private void postTest() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("test", "转发测试", NotificationManager.IMPORTANCE_LOW));
        manager.notify((int) (System.currentTimeMillis() / 1000), new Notification.Builder(this, "test")
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("XRelay-Test")
            .setContentText("息屏通知测试").setAutoCancel(true).build());
    }
}
