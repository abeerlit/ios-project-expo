import UserNotifications
import UIKit
import os.log

class NotificationService: UNNotificationServiceExtension {

    private static let log = OSLog(subsystem: "com.voxo.connect", category: "NotificationService")

    private func nseLog(_ message: String) {
        os_log("%{public}@", log: Self.log, type: .default, message)
        NSLog("%@", message)
    }

    private func smsClickAction(from userInfo: [AnyHashable: Any]) -> String? {
        if let click = userInfo["click_action"] as? String, !click.isEmpty {
            return click
        }
        if let data = userInfo["data"] as? [String: Any],
           let click = data["click_action"] as? String, !click.isEmpty {
            return click
        }
        return nil
    }

    /// Mirrors src/core/notifications/staleVoipMissedCallFallback.ts — keep the two in sync.
    /// Server missed-call pushes carry NO callerName/callerNumber; the caller identity is the
    /// APNs alert TITLE ("1015") and the body is boilerplate ("Missed call").
    private func isMissedCallBoilerplate(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return t == "missed call" || t == "you have a missed call"
    }

    private func isUnknownSentinel(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["unknown", "unknown caller", "unknown number", "anonymous", "private", "restricted"]
            .contains(t)
    }

    private func pickCaller(_ value: Any?) -> String? {
        guard let s = value as? String else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty || isMissedCallBoilerplate(t) || isUnknownSentinel(t) { return nil }
        return t
    }

    private func isMissedCallNotification(_ userInfo: [AnyHashable: Any]) -> Bool {
        if (userInfo["vm_payload_type"] as? String) == "missed_call" { return true }
        guard let click = smsClickAction(from: userInfo) else { return false }
        return ["CALL-EVENT-MISSED", "MISSED-CALL", "missed-call", "MISSED-CALL-RECEIVED"]
            .contains(click)
    }

    /// Resolves the caller shown under "Missed Call". Prefers explicit keys, then the alert title.
    private func resolveMissedCallCaller(
        userInfo: [AnyHashable: Any],
        alertTitle: String
    ) -> String {
        for key in ["callerName", "caller_name", "displayName", "name",
                    "callerNumber", "caller_number", "handle", "from"] {
            if let picked = pickCaller(userInfo[key]) { return picked }
            if let data = userInfo["data"] as? [String: Any],
               let picked = pickCaller(data[key]) { return picked }
        }
        if let picked = pickCaller(alertTitle) { return picked }
        return "Unknown caller"
    }

