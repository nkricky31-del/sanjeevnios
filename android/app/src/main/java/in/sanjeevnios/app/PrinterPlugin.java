package in.sanjeevnios.app;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Printing for the app. A web view can't open the print dialog by itself
 * (window.print() does nothing), so the web app's printPage() (src/lib/native.ts)
 * calls this: it hands the page, with its print styles, to Android's print
 * service - a printer, or "Save as PDF".
 */
@CapacitorPlugin(name = "Printer")
public class PrinterPlugin extends Plugin {

    @PluginMethod
    public void printPage(PluginCall call) {
        String name = call.getString("name", "SanjeevniOS");
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager printManager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                PrintDocumentAdapter adapter = getBridge().getWebView().createPrintDocumentAdapter(name);
                printManager.print(name, adapter, new PrintAttributes.Builder().build());
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not open printing: " + e.getMessage());
            }
        });
    }
}
