package com.claudecall.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * ClaudeCall on Android: a full-screen window onto the ClaudeCall running on the lead's own
 * computer. ClaudeCall is a web app served by that computer, so all this adds is what a browser
 * tab cannot do well on a phone: its own icon and window, the microphone granted once, the screen
 * kept on during a call, and trusting the certificate ClaudeCall makes itself on a home network.
 *
 * The first time it asks for the computer's address and the access code; the code is handed to
 * the page after the #, which never leaves the phone, and the page remembers it from then on.
 */
public class MainActivity extends Activity {
    private static final int MIC_REQUEST = 1;

    private SharedPreferences prefs;
    private WebView web;
    private boolean onCall = false;
    /** A page's request for the microphone, waiting on Android's own permission prompt. */
    private PermissionRequest pendingMic;
    /** Certificate errors waiting on the lead's answer: one question, however many requests. */
    private final List<SslErrorHandler> pendingTrust = new ArrayList<>();
    private AlertDialog trustDialog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("claudecall", MODE_PRIVATE);
        if (address().isEmpty()) showSetup(null);
        else openCall();
    }

    private String address() {
        return prefs.getString("address", "");
    }

    private String host() {
        String h = Uri.parse(address()).getHost();
        return h == null ? "" : h;
    }

    // ---------- the address and the code ----------

    private void showSetup(String message) {
        onCall = false;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.setup);
        EditText addressBox = findViewById(R.id.address);
        EditText codeBox = findViewById(R.id.code);
        TextView messageView = findViewById(R.id.message);
        Button connect = findViewById(R.id.connect);
        addressBox.setText(address());
        codeBox.setText(prefs.getString("code", ""));
        messageView.setText(message == null ? "" : message);
        connect.setOnClickListener(v -> {
            String a = addressBox.getText().toString().trim();
            String code = codeBox.getText().toString().trim().toLowerCase(Locale.ROOT);
            while (a.endsWith("/")) a = a.substring(0, a.length() - 1);
            if (a.isEmpty()) {
                messageView.setText("Enter the address ClaudeCall shows for phones and tablets.");
                return;
            }
            if (a.startsWith("http://")) {
                messageView.setText("Use the https address: the microphone only works over https.");
                return;
            }
            if (!a.startsWith("https://")) a = "https://" + a;
            if (Uri.parse(a).getHost() == null) {
                messageView.setText("That does not look like an address.");
                return;
            }
            prefs.edit().putString("address", a).putString("code", code).apply();
            openCall();
        });
    }

    // ---------- the call ----------

    private void openCall() {
        if (web == null) web = makeWebView();
        onCall = true;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(web);
        String code = prefs.getString("code", "");
        web.loadUrl(address() + "/" + (code.isEmpty() ? "" : "#code=" + Uri.encode(code)));
    }

    private WebView makeWebView() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // the agents' voices start without a tap
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " ClaudeCallAndroid");

        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // only the microphone, and only for the lead's own ClaudeCall
                boolean wantsMic = false;
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
                }
                if (!wantsMic || !host().equals(request.getOrigin().getHost())) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    if (pendingMic != null) pendingMic.deny();
                    pendingMic = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC_REQUEST);
                }
            }
        });

        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // ClaudeCall stays in the app; links elsewhere (docs, pictures) open in the browser
                if (host().equals(request.getUrl().getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                trustOrAsk(handler, error);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showSetup("Couldn't reach " + host() + " (" + error.getDescription() + "). Is the computer awake and ClaudeCall running?");
                }
            }
        });
        return w;
    }

    /**
     * On a home network ClaudeCall uses a certificate it made itself, which Android does not know.
     * The lead is asked once whether to trust it, shown its fingerprint; after that the same
     * certificate from the same computer is let through, and any other one is asked about again.
     */
    private void trustOrAsk(SslErrorHandler handler, SslError error) {
        String errorHost = Uri.parse(error.getUrl()).getHost();
        String fingerprint = fingerprint(error);
        if (errorHost == null || !errorHost.equals(host()) || fingerprint == null) {
            handler.cancel();
            return;
        }
        if (fingerprint.equals(prefs.getString("trust:" + errorHost, ""))) {
            handler.proceed();
            return;
        }
        pendingTrust.add(handler);
        if (trustDialog != null && trustDialog.isShowing()) return;
        trustDialog = new AlertDialog.Builder(this)
                .setTitle("Trust this computer?")
                .setMessage("ClaudeCall on " + errorHost + " uses a certificate it made itself. "
                        + "If this is your computer, trust it. You will only be asked again if it changes.\n\n"
                        + "Fingerprint:\n" + fingerprint)
                .setCancelable(false)
                .setPositiveButton("Trust", (d, which) -> {
                    prefs.edit().putString("trust:" + errorHost, fingerprint).apply();
                    for (SslErrorHandler h : pendingTrust) h.proceed();
                    pendingTrust.clear();
                })
                .setNegativeButton("Cancel", (d, which) -> {
                    for (SslErrorHandler h : pendingTrust) h.cancel();
                    pendingTrust.clear();
                    showSetup("Not connected: the computer's certificate was not trusted.");
                })
                .show();
    }

    private static String fingerprint(SslError error) {
        try {
            byte[] der = error.getCertificate().getX509Certificate().getEncoded();
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(der);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < hash.length; i++) {
                if (i > 0) sb.append(i % 16 == 0 ? "\n" : ":");
                sb.append(String.format(Locale.ROOT, "%02X", hash[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != MIC_REQUEST || pendingMic == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingMic.deny();
        }
        pendingMic = null;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (onCall && web != null && web.canGoBack()) {
            web.goBack();
        } else if (onCall) {
            new AlertDialog.Builder(this)
                    .setTitle("Leave ClaudeCall?")
                    .setMessage("Your team keeps working on your computer.")
                    .setPositiveButton("Leave", (d, w) -> finish())
                    .setNeutralButton("Change computer", (d, w) -> showSetup(null))
                    .setNegativeButton("Stay", null)
                    .show();
        } else if (!address().isEmpty()) {
            openCall();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
