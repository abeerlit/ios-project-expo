/**
 * Call approach configuration for testing.
 *
 * USE_VOXO_MOBILE_APPROACH = true (iOS):
 *   - VoIP push inbound: per-call SlimSipClient (PushKit)
 *   - App outbound + CallKit Recents: JsSIP via placeOutboundJsSipCall
 *   - Call notifs off + foreground: ForegroundSlimSipHub (WebSocket REGISTER + INVITE)
 *   - SessionManager (sip.js) is not used on iOS when this flag is true
 *
 * USE_VOXO_MOBILE_APPROACH = false:
 *   - Dual-path: SessionManager for foreground incoming, SlimSipClient for background/killed
 */
export const USE_VOXO_MOBILE_APPROACH = true;
