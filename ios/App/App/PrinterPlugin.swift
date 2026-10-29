import UIKit
import Capacitor

// Printing for the app. A web view can't open the print sheet by itself
// (window.print() does nothing), so the web app's printPage()
// (src/lib/native.ts) calls this: it hands the page, with its print styles,
// to AirPrint - a printer, or Save to Files as a PDF.
@objc(PrinterPlugin)
public class PrinterPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PrinterPlugin"
    public let jsName = "Printer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "printPage", returnType: CAPPluginReturnPromise)
    ]

    @objc func printPage(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? "SanjeevniOS"
        DispatchQueue.main.async {
            guard let webView = self.bridge?.webView else {
                call.reject("The page isn't ready to print yet.")
                return
            }
            let info = UIPrintInfo(dictionary: nil)
            info.outputType = .general
            info.jobName = name
            let controller = UIPrintInteractionController.shared
            controller.printInfo = info
            controller.printFormatter = webView.viewPrintFormatter()
            let done: UIPrintInteractionController.CompletionHandler = { _, _, error in
                if let error = error {
                    call.reject(error.localizedDescription)
                } else {
                    call.resolve()
                }
            }
            if UIDevice.current.userInterfaceIdiom == .pad {
                // On an iPad the print options open as a popover from the middle of the screen.
                let rect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1)
                controller.present(from: rect, in: webView, animated: true, completionHandler: done)
            } else {
                controller.present(animated: true, completionHandler: done)
            }
        }
    }
}
