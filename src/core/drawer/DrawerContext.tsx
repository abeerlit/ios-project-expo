// src/core/drawer/DrawerContext.tsx
import React, { createContext, useContext } from "react";

export type OpenDrawerOptions = {
  /** When true, user cannot swipe the sheet down to dismiss. */
  preventSwipeClose?: boolean;
  /** When true, tapping the dimmed backdrop does not close the drawer. */
  preventBackdropClose?: boolean;
  /** Android hardware back: invoked when set; handler should consume the event (return true). */
  onHardwareBackPress?: () => void;
  /** Override the sheet background color for this drawer instance. */
  backgroundColor?: string;
  /** Override the sheet border color for this drawer instance. */
  borderColor?: string;
  /** Override the handle bar color for this drawer instance. */
  handleColor?: string;
};

type DrawerContextType = {
  openDrawer: (
    content: React.ReactNode,
    snapPointIndex?: number,
    options?: OpenDrawerOptions
  ) => void;
  closeDrawer: () => void;
  setSnapPoint: (index: number) => void;
  isOpen: boolean;
  currentSnapPoint: number;
};

export const DrawerContext = createContext<DrawerContextType | undefined>(
  undefined
);

export const useDrawer = () => {
  const context = useContext(DrawerContext);
  if (!context) {
    throw new Error("useDrawer must be used within a DrawerProvider");
  }
  return context;
};
