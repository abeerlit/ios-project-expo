import Foundation
import UserNotifications
import os.log

/// Shared with main app via `RCTVoxoNotificationsModule` + App Group.
enum SmsNotificationCache {
    static let appGroupId = "group.co.voxo.voxo-ios"
    static let cacheKey = "voxo_sms_notification_cache"
    static let lastResolveDebugKey = "voxo_sms_nse_last_resolve"
    static let lastResolveDebugTsKey = "voxo_sms_nse_last_resolve_ts"
    private static let log = OSLog(subsystem: "com.voxo.connect", category: "SmsCache")

    struct Payload: Codable {
        var phones: [String: String]?
        var conversations: [String: String]?
    }

    private static func nseLog(_ message: String) {
        os_log("%{public}@", log: log, type: .default, message)
        NSLog("%@", message)
    }

    static func writeLastResolveDebug(_ message: String) {
        guard let suite = UserDefaults(suiteName: appGroupId) else { return }
        suite.set(message, forKey: lastResolveDebugKey)
        suite.set(Date().timeIntervalSince1970, forKey: lastResolveDebugTsKey)
        suite.synchronize()
    }

    static func load() -> Payload? {
        guard let suite = UserDefaults(suiteName: appGroupId) else {
            nseLog("[IOS-SMS-CACHE][NSE] App Group suite unavailable group=\(appGroupId)")
            return nil
        }
        guard let json = suite.string(forKey: cacheKey) else {
            nseLog("[IOS-SMS-CACHE][NSE] No cache JSON in App Group key=\(cacheKey)")
            return nil
        }
        guard let data = json.data(using: .utf8) else {
            nseLog("[IOS-SMS-CACHE][NSE] Cache JSON encoding failed bytes=\(json.count)")
            return nil
        }
        guard let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
            nseLog("[IOS-SMS-CACHE][NSE] Cache JSON decode failed bytes=\(data.count)")
            return nil
        }
        let phoneCount = payload.phones?.count ?? 0
        let convCount = payload.conversations?.count ?? 0
        nseLog("[IOS-SMS-CACHE][NSE] Cache loaded phones=\(phoneCount) conversations=\(convCount) jsonBytes=\(data.count)")
        return payload
    }

    static func digitsOnly(_ value: String) -> String {
        value.filter { $0.isNumber }
    }

    static func cacheKey(for phone: String) -> String? {
        let digits = digitsOnly(phone)
        if digits.isEmpty { return nil }
        if digits.count >= 10 {
            return String(digits.suffix(10))
        }
        return digits
    }

    static func looksLikePhoneNumber(_ value: String) -> Bool {
        let digits = digitsOnly(value)
        if digits.isEmpty { return false }
        if digits.count == 10 {
            let first = digits.first!
            return first >= "2" && first <= "9"
        }
        if digits.count == 11, digits.hasPrefix("1") {
            return true
        }
        return digits.count >= 8 && digits.count <= 15
    }

    static func formatPhoneForDisplay(_ phone: String) -> String {
        let digits = digitsOnly(phone)
        if digits.count == 10 {
            let a = digits.prefix(3)
            let b = digits.dropFirst(3).prefix(3)
            let c = digits.suffix(4)
            return "(\(a)) \(b)-\(c)"
        }
        if digits.count == 11, digits.hasPrefix("1") {
            return "+\(digits)"
        }
        if !phone.hasPrefix("+"), digits.count > 10 {
            return "+\(digits)"
        }
        return phone.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func stringFromUserInfo(_ userInfo: [AnyHashable: Any], key: String) -> String? {
        if let s = userInfo[key] as? String, !s.isEmpty { return s }
        if let n = userInfo[key] as? NSNumber { return n.stringValue }
        if let data = userInfo["data"] as? [String: Any] {
            if let s = data[key] as? String, !s.isEmpty { return s }
            if let n = data[key] as? NSNumber { return n.stringValue }
        }
        return nil
    }

    static func extractSenderPhone(
        userInfo: [AnyHashable: Any],
        alertTitle: String?
    ) -> String {
        let candidates: [String?] = [
            stringFromUserInfo(userInfo, key: "from"),
            stringFromUserInfo(userInfo, key: "senderPhone"),
            alertTitle
        ]
        for candidate in candidates {
            guard let c = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !c.isEmpty,
                  looksLikePhoneNumber(c) else { continue }
            return c
        }
        return ""
    }

    static func conversationId(from userInfo: [AnyHashable: Any]) -> String? {
        let keys = ["reference_id", "conversationId", "conversation_id"]
        for key in keys {
            if let id = stringFromUserInfo(userInfo, key: key), !id.isEmpty {
                return id
            }
        }
        return nil
    }

    /// Prefer address-book name from `phones` map, then non-phone conversation title.
    /// `peerName` in the push is the recipient extension — never use it as sender title.
    static func resolveDisplayName(
        userInfo: [AnyHashable: Any],
        alertTitle: String?
    ) -> (name: String, phone: String, source: String)? {
        let phone = extractSenderPhone(userInfo: userInfo, alertTitle: alertTitle)
        let peerName = stringFromUserInfo(userInfo, key: "peerName")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let payload = load()

        nseLog("[IOS-SMS-CACHE][NSE] resolve start phone=\(phone) alertTitle=\(alertTitle ?? "") peerName=\(peerName ?? "") convId=\(conversationId(from: userInfo) ?? "")")

        if let payload = payload, !phone.isEmpty, let key = cacheKey(for: phone),
           let name = payload.phones?[key]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty {
            nseLog("[IOS-SMS-CACHE][NSE] resolve HIT phones key=\(key) name=\(name)")
            return (name, phone, "phones")
        }

        if let payload = payload,
           let convId = conversationId(from: userInfo),
           let title = payload.conversations?[convId]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !title.isEmpty,
           !looksLikePhoneNumber(title) {
            nseLog("[IOS-SMS-CACHE][NSE] resolve HIT conversations id=\(convId) title=\(title)")
            return (title, phone, "conversations")
        }

        if !phone.isEmpty {
            let formatted = formatPhoneForDisplay(phone)
            nseLog("[IOS-SMS-CACHE][NSE] resolve FALLBACK formattedPhone=\(formatted)")
            return (formatted, phone, "formattedPhone")
        }

        if let alert = alertTitle?.trimmingCharacters(in: .whitespacesAndNewlines),
           !alert.isEmpty,
           !looksLikePhoneNumber(alert) {
            nseLog("[IOS-SMS-CACHE][NSE] resolve FALLBACK alertTitle=\(alert)")
            return (alert, phone, "alertTitle")
        }

        nseLog("[IOS-SMS-CACHE][NSE] resolve MISS — no contact name (ignored peerName=\(peerName ?? ""))")
        return nil
    }

    /// Title = contact name; body = formatted phone + message or "sent a message".
    static func applySmsContactPresentation(
        to content: UNMutableNotificationContent,
        userInfo: [AnyHashable: Any]
    ) {
        let serverTitle = content.title
        let serverBody = content.body

        guard let resolved = resolveDisplayName(userInfo: userInfo, alertTitle: content.title) else {
            let msg = "[IOS-SMS-CACHE][NSE] MISS keeping server title=\(serverTitle) body=\(serverBody)"
            nseLog(msg)
            writeLastResolveDebug(msg)
            return
        }

        let senderPhone = resolved.phone
        let displayPhone = senderPhone.isEmpty
            ? content.title.trimmingCharacters(in: .whitespacesAndNewlines)
            : formatPhoneForDisplay(senderPhone)
        let name = resolved.name

        var messageBody = content.body.trimmingCharacters(in: .whitespacesAndNewlines)
        if let colon = messageBody.firstIndex(of: ":") {
            let prefix = String(messageBody[..<colon]).trimmingCharacters(in: .whitespacesAndNewlines)
            if looksLikePhoneNumber(prefix) || prefix == name {
                messageBody = String(messageBody[messageBody.index(after: colon)...])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        content.title = name

        let attachmentPhrases = [
            "Received a GIF",
            "Received an attachment",
            "sent a message"
        ]
        let isGenericAttachment = attachmentPhrases.contains { messageBody.contains($0) }

        if messageBody.isEmpty || isGenericAttachment {
            if !displayPhone.isEmpty {
                content.body = "\(displayPhone) sent a message"
            }
        } else if !displayPhone.isEmpty {
            content.body = messageBody
        } else {
            content.body = messageBody
        }

        let msg = "[IOS-SMS-CACHE][NSE] FINAL source=\(resolved.source) serverTitle=\(serverTitle) title=\(content.title) body=\(content.body) phone=\(senderPhone)"
        nseLog(msg)
        writeLastResolveDebug(msg)
    }
}
