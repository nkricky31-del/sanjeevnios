package in.sanjeevnios.app;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins (PrinterPlugin.java, AppSetupPlugin.java) - registered before the bridge starts.
        registerPlugin(PrinterPlugin.class);
        registerPlugin(AppSetupPlugin.class);
        super.onCreate(savedInstanceState);
        // Draw behind the status and navigation bars on every Android version
        // (Android 15+ does it anyway). The web app pads its headers with
        // env(safe-area-inset-*); see SystemBars in capacitor.config.ts.
        // After super.onCreate, which switches from the launch theme.
        EdgeToEdge.enable(this);
    }
}
