import { persistStore, persistCombineReducers } from "redux-persist";
import createSagaMiddleware from "redux-saga";
import { AppState, Platform } from "react-native";
import { syncIosSmsNotificationCacheFromStore } from "core/notifications/iosSmsContactNameCache.ts";
import globalReducers from "./global-reducers.ts";
import * as actionTypes from "./global-actions.ts";
import { configureStore } from "@reduxjs/toolkit";
import { mmkvStorage } from "./utils/storage.ts";
import {
  isAppStoreRegistered,
  registerAppStore,
  store,
  rehydratePromise
} from "./app-store.ts";

export { registerAppStore, store, rehydratePromise };

let barePersistor: ReturnType<typeof persistStore> | undefined;

function initBareStore() {
  if (isAppStoreRegistered()) return;

  const config = {
    key: "root",
    storage: mmkvStorage,
    blacklist: ["loadingReducer"],
    debug: true,
    timeout: undefined
  };

  const sagaMiddleware = createSagaMiddleware();
  const reducers = persistCombineReducers(config, globalReducers);
  const bareStore = configureStore({
    reducer: reducers,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: false
      }).concat(sagaMiddleware)
  });

  let rehydrated = () => {};
  const bareRehydratePromise = new Promise<void>((resolve) => {
    rehydrated = () => {
      console.warn(
        `📦 [STORE] ${new Date().toISOString()} rehydratePromise resolved`
      );
      resolve();
    };
  });

  registerAppStore(bareStore, bareRehydratePromise);

  barePersistor = persistStore(bareStore, null, () => {
    AppState.addEventListener("change", (newState) => {
      if (newState === "active") {
        bareStore.dispatch({
          type: actionTypes.APP_FOREGROUND
        });
      }
    });

    console.warn(
      `📦 [STORE] ${new Date().toISOString()} Store rehydrated from MMKV`
    );
    if (Platform.OS === "ios") {
      syncIosSmsNotificationCacheFromStore();
    }
    rehydrated();
  });

  const sagas = require("./global-sagas.ts").default;
  sagaMiddleware.run(sagas);
}

const ConfigureStore = () => {
  initBareStore();
  return { persistor: barePersistor, store, rehydratePromise };
};

export default ConfigureStore;
