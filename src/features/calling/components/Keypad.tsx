import React from "react";
import { Screen } from "shared/components/utils/Screen.tsx";
import { TopBar } from "shared/components/TopBar.tsx";
import { useStableTopBarAvatar } from "hooks/use-stable-top-bar-avatar.ts";
import { DialerKeypad } from "features/calling/components/DialerKeypad.tsx";
import { useSoftphone } from "core/softphone/useSoftphone.ts";
import { InCallScreen } from "./InCallScreen.tsx";

export function Keypad() {
  const { avatarSource, avatarName } = useStableTopBarAvatar();
  const { activeCallId } = useSoftphone();

  return (
    <Screen paddingHorizontal>
      <TopBar
        title={activeCallId ? "In Call" : "Keypad"}
        avatarSource={avatarSource}
        avatarName={avatarName}
      />
      {activeCallId && activeCallId !== "dialing" ? (
        <InCallScreen embedded />
      ) : (
        <DialerKeypad />
      )}
    </Screen>
  );
}
