import React, { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  View,
  StyleSheet,
  Platform,
  ScrollView,
  StyleProp,
  ViewStyle,
  SafeAreaView,
  StatusBar,
  TouchableWithoutFeedback,
  Keyboard
} from "react-native";
import { useTheme } from "hooks/use-theme.ts";
import { padding } from "core/theme/theme.ts";

interface Props {
  statusBarStyle?: "dark-content" | "light-content";
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  safeArea?: boolean;
  children: ReactNode;
  paddingVertical?: boolean;
  paddingHorizontal?: boolean;
  avoidKeyboard?: boolean;
}

export function Screen({
  scroll = false,
  style,
  paddingHorizontal = false,
  paddingVertical = false,
  contentContainerStyle,
  safeArea = true,
  statusBarStyle = "dark-content",
  avoidKeyboard = true,
  children
}: Props) {
  const theme = useTheme();
  const content = (
    <View
      style={[
        styles.container,
        paddingVertical && styles.paddingVertical,
        paddingHorizontal && styles.paddingHorizontal,
        style
      ]}
    >
      {children}
    </View>
  );

  const keyboardAvoidingView = (
    <KeyboardAvoidingView
      style={[
        styles.flex,
        {
          backgroundColor: theme.colors["color-colors-background-bg-primary"]
        },
        Platform.OS === "android" && { paddingTop: StatusBar.currentHeight }
      ]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <StatusBar
        barStyle={statusBarStyle}
        translucent={Platform.OS === "android"}
        backgroundColor={Platform.OS === "android" ? "transparent" : undefined}
      />
      {safeArea ? (
        <SafeAreaView style={styles.flex}>
          {scroll ? (
            <ScrollView contentContainerStyle={contentContainerStyle}>
              {content}
            </ScrollView>
          ) : (
            content
          )}
        </SafeAreaView>
      ) : scroll ? (
        <ScrollView contentContainerStyle={contentContainerStyle}>
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </KeyboardAvoidingView>
  );

  return avoidKeyboard ? (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      {keyboardAvoidingView}
    </TouchableWithoutFeedback>
  ) : (
    keyboardAvoidingView
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1
  },
  container: {
    flex: 1
  },
  paddingVertical: {
    paddingTop: 10,
    paddingBottom: 20
  },
  paddingHorizontal: {
    paddingHorizontal: padding.xl
  }
});