    /// Mirrors RCTVoxoNotificationsModule — sendbird may be at root, under `data`, or a JSON string.
    private func sendbirdDict(from userInfo: [AnyHashable: Any]) -> [String: Any]? {
        var sb: Any? = userInfo["sendbird"]
        if sb == nil, let data = userInfo["data"] as? [String: Any] {
            sb = data["sendbird"]
        }
        if let dict = sb as? [String: Any] {
            return dict
        }
        if let json = sb as? String,
           let data = json.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return parsed
        }
        return nil
    }

    private func senderDisplayName(from sender: [String: Any]) -> String? {
        if let name = sender["name"] as? String, !name.isEmpty {
            return name
        }
        if let nickname = sender["nickname"] as? String, !nickname.isEmpty {
            return nickname
        }
        if let userId = sender["user_id"] as? String, !userId.isEmpty {
            return userId
        }
        if let userId = sender["userId"] as? String, !userId.isEmpty {
            return userId
        }
        return nil
    }

    private static func bodyLooksLikeHtml(_ text: String) -> Bool {
        if text.isEmpty { return false }
        return text.range(of: "<[^>]+>", options: .regularExpression) != nil ||
            text.contains("&nbsp;") ||
            text.contains("&lt;") ||
            text.contains("&gt;") ||
            text.contains("&amp;")
    }

    private func htmlTrace(_ stage: String, _ details: String) {
        nseLog("[SENDBIRD_HTML_TRACE] \(stage) \(details)")
    }

    private func sendbirdPayloadSource(from userInfo: [AnyHashable: Any]) -> String {
        if userInfo["sendbird"] is [String: Any] { return "root.dict" }
        if userInfo["sendbird"] is String { return "root.jsonString" }
        if let data = userInfo["data"] as? [String: Any] {
            if data["sendbird"] is [String: Any] { return "data.dict" }
            if data["sendbird"] is String { return "data.jsonString" }
        }
        return "missing"
    }

    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

        // Log full payload as received (same payload SpringBoard received for this notification)
        let userInfo = request.content.userInfo as NSDictionary
        NSLog("🔔 [NSE] ======== REMOTE NOTIFICATION RECEIVED ========")
        NSLog("🔔 [NSE] Full payload (userInfo): %@", userInfo)
        NSLog("🔔 [NSE] Title: %@", request.content.title)
        NSLog("🔔 [NSE] Body: %@", request.content.body)
        NSLog("🔔 [NSE] CategoryIdentifier: %@", request.content.categoryIdentifier)
        if let aps = request.content.userInfo["aps"] as? NSDictionary {
            NSLog("🔔 [NSE] aps: %@", aps)
        }
        NSLog("🔔 [NSE] ================================================")

        NSLog("🔔 Notification Modification")
        NSLog("🔔 Notification Payload body: \(request.content.body)")
        NSLog("🔔 Notification userInfo keys: \(request.content.userInfo.keys)")

        // SMS notification payload requirements (for notification to show properly):
        // - click_action: "TEXT-RECEIVED" (so NSE treats as SMS and displays; required for SMS path)
        // - Backend must send APNs alert: { title, body } (iOS maps these to request.content.title/body)
        // - Backend must set mutableContent: true (so this NSE is invoked)
        // - Do NOT set ignorePush: true if you want the notification to display (ignorePush suppresses display)
        // - Optional: reference_id (conversation id for deep link); mediaUrls / media_urls for attachments

        // Handle SMS/TEXT notifications FIRST (before ignorePush check)
        // SMS notifications need body modification even with ignorePush flag
        let clickAction = smsClickAction(from: request.content.userInfo)
        nseLog("[IOS-SMS-CACHE][NSE] click_action=\(clickAction ?? "nil") from=\(SmsNotificationCache.stringFromUserInfo(request.content.userInfo, key: "from") ?? "nil")")
        if clickAction == "TEXT-RECEIVED", let bestAttemptContent = bestAttemptContent {
            nseLog("[IOS-SMS-CACHE][NSE] SMS notification detected")
            
            // Check for media URLs (GIF/attachment)
            var mediaUrls: [String] = []
            if let urls = request.content.userInfo["mediaUrls"] as? [String] {
                mediaUrls = urls
            } else if let urlsString = request.content.userInfo["mediaUrls"] as? String,
                      let data = urlsString.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data) as? [String] {
                mediaUrls = parsed
            } else if let urls = request.content.userInfo["media_urls"] as? [String] {
                mediaUrls = urls
            } else if let urlsString = request.content.userInfo["media_urls"] as? String,
                      let data = urlsString.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data) as? [String] {
                mediaUrls = parsed
            }
            
            NSLog("🔔 SMS mediaUrls count: \(mediaUrls.count)")
            
            // If body is empty and we have media, set appropriate message
            if bestAttemptContent.body.isEmpty || bestAttemptContent.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if !mediaUrls.isEmpty {
                    let firstUrl = mediaUrls[0].lowercased()
                    let isGif = firstUrl.contains(".gif") ||
                                firstUrl.contains("giphy") ||
                                firstUrl.contains("tenor") ||
                                firstUrl.contains("gfycat") ||
                                firstUrl.contains("gif")
                    
                    if isGif {
                        bestAttemptContent.body = "Received a GIF 🎞️"
                        NSLog("🔔 SMS GIF detected!")
                    } else {
                        bestAttemptContent.body = "Received an attachment 📎"
                        NSLog("🔔 SMS attachment detected!")
                    }
                } else {
                    // Empty body SMS without mediaUrls - likely a media message (GIF/attachment)
                    bestAttemptContent.body = "Received an attachment 📎"
                }
            }

            // Resolve contact / conversation name from App Group cache (background + killed).
            SmsNotificationCache.applySmsContactPresentation(
                to: bestAttemptContent,
                userInfo: request.content.userInfo
            )
            
            // Ensure SMS notifications play sound on iOS (server payload may omit it)
            bestAttemptContent.sound = UNNotificationSound.default
            NSLog("🔔 SMS FINAL title: \(bestAttemptContent.title), body: \(bestAttemptContent.body), sound: default")
            contentHandler(bestAttemptContent)
            return
        }

        if let ignorePayloadAny = request.content.userInfo["ignorePush"] {
            var ignore = false
            if let str = ignorePayloadAny as? String, str == "true" {
                ignore = true
            } else if let boolVal = ignorePayloadAny as? Bool, boolVal == true {
                ignore = true
            }

            if ignore {
                let userInfo = request.content.userInfo
                let clickAction = userInfo["click_action"] as? String
                let isTextNotification = (clickAction == "TEXT-RECEIVED") ||
                    (userInfo["conversationId"] != nil) ||
                    (userInfo["conversation_id"] != nil) ||
                    (userInfo["reference_id"] != nil) ||
                    ((userInfo["vm_payload_type"] as? String) == "text-notification")
                if !isTextNotification {
                    NSLog("Ignore Flag Received, ignoring notification")
                    contentHandler(UNNotificationContent())
                    return
                } else {
                    // For SMS with ignorePush we SUPPRESS UI at the extension level
                    NSLog("Ignore Flag Received, SMS detected - suppressing notification UI at extension (no display)")
                    contentHandler(UNNotificationContent())
                    return
                }
            }
        }

        guard let bestAttemptContent = bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        // Missed call: server sends { title: "<caller>", body: "Missed call" }, which iOS would
        // draw caller-on-top. Flip it to match the foreground/Notifee banner exactly:
        //   title = "Missed Call", body = "<caller>"
        // Without this the banner layout differs between foreground and background/killed,
        // because willPresentNotification only fires in foreground.
        if isMissedCallNotification(request.content.userInfo) {
            let caller = resolveMissedCallCaller(
                userInfo: request.content.userInfo,
                alertTitle: request.content.title
            )
            bestAttemptContent.title = "Missed Call"
            bestAttemptContent.body = caller
            NSLog("📞 [NSE] Missed call — title=Missed Call body=%@", caller)
            contentHandler(bestAttemptContent)
            return
        }

        let rawAlertBody = bestAttemptContent.body
        let sendbirdSource = sendbirdPayloadSource(from: request.content.userInfo)
        htmlTrace(
            "NSE.enter",
            "rawBodyLooksHtml=\(Self.bodyLooksLikeHtml(rawAlertBody)) sendbirdSource=\(sendbirdSource) rawBodyPreview=\(String(rawAlertBody.prefix(180)))"
        )

        if let sendbirdContent = sendbirdDict(from: request.content.userInfo) {
            htmlTrace("NSE.path", "SENDBIRD_DICT_FOUND source=\(sendbirdSource)")

            if ChatNotificationPrefsCache.shouldSuppressSendbirdNotification(
                userInfo: request.content.userInfo
            ) {
                NSLog("🚫 [NSE] Sendbird notification suppressed by chat notification prefs")
                contentHandler(UNNotificationContent())
                return
            }

            let sender = sendbirdContent["sender"] as? [String: Any]
            let senderName = sender.flatMap { senderDisplayName(from: $0) }
            let channel = sendbirdContent["channel"] as? [String: Any]
            let channelType = channel?["custom_type"] as? String ?? ""
            let channelName = channel?["name"] as? String ?? ""

            htmlTrace(
                "NSE.sendbirdMeta",
                "senderName=\(senderName ?? "nil") channelType=\(channelType) channelName=\(String(channelName.prefix(80)))"
            )

            var plainBody = rawAlertBody
                .htmlToPlainText()
                .replacingOccurrences(of: "&nbsp;", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)

            htmlTrace(
                "NSE.afterHtmlToPlainText",
                "looksHtml=\(Self.bodyLooksLikeHtml(plainBody)) preview=\(String(plainBody.prefix(180)))"
            )

            if let senderName = senderName {
                if channelType.hasPrefix("DM") && !channelName.contains(",") {
                    bestAttemptContent.title = senderName
                    plainBody = processMessageBody(
                        plainBody,
                        senderName: senderName,
                        sendbirdContent: sendbirdContent,
                        includeSenderPrefix: false
                    )
                    htmlTrace("NSE.format", "DM path")
                } else {
                    plainBody = processMessageBody(
                        plainBody,
                        senderName: senderName,
                        sendbirdContent: sendbirdContent,
                        includeSenderPrefix: true
                    )
                    htmlTrace("NSE.format", "GROUP path includeSenderPrefix=true")
                }
            } else {
                plainBody = processMessageBody(
                    plainBody,
                    senderName: nil,
                    sendbirdContent: sendbirdContent,
                    includeSenderPrefix: false
                )
                htmlTrace("NSE.format", "NO_SENDER_NAME path")
            }

            if plainBody.isEmpty {
                plainBody = "Sent a message"
            }

            bestAttemptContent.body = plainBody.trimmingCharacters(in: .whitespacesAndNewlines)
            htmlTrace(
                "NSE.final",
                "title=\(bestAttemptContent.title) bodyLooksHtml=\(Self.bodyLooksLikeHtml(bestAttemptContent.body)) bodyPreview=\(String(bestAttemptContent.body.prefix(180)))"
            )
        } else if Self.bodyLooksLikeHtml(rawAlertBody) {
            htmlTrace(
                "NSE.path",
                "NO_SENDBIRD_DICT — system banner will show raw APNs body unless stripped here. userInfoKeys=\(request.content.userInfo.keys)"
            )
            let fallbackBody = rawAlertBody
                .htmlToPlainText()
                .replacingOccurrences(of: "&nbsp;", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            bestAttemptContent.body = fallbackBody
            htmlTrace(
                "NSE.fallbackStrip",
                "bodyLooksHtml=\(Self.bodyLooksLikeHtml(bestAttemptContent.body)) preview=\(String(bestAttemptContent.body.prefix(180)))"
            )
        } else {
            htmlTrace("NSE.path", "NON_SENDBIRD passthrough body=\(String(rawAlertBody.prefix(120)))")
        }

        // Don't set badge count here - let the main app handle it via SendbirdContextProvider
        contentHandler(bestAttemptContent)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }

    private func processMessageBody(
        _ body: String,
        senderName: String?,
        sendbirdContent: [String: Any],
        includeSenderPrefix: Bool
    ) -> String {
        let typeValue = (sendbirdContent["type"] as? String) ??
                        (sendbirdContent["message_type"] as? String) ??
                        (sendbirdContent["messageType"] as? String) ?? ""
        let isFileType = typeValue.uppercased() == "FILE"
        let files = sendbirdContent["files"] as? [[String: Any]]
        let hasFiles = (files?.isEmpty == false)

        func withSenderPrefix(_ text: String) -> String {
            guard includeSenderPrefix, let senderName = senderName, !senderName.isEmpty else {
                return text
            }
            return "\(senderName): \(text)"
        }

        if isFileType || hasFiles {
            return withSenderPrefix("Received an attachment 📎")
        }

        if let messageType = sendbirdContent["custom_type"] as? String {
            switch messageType {
            case "MESSAGE_GIF":
                return withSenderPrefix("Received a GIF 🎞️")
            case "MEETING_INVITE":
                return withSenderPrefix("Invited you to a meeting")
            default:
                break
            }
        }

        var messagePart = body
        if let senderName = senderName, !senderName.isEmpty {
            let prefix = "\(senderName):"
            if messagePart.hasPrefix(prefix) {
                messagePart = String(messagePart.dropFirst(prefix.count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            } else if let colonIndex = messagePart.firstIndex(of: ":") {
                messagePart = String(messagePart[messagePart.index(after: colonIndex)...])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        messagePart = messagePart
            .htmlToPlainText()
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if messagePart.isEmpty {
            return withSenderPrefix("Sent a message")
        }

        return withSenderPrefix(messagePart)
    }
}

extension String {
    func htmlToPlainText() -> String {
        guard let data = self.data(using: .utf8) else { return self }
        
        // Handle HTML to plain text conversion
        if let attributedString = try? NSAttributedString(data: data,
                                                          options: [.documentType: NSAttributedString.DocumentType.html,
                                                                    .characterEncoding: String.Encoding.utf8.rawValue],
                                                          documentAttributes: nil) {
            let result = attributedString.string
            // Remove any unwanted extra line breaks or spaces
            return result.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
        }
        
        // If the conversion fails, return the plain text by stripping tags
        var cleaned = self.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        cleaned = cleaned.replacingOccurrences(of: "&nbsp;", with: " ")
        cleaned = cleaned.replacingOccurrences(of: "&amp;", with: "&")
        cleaned = cleaned.replacingOccurrences(of: "&lt;", with: "<")
        cleaned = cleaned.replacingOccurrences(of: "&gt;", with: ">")
        cleaned = cleaned.replacingOccurrences(of: "&quot;", with: "\"")
        cleaned = cleaned.replacingOccurrences(of: "&#39;", with: "'")
        cleaned = cleaned.replacingOccurrences(of: "&apos;", with: "'")
        return cleaned.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
