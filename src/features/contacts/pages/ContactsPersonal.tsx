// React Imports
import { useDispatch, useSelector } from "react-redux";
import { useDrawer } from "core/drawer/DrawerContext.tsx";
import { useQuery } from "@tanstack/react-query";
import * as directoryActions from "store/directory/actions.ts";
import { selectPhoneContactsData } from "store/directory/selectors.ts";
import { convertPhoneContactToDisplay } from "shared/utils/phone-contacts.ts";
import { getPersonalContacts } from "shared/api/directory/methods.ts";
import { Alert, Platform } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { checkPermission } from "core/permissions/utils.ts";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Type Imports
import React, { useMemo, useEffect, useCallback, useState } from "react";
import { Contact } from "features/contacts/types/types.ts";

// Component Imports
import { Screen } from "shared/components/utils/Screen.tsx";
import { EmptyState } from "shared/components/EmptyState.tsx";
import { FlatList } from "shared/components/utils/Flatlist.tsx";
import { DirectoryRowMemoized as DirectoryRow } from "features/contacts/components/DirectoryRow.tsx";
import { ContactDrawer } from "features/contacts/components/ContactDrawer.tsx";
import { ContactsSkeletonLoader } from "features/contacts/components/ContactsSkeletonLoader.tsx";
import SearchBar from "shared/components/utils/SearchBar.tsx";
import { contactsConsentMessage } from "shared/branding/appBrand.ts";
import { preloadImageUris } from "shared/components/CachedImage.tsx";

