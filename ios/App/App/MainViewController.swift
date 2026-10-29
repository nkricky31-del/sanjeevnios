import UIKit
import Capacitor

// The app's one screen: Capacitor's web view controller, plus the app's own
// plugins (PrinterPlugin.swift), registered as the bridge starts. Main.storyboard
// uses this class.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PrinterPlugin())
    }
}
