package com.easecutpro.tals;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

  private static final int MEDIA_PERMISSION_REQUEST = 1001;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Register native plugins BEFORE the bridge initialises.
    registerPlugin(EcNativeExportPlugin.class);
    super.onCreate(savedInstanceState);
    requestMediaPermissions();
  }

  /** Ask for gallery / storage read access on launch so importing photos, videos
   *  and audio works. Android 13+ (API 33) uses the granular READ_MEDIA_* perms;
   *  older versions use READ_EXTERNAL_STORAGE. */
  private void requestMediaPermissions() {
    String[] perms;
    if (Build.VERSION.SDK_INT >= 33) {
      perms = new String[] {
        Manifest.permission.READ_MEDIA_VIDEO,
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_AUDIO
      };
    } else {
      perms = new String[] { Manifest.permission.READ_EXTERNAL_STORAGE };
    }

    List<String> needed = new ArrayList<>();
    for (String p : perms) {
      if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
        needed.add(p);
      }
    }
    if (!needed.isEmpty()) {
      ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), MEDIA_PERMISSION_REQUEST);
    }
  }
}
