// ClaudeCall for the Mac: its own window, instead of a tab in the browser.
//
// The app's main program (scripts/build-mac.sh compiles it into ClaudeCall.app). It runs the
// launcher script — which sets ClaudeCall up as a background service and starts it, or offers to
// move the app into Applications first — and then shows ClaudeCall in a window of its own, signed
// in with the access code, the microphone allowed. Closing the window quits the app; the service,
// and the agents working in it, carry on, as they do when a browser tab is closed.

import Cocoa
import WebKit

// $HOME, as the launcher script uses, so both always look in the same place
let home = ProcessInfo.processInfo.environment["HOME"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser
let support = home.appendingPathComponent("Library/Application Support/ClaudeCall")

/** A value from the service's settings file, unquoted. */
func setting(_ key: String) -> String? {
    guard let text = try? String(contentsOf: support.appendingPathComponent("env"), encoding: .utf8) else { return nil }
    var value: String?
    for line in text.split(separator: "\n") where line.hasPrefix("\(key)=") {
        value = String(line.dropFirst(key.count + 1)).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
    }
    return value
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var address: URL?
    var retries = 0

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = [] // the agents' voices start on their own
        config.preferences.setValue(true, forKey: "developerExtrasEnabled") // right-click → Inspect
        web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "ClaudeCall"
        window.minSize = NSSize(width: 380, height: 560)
        window.backgroundColor = NSColor(red: 0.96, green: 0.957, blue: 0.93, alpha: 1)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("ClaudeCall")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        web.loadHTMLString(Self.startingPage, baseURL: nil)
        start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    /** Run the launcher (service set up and running), then open ClaudeCall in the window. */
    func start() {
        guard let script = Bundle.main.url(forResource: "launcher", withExtension: "sh") else { return fail() }
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = [script.path]
            var env = ProcessInfo.processInfo.environment
            env["CLAUDECALL_WINDOW"] = "1" // the launcher leaves opening it to this window
            p.environment = env
            do { try p.run() } catch { DispatchQueue.main.async { self.fail() }; return }
            p.waitUntilExit()
            DispatchQueue.main.async {
                switch p.terminationStatus {
                case 0: self.open()
                case 10: NSApp.terminate(nil) // moved to Applications (that copy opens), or cancelled
                default: self.fail()
                }
            }
        }
    }

    func open() {
        let port = setting("PORT") ?? "3747"
        let scheme = setting("BUDDY_HOST") == "0.0.0.0" ? "https" : "http"
        let code = setting("BUDDY_TOKEN") ?? ""
        guard let url = URL(string: "\(scheme)://localhost:\(port)/#code=\(code)") else { return fail() }
        address = URL(string: "\(scheme)://localhost:\(port)/")
        web.load(URLRequest(url: url))
    }

    func fail() {
        web.loadHTMLString(Self.failedPage, baseURL: nil)
    }

    // ---------- the page's requests ----------

    /** The microphone, for ClaudeCall itself only. */
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "localhost" && type == .microphone ? .grant : .deny)
    }

    /** ClaudeCall stays in the window; links elsewhere open in the browser. */
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, let host = url.host, host != "localhost", url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    /** Links meant for a new tab or window: the browser. */
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    /** On the network ClaudeCall uses a certificate it made itself: trusted for this Mac only. */
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.host == "localhost", let trust = challenge.protectionSpace.serverTrust {
            return completionHandler(.useCredential, URLCredential(trust: trust))
        }
        completionHandler(.performDefaultHandling, nil)
    }

    /** The service restarted, or the Mac woke up: try again in a moment rather than show an error. */
    func webView(_ webView: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        guard address != nil else { return }
        retries += 1
        if retries > 20 { return fail() } // about forty seconds: something is really wrong
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.open() }
    }

    func webView(_ webView: WKWebView, didFinish nav: WKNavigation!) {
        if webView.url?.host == "localhost" { retries = 0 }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = "ClaudeCall"
        a.informativeText = message
        a.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = "ClaudeCall"
        a.informativeText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    // ---------- menus ----------

    @objc func reload() { retries = 0; address == nil ? start() : open() }
    @objc func openInBrowser() {
        if let a = address, let code = setting("BUDDY_TOKEN"), let url = URL(string: "\(a.absoluteString)#code=\(code)") {
            NSWorkspace.shared.open(url)
        }
    }
    @objc func showLogs() {
        NSWorkspace.shared.open(home.appendingPathComponent("Library/Logs/ClaudeCall.log"))
    }

    func buildMenu() {
        let main = NSMenu()
        func menu(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem()
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            item.submenu = m
            main.addItem(item)
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        menu("ClaudeCall", [
            item("About ClaudeCall", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Hide ClaudeCall", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            .separator(),
            item("Quit ClaudeCall", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        menu("View", [
            item("Reload", #selector(reload), "r"),
            item("Open in Browser", #selector(openInBrowser), "b", [.command, .shift]),
            item("Show Log", #selector(showLogs), ""),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        menu("Window", [
            item("Minimize", #selector(NSWindow.miniaturize(_:)), "m"),
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.mainMenu = main
    }

    // ---------- the window's own pages, before ClaudeCall answers ----------

    static let style = """
    <style>
      body { margin: 0; height: 100vh; display: grid; place-items: center; font: 15px -apple-system, sans-serif;
             background: #f5f4ed; color: #141413; text-align: center; }
      @media (prefers-color-scheme: dark) { body { background: #1f1e1b; color: #f0eee6; } p { color: #a8a69e; } }
      .dot { width: 54px; height: 54px; border-radius: 50%; background: #d77757; margin: 0 auto 18px;
             animation: pulse 1.4s ease-in-out infinite; }
      @keyframes pulse { 50% { transform: scale(.82); opacity: .6; } }
      p { color: #6b6a64; max-width: 30em; line-height: 1.5; }
    </style>
    """
    static let startingPage = "<html>\(style)<body><div><div class=dot></div><b>Starting ClaudeCall…</b><p>The first time takes a minute, while the speech recogniser is fetched.</p></div></body></html>"
    static let failedPage = "<html>\(style)<body><div><b>ClaudeCall did not start</b><p>Details are in ~/Library/Logs/ClaudeCall.log (View → Show Log). Try View → Reload.</p></div></body></html>"
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
