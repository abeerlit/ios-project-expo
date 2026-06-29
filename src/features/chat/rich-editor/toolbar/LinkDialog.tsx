import React from "react";
import { Dimensions, Platform, StyleSheet, View } from "react-native";
import Dialog from "react-native-dialog";

const { width: screenWidth } = Dimensions.get("window");
import { toast } from "@backpackapp-io/react-native-toast";
import { padding } from "core/theme/theme.ts";
import { Text } from "shared/components/Text.tsx";
import { LinkDialogProps } from "../types.ts";

const IOSBlurOverride = () => (
  <View style={StyleSheet.absoluteFill} />
);

export const LinkDialog: React.FC<LinkDialogProps> = ({
  state,
  onStateChange,
  onSave
}) => {
  const isIOS = Platform.OS === "ios";
  const textColor = isIOS ? "#000000" : undefined;

  const handleSave = () => {
    if (state.link) {
      onSave(state.link, state.title);
      onStateChange({ visible: false, link: "", title: "" });
    } else {
      toast.error("Could not set link");
      onStateChange({ ...state, visible: false });
    }
  };

  const handleCancel = () => {
    onStateChange({ visible: false, link: "", title: "" });
  };

  return (
    <Dialog.Container
      visible={state.visible}
      contentStyle={[styles.dialogContent, isIOS && { backgroundColor: "#FFFFFF" }]}
      blurComponentIOS={isIOS ? <IOSBlurOverride /> : undefined}
    >
      <Dialog.Title style={{ color: textColor }}>Add Link</Dialog.Title>
      <View style={styles.dialogInputContainer}>
        <Text
          align={"left"}
          color={textColor}
          style={styles.dialogLabel}
          weight="medium"
        >
          Title
        </Text>
        <Dialog.Input
          style={[styles.dialogInput, isIOS && { color: textColor }]}
          wrapperStyle={isIOS ? styles.dialogInputWrapper : undefined}
          value={state.title}
          onChangeText={(title) => onStateChange({ ...state, title })}
        />
      </View>
      <View style={styles.dialogInputContainer}>
        <Text
          align={"left"}
          color={textColor}
          style={styles.dialogLabel}
          weight="medium"
        >
          Link
        </Text>
        <Dialog.Input
          style={[styles.dialogInput, isIOS && { color: textColor }]}
          wrapperStyle={isIOS ? styles.dialogInputWrapper : undefined}
          value={state.link}
          onChangeText={(link) => onStateChange({ ...state, link })}
        />
      </View>
      <Dialog.Button label="Cancel" color={textColor} onPress={handleCancel} />
      <Dialog.Button label="Save" color={textColor} onPress={handleSave} />
    </Dialog.Container>
  );
};

const styles = StyleSheet.create({
  dialogContent: {
    flexDirection: "column",
    alignItems: "flex-start",
    marginBottom: padding.lg,
    width: screenWidth * 0.8,
    maxWidth: screenWidth * 0.8
  },
  dialogInputContainer: {
    alignSelf: "stretch",
    width: "100%",
    paddingHorizontal: padding.md
  },
  dialogLabel: {
    marginLeft: padding["2xl"],
    paddingBottom: padding.lg
  },
  dialogInputWrapper: {
    backgroundColor: "#F2F2F2",
    borderColor: "#D1D1D6",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6
  },
  dialogInput: {
    width: "100%",
    color: "#000000"
  }
});
