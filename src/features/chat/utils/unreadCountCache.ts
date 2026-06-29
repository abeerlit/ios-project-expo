import { MMKV } from "react-native-mmkv";

const storage = new MMKV({
  id: "sendbird-unread-cache",
  encryptionKey: "voxo-sendbird-unread"
});

const UNREAD_COUNT_KEY = "channel_unread_counts";

interface UnreadCountMap {
  [channelUrl: string]: number;
}

export const UnreadCountCache = {
  /**
   * Get all cached unread counts
   */
  getAllUnreadCounts(): UnreadCountMap {
    try {
      const cached = storage.getString(UNREAD_COUNT_KEY);
      if (!cached) {
        return {};
      }
      return JSON.parse(cached) as UnreadCountMap;
    } catch (error) {
      console.error("[UnreadCountCache] Error getting unread counts:", error);
      return {};
    }
  },

  /**
   * Get unread count for a specific channel
   */
  getUnreadCount(channelUrl: string): number {
    try {
      const allCounts = this.getAllUnreadCounts();
      return allCounts[channelUrl] || 0;
    } catch (error) {
      console.error("[UnreadCountCache] Error getting unread count:", error);
      return 0;
    }
  },

  /**
   * Save unread count for a specific channel
   */
  setUnreadCount(channelUrl: string, count: number): void {
    try {
      const allCounts = this.getAllUnreadCounts();
      if (count > 0) {
        allCounts[channelUrl] = count;
      } else {
        // Remove entry if count is 0
        delete allCounts[channelUrl];
      }
      storage.set(UNREAD_COUNT_KEY, JSON.stringify(allCounts));
    } catch (error) {
      console.error("[UnreadCountCache] Error setting unread count:", error);
    }
  },

  /**
   * Save multiple unread counts at once
   */
  setAllUnreadCounts(counts: UnreadCountMap): void {
    try {
      // Filter out zero counts
      const filteredCounts: UnreadCountMap = {};
      Object.entries(counts).forEach(([url, count]) => {
        if (count > 0) {
          filteredCounts[url] = count;
        }
      });
      storage.set(UNREAD_COUNT_KEY, JSON.stringify(filteredCounts));
    } catch (error) {
      console.error(
        "[UnreadCountCache] Error setting all unread counts:",
        error
      );
    }
  },

  /**
   * Clear unread count for a specific channel
   */
  clearUnreadCount(channelUrl: string): void {
    try {
      const allCounts = this.getAllUnreadCounts();
      delete allCounts[channelUrl];
      storage.set(UNREAD_COUNT_KEY, JSON.stringify(allCounts));
    } catch (error) {
      console.error("[UnreadCountCache] Error clearing unread count:", error);
    }
  },

  /**
   * Clear all unread counts (use on logout if needed)
   */
  clearAllUnreadCounts(): void {
    try {
      storage.delete(UNREAD_COUNT_KEY);
    } catch (error) {
      console.error(
        "[UnreadCountCache] Error clearing all unread counts:",
        error
      );
    }
  }
};