export function ContactsPersonal() {
  // Constants
  const { openDrawer } = useDrawer();
  const dispatch = useDispatch();
  const { accessToken } = useSelector(({ authReducer }: any) => authReducer);
  const { phoneContacts } = useSelector(selectPhoneContactsData);
  const [searchQuery, setSearchQuery] = useState("");
  const isFocused = useIsFocused();
  const [hasPhoneContactConsent, setHasPhoneContactConsent] = useState(
    Platform.OS !== "ios"
  );
  /** iOS only: remember if the user already answered the in-app consent prompt. */
  const [phoneContactsConsentChoice, setPhoneContactsConsentChoice] = useState<
    "allow" | "not_now" | null
  >(Platform.OS === "ios" ? null : "allow");
  const PHONE_CONTACTS_CONSENT_CHOICE_KEY =
    "phone_contacts_consent_choice_v1";

  useEffect(() => {
    let cancelled = false;
    const loadPersistedChoice = async () => {
      if (Platform.OS !== "ios") return;
      try {
        const v = await AsyncStorage.getItem(PHONE_CONTACTS_CONSENT_CHOICE_KEY);
        if (cancelled) return;
        if (v === "allow" || v === "not_now") {
          setPhoneContactsConsentChoice(v);
        } else {
          setPhoneContactsConsentChoice(null);
        }
      } catch {
        if (!cancelled) setPhoneContactsConsentChoice(null);
      }
    };
    void loadPersistedChoice();
    return () => {
      cancelled = true;
    };
  }, []);

  // If the user already granted iOS Contacts permission, do not re-prompt the in-app consent alert on every cold start.
  useEffect(() => {
    let cancelled = false;
    const syncConsentFromPermission = async () => {
      if (Platform.OS !== "ios") return;
      const status = await checkPermission("contacts");
      if (cancelled) return;
      if (status.granted) {
        setHasPhoneContactConsent(true);
      }
    };
    void syncConsentFromPermission();
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    data: personalContacts = [],
    isLoading: isLoadingPersonal,
    refetch: refetchPersonal
  } = useQuery({
    queryKey: ["personalContacts", accessToken],
    queryFn: async () => {
      if (!accessToken) return [];
      return await getPersonalContacts(accessToken);
    },
    enabled: !!accessToken,
    staleTime: 30000,
    gcTime: 300000,
    retry: 2
  });

  const promptPhoneContactsConsent = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        Alert.alert(
          "Sync Phone Contacts",
          contactsConsentMessage(),
          [
            {
              text: "Not Now",
              style: "cancel",
              onPress: () => {
                setHasPhoneContactConsent(false);
                setPhoneContactsConsentChoice("not_now");
                void AsyncStorage.setItem(
                  PHONE_CONTACTS_CONSENT_CHOICE_KEY,
                  "not_now"
                );
                resolve(false);
              }
            },
            {
              text: "Allow",
              onPress: () => {
                setHasPhoneContactConsent(true);
                setPhoneContactsConsentChoice("allow");
                void AsyncStorage.setItem(
                  PHONE_CONTACTS_CONSENT_CHOICE_KEY,
                  "allow"
                );
                resolve(true);
              }
            }
          ]
        );
      }),
    []
  );

  useEffect(() => {
    const syncContacts = async () => {
      // Avoid showing the consent alert when this tab isn't visible (tabs can stay mounted).
      if (!isFocused) return;
      if (Platform.OS !== "ios") {
        dispatch({ type: directoryActions.FETCH_PHONE_CONTACTS });
        return;
      }

      if (hasPhoneContactConsent) {
        dispatch({ type: directoryActions.FETCH_PHONE_CONTACTS });
        return;
      }

      // If the user already answered the in-app consent prompt, do not show it again.
      if (phoneContactsConsentChoice != null) {
        return;
      }

      const consented = await promptPhoneContactsConsent();
      if (consented) {
        dispatch({ type: directoryActions.FETCH_PHONE_CONTACTS });
      }
    };

    void syncContacts();
  }, [
    dispatch,
    hasPhoneContactConsent,
    promptPhoneContactsConsent,
    isFocused,
    phoneContactsConsentChoice
  ]);

  const allContacts = useMemo(() => {
    const phoneContactsConverted = phoneContacts.map(
      convertPhoneContactToDisplay
    );

    // Merge and deduplicate by phone number
    const merged = [...personalContacts, ...phoneContactsConverted];
    const seenNumbers = new Set<string>();
    const deduplicated = merged.filter((contact) => {
      const number = contact.number;
      if (!number) return true; // Keep contacts without numbers
      if (seenNumbers.has(number)) return false; // Skip duplicates
      seenNumbers.add(number);
      return true;
    });

    return deduplicated.sort((a, b) => a.name.localeCompare(b.name));
  }, [personalContacts, phoneContacts]);

  // Warm FastImage disk cache for visible contact avatars.
  useEffect(() => {
    if (allContacts.length === 0) return;
    const uris = allContacts
      .map((c) => c.avatarPath || c.avatarThumbnailPath)
      .filter((u): u is string => !!u);
    preloadImageUris(uris);
  }, [allContacts]);

  const handleRefresh = useCallback(() => {
    refetchPersonal();
    if (Platform.OS === "ios" && !hasPhoneContactConsent) {
      void promptPhoneContactsConsent().then((consented) => {
        if (consented) {
          dispatch({ type: directoryActions.FETCH_PHONE_CONTACTS });
        }
      });
      return;
    }
    dispatch({ type: directoryActions.FETCH_PHONE_CONTACTS });
  }, [
    refetchPersonal,
    dispatch,
    hasPhoneContactConsent,
    promptPhoneContactsConsent
  ]);

  const handleDirectoryPress = useCallback(
    (contact: Contact) => {
      openDrawer(<ContactDrawer item={contact} />);
    },
    [openDrawer]
  );

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredContacts = useMemo(() => {
    if (!normalizedSearch) return allContacts;

    return allContacts.filter((contact) => {
      const name = contact.name?.toLowerCase() || "";
      const number = contact.number?.toLowerCase() || "";
      const email = contact.email?.toLowerCase() || "";
      const company = contact.company?.toLowerCase() || "";

      return (
        name.includes(normalizedSearch) ||
        number.includes(normalizedSearch) ||
        email.includes(normalizedSearch) ||
        company.includes(normalizedSearch)
      );
    });
  }, [allContacts, normalizedSearch]);

  const handleSearchCancel = useCallback(() => {
    setSearchQuery("");
  }, []);

  const keyExtractor = useCallback((item: Contact) => {
    // Use contact type and unique identifier for stable keys
    if ("id" in item && item.id) {
      return `personal-${item.id}`;
    }
    if ("extId" in item) {
      // For phone contacts, use phone number to ensure uniqueness
      // extId alone is NOT unique (many contacts share the same extId)
      return `phone-${item.number || item.extId || item.name}`;
    }
    // Fallback to phone number for contacts without IDs
    return `contact-${item.number || item.name}`;
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: Contact }) => (
      <DirectoryRow
        item={item}
        handlePress={handleDirectoryPress}
        personal={true}
      />
    ),
    [handleDirectoryPress]
  );

  const emptyComponent = useMemo(
    () => (
      <EmptyState
        icon="users-01"
        title={
          normalizedSearch
            ? "No matching personal contacts found"
            : "No personal contacts found"
        }
        subtext={
          normalizedSearch
            ? "Try a different name, number, or email"
            : "Add new contacts or sync your phone contacts"
        }
      />
    ),
    [normalizedSearch]
  );

  // console.log(
  //   "allContacts[1--<]",
  //   allContacts?.filter((contact) => {
  //     if (contact.number == "2513843001") {
  //       return contact;
  //     }
  //     return null;
  //   })
  // );

  return (
    <Screen style={{ flex: 1 }} scroll={false} safeArea>
      <SearchBar
        placeholder="Search personal contacts"
        value={searchQuery}
        onChangeText={setSearchQuery}
        onCancel={handleSearchCancel}
        containerStyle={{ marginBottom: 12 }}
      />
      <FlatList
        style={{ flex: 1, width: "100%", height: "100%" }}
        contentContainerStyle={{ flexGrow: 1 }}
        scrollEventThrottle={16}
        keyExtractor={keyExtractor}
        data={filteredContacts}
        onRefresh={handleRefresh}
        loading={isLoadingPersonal}
        skeletonRowsAmount={10}
        skeletonRow={<ContactsSkeletonLoader />}
        ListEmptyComponent={emptyComponent}
        renderItem={renderItem}
        onEndReachedThreshold={0.5}
        removeClippedSubviews={false}
        maxToRenderPerBatch={20}
        windowSize={5}
        initialNumToRender={20}
        updateCellsBatchingPeriod={100}
      />
    </Screen>
  );
}
