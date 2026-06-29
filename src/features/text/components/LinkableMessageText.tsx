import React, { useCallback, useMemo } from "react";
import { StyleSheet, type TextStyle, type StyleProp } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Text } from "shared/components/Text.tsx";
import { fontSize } from "core/theme/theme.ts";
import { openMessageLink } from "features/meeting/openMessageLink.ts";

const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,;:!?)}\]'"])/gi;

type LinkableMessageTextProps = {
  text: string;
  style?: StyleProp<TextStyle>;
};

export function LinkableMessageText({ text, style }: LinkableMessageTextProps) {
  const navigation = useNavigation();

  const handleLinkPress = useCallback(
    (href: string) => {
      openMessageLink(href, navigation);
    },
    [navigation]
  );

  const parts = useMemo(() => {
    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const pattern = new RegExp(URL_PATTERN);

    while ((match = pattern.exec(text)) !== null) {
      const href = match[0];
      const start = match.index;
      if (start > lastIndex) {
        nodes.push(text.slice(lastIndex, start));
      }
      nodes.push(
        <Text
          key={`${start}-${href}`}
          size={fontSize.md}
          align="left"
          color="activeBlue"
          style={styles.link}
          onPress={() => handleLinkPress(href)}
        >
          {href}
        </Text>
      );
      lastIndex = start + href.length;
    }

    if (lastIndex < text.length) {
      nodes.push(text.slice(lastIndex));
    }

    return nodes.length > 0 ? nodes : [text];
  }, [text, handleLinkPress]);

  return (
    <Text size={fontSize.md} align="left" style={style}>
      {parts}
    </Text>
  );
}

const styles = StyleSheet.create({
  link: {
    textDecorationLine: "underline"
  }
});
