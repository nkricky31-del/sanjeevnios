package in.sanjeevnios.app;

import android.content.Context;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * What the web app needs to know about this build and phone before it offers
 * alerts (src/lib/push.ts):
 *   configured    - the build includes Firebase's config (android/app/google-services.json);
 *                   without it alerts can't be set up, so they aren't offered;
 *   systemEnabled - notifications for SanjeevniOS are allowed in the phone's settings.
 */
@CapacitorPlugin(name = "AppSetup")
public class AppSetupPlugin extends Plugin {

    @PluginMethod
    public void pushStatus(PluginCall call) {
        Context context = getContext();
        // The google-services Gradle plugin turns google-services.json into this string.
        int appId = context.getResources().getIdentifier("google_app_id", "string", context.getPackageName());
        JSObject result = new JSObject();
        result.put("configured", appId != 0);
        result.put("systemEnabled", NotificationManagerCompat.from(context).areNotificationsEnabled());
        call.resolve(result);
    }
}
