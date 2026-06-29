import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { Gesture } from "react-native-gesture-handler";
import {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming
} from "react-native-reanimated";

/** Match DrawerProvider / MeetingChatSheet swipe-to-dismiss thresholds. */
export const MEETING_SHEET_SWIPE_CLOSE_TRANSLATION_Y = 100;
export const MEETING_SHEET_SWIPE_CLOSE_VELOCITY_Y = 800;

type UseMeetingSheetDragOptions = {
  sheetHeight: number;
  onClose: () => void;
  /** Disable swipe while keyboard is open (chat sheet). */
  panEnabled?: boolean;
};

export function useMeetingSheetDrag({
  sheetHeight,
  onClose,
  panEnabled = true
}: UseMeetingSheetDragOptions) {
  const sheetHeightRef = useRef(sheetHeight);
  sheetHeightRef.current = sheetHeight;

  const translateY = useSharedValue(sheetHeight);
  const dragStartY = useSharedValue(0);
  const sheetMaxY = useSharedValue(sheetHeight);

  useLayoutEffect(() => {
    sheetMaxY.value = sheetHeight;
  }, [sheetHeight, sheetMaxY]);

  useLayoutEffect(() => {
    const h = sheetHeightRef.current;
    translateY.value = h;
    translateY.value = withTiming(0, { duration: 240 });
  }, [translateY]);

  const finishClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const closeAnimated = useCallback(() => {
    const h = sheetHeightRef.current;
    translateY.value = withTiming(h, { duration: 220 }, (finished) => {
      if (finished) {
        runOnJS(finishClose)();
      }
    });
  }, [finishClose, translateY]);

  const sheetPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(panEnabled)
        .activeOffsetY(6)
        .failOffsetX([-24, 24])
        .onBegin(() => {
          dragStartY.value = translateY.value;
        })
        .onUpdate((event) => {
          const newY = dragStartY.value + Math.max(0, event.translationY);
          translateY.value = Math.min(newY, sheetMaxY.value);
        })
        .onEnd((event) => {
          const shouldClose =
            event.translationY > MEETING_SHEET_SWIPE_CLOSE_TRANSLATION_Y ||
            event.velocityY > MEETING_SHEET_SWIPE_CLOSE_VELOCITY_Y;
          if (shouldClose) {
            translateY.value = withTiming(
              sheetMaxY.value,
              { duration: 220 },
              (finished) => {
                if (finished) {
                  runOnJS(finishClose)();
                }
              }
            );
            return;
          }
          translateY.value = withSpring(0, {
            damping: 20,
            stiffness: 300
          });
        }),
    [finishClose, panEnabled, dragStartY, sheetMaxY, translateY]
  );

  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }]
  }));

  return { closeAnimated, sheetPanGesture, sheetAnimatedStyle };
}
