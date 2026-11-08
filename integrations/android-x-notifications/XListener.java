package com.qqagent.xrelay;

import android.app.Notification;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.os.PowerManager;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

public class XListener extends NotificationListenerService {
    private static final String X_PACKAGE = "com.twitter.android";
    private static final String TAG = "QQAgentXRelay";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    @Override public void onListenerConnected() {
        Log.i(TAG, "listener connected");
    }

    @Override public void onNotificationPosted(StatusBarNotification status) {
        String pkg = status.getPackageName();
        Notification notification = status.getNotification();
        boolean test = getPackageName().equals(pkg) && "test".equals(notification.getChannelId());
        boolean shellTest = "com.android.shell".equals(pkg) && (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!test && !shellTest && !X_PACKAGE.equals(pkg)) return;
        if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        if (!test && Notification.CATEGORY_MESSAGE.equals(notification.category)) return;
        Bundle extras = notification.extras;
        String title = text(extras, Notification.EXTRA_TITLE);
        String preview = text(extras, Notification.EXTRA_BIG_TEXT);
        if (preview.isEmpty()) preview = text(extras, Notification.EXTRA_TEXT);
        if (preview.isEmpty()) return;
        final String content = preview;
        PowerManager pm = getSystemService(PowerManager.class);
        worker.execute(() -> {
            PowerManager.WakeLock wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG + ":relay");
            wake.acquire(25000);
            try {
                relay(status, title, content, test, shellTest, pm.isInteractive());
            } catch (Exception error) {
                Log.w(TAG, "notification relay error " + error.getClass().getSimpleName());
            } finally {
                if (wake.isHeld()) wake.release();
            }
        });
    }

    private static String text(Bundle extras, String key) {
        CharSequence value = extras.getCharSequence(key);
        return value == null ? "" : value.toString().trim();
    }

    private void relay(StatusBarNotification status, String title, String preview, boolean test, boolean shellTest, boolean interactive) throws Exception {
        JSONObject config = new JSONObject(new String(Files.readAllBytes(getFileStreamPath("relay.json").toPath()), StandardCharsets.UTF_8));
        if (shellTest) {
            if (!"XRelay-Test".equals(title) || !preview.matches("[a-f0-9]{32}") || !preview.equals(config.optString("testNonce"))) return;
            test = true;
            preview = "息屏通知测试";
        }
        String author = config.getString("author").toLowerCase(Locale.ROOT);
        String display = config.getString("display");
        Pattern statusLink = Pattern.compile("https://(?:www\\.)?(?:x\\.com|twitter\\.com)/" + Pattern.quote(author) + "/status/(\\d{10,24})\\b", Pattern.CASE_INSENSITIVE);
        Matcher link = statusLink.matcher(preview);
        String postId = link.find() ? link.group(1) : null;
        String quotedTitle = "(?:" + Pattern.quote(display) + "|@" + Pattern.quote(author) + ")";
        boolean authorTitle = Pattern.compile("^" + quotedTitle + "(?:\\s*[:：]|\\s+(?:posted|published|shared)\\b|\\s*(?:发布了|发帖|发了一条)|$)", Pattern.CASE_INSENSITIVE).matcher(title).find();
        if (!test && postId == null && !authorTitle) {
            Log.i(TAG, "X notification skipped; author could not be verified");
            return;
        }
        String snippet = preview.substring(0, Math.min(450, preview.length()));
        byte[] hash = MessageDigest.getInstance("SHA-256").digest((author + "\n" + status.getKey() + "\n" + snippet).getBytes(StandardCharsets.UTF_8));
        StringBuilder id = new StringBuilder();
        for (byte value : hash) id.append(String.format(Locale.ROOT, "%02x", value & 255));
        JSONObject payload = new JSONObject().put("id", id.toString()).put("author", author)
            .put("postedAt", status.getPostTime()).put("preview", snippet);
        if (postId != null) payload.put("postId", postId);
        if (test) payload.put("test", true);
        URL endpoint = new URL(config.getString("url"));
        if (!"https".equals(endpoint.getProtocol())) throw new IllegalArgumentException("HTTPS required");
        HttpsURLConnection connection = (HttpsURLConnection) endpoint.openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(15000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + config.getString("token"));
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setDoOutput(true);
            try (java.io.OutputStream stream = connection.getOutputStream()) {
                stream.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = connection.getResponseCode();
            Log.i(TAG, (test ? "test" : "post") + " interactive=" + interactive + " HTTP=" + code);
        } finally {
            connection.disconnect();
        }
    }
}
