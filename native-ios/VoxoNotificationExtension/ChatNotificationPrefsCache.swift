import Foundation
import os.log

/// Shared with main app via `RCTVoxoNotificationsModule` + App Group.
enum ChatNotificationPrefsCache {
    static let appGroupId = "group.co.voxo.voxo-ios"
    static let cacheKey = "voxo_chat_notification_prefs"
    private static let log = OSLog(subsystem: "com.voxo.connect", category: "ChatNotificationPrefs")

    struct Payload: Codable {
        var enableChatNotifications: Int
        var enableAllNewMessageNotifications: Int
        var enableDirectMessageNotifications: Int
        var tenantId: Int
    }

    private static func nseLog(_ message: String) {
        os_log("%{public}@", log: log, type: .default, message)
        NSLog("%@", message)
    }

    static func load() -> Payload? {
        guard let suite = UserDefaults(suiteName: appGroupId) else {
            nseLog("[CHAT-NOTIF-PREFS][NSE] App Group suite unavailable")
            return nil
        }
        guard let json = suite.string(forKey: cacheKey),
              let data = json.data(using: .utf8),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
            return nil
        }
        return payload
    }

    private static func sendbirdDict(from userInfo: [AnyHashable: Any]) -> [String: Any]? {
        if let dict = userInfo["sendbird"] as? [String: Any] {
            return dict
        }
        if let json = userInfo["sendbird"] as? String,
           let data = json.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return parsed
        }
        return nil
    }

    private static func channelCustomType(from userInfo: [AnyHashable: Any]) -> String? {
        guard let sendbird = sendbirdDict(from: userInfo),
              let channel = sendbird["channel"] as? [String: Any] else {
            return nil
        }
        return (channel["custom_type"] as? String) ?? (channel["customType"] as? String)
    }

    private static func isGroupChannel(customType: String?, tenantId: Int) -> Bool {
        guard let customType = customType else { return false }
        return customType == "Open_\(tenantId)"
    }

    private static func isDmChannel(customType: String?, tenantId: Int) -> Bool {
        guard let customType = customType else { return false }
        return customType == "DM_\(tenantId)" || customType == "DM_\(tenantId)_PERSONAL"
    }

    private static func shouldShow(customType: String?, prefs: Payload) -> Bool {
        let chatEnabled = prefs.enableChatNotifications == 1
        let allNewMessagesEnabled = prefs.enableAllNewMessageNotifications == 1
        let directOnlyEnabled = prefs.enableDirectMessageNotifications == 1

        if !chatEnabled {
            return false
        }

        if directOnlyEnabled {
            return isDmChannel(customType: customType, tenantId: prefs.tenantId)
        }

        if !allNewMessagesEnabled {
            return false
        }

        return true
    }

    static func shouldSuppressSendbirdNotification(userInfo: [AnyHashable: Any]) -> Bool {
        guard sendbirdDict(from: userInfo) != nil else {
            return false
        }

        guard let prefs = load() else {
            nseLog("[CHAT-NOTIF-PREFS][NSE] No cached prefs — allowing Sendbird notification")
            return false
        }

        let customType = channelCustomType(from: userInfo)
        let allow = shouldShow(customType: customType, prefs: prefs)
        if !allow {
            nseLog("[CHAT-NOTIF-PREFS][NSE] Suppressing Sendbird notification customType=\(customType ?? "nil")")
        }
        return !allow
    }
}
