import { AppState } from "react-native";
import type { BootStoreBundle } from "./BootStoreContext";

/** Fresh native stack per step (setTimeout), not just Promise microtask. */
function macrotask<T>(label: string, fn: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(fn());
      } catch (e) {
        reject(e);
      }
    }, 0);
  });
}

/**
 * Build Redux store one macrotask per require (Hermes stack limit on device).
 */
export async function loadGlobalStorePiecemeal(): Promise<BootStoreBundle> {
  const createSagaMiddleware = await macrotask("redux-saga", () => {
    const sagaPkg = require("redux-saga") as {
      default?: () => import("redux-saga").Middleware;
    };
    return sagaPkg.default ?? (sagaPkg as unknown as () => import("redux-saga").Middleware);
  });

  const sagaMiddleware = await macrotask("createSagaMiddleware", () =>
    createSagaMiddleware()
  );

  const { mmkvStorage } = await macrotask("mmkvStorage", () =>
    require("store/utils/storage.ts") as { mmkvStorage: import("redux-persist").PersistStorage }
  );

  const { authReducer } = await macrotask("authReducer", () =>
    require("store/authentication/reducers.ts") as { authReducer: unknown }
  );
  const { userReducer } = await macrotask("userReducer", () =>
    require("store/users/reducers.ts") as { userReducer: unknown }
  );
  const { directoryReducer } = await macrotask("directoryReducer", () =>
    require("store/directory/reducers.ts") as { directoryReducer: unknown }
  );
  const { textReducer } = await macrotask("textReducer", () =>
    require("store/text/reducers.ts") as { textReducer: unknown }
  );
  const { sendbirdReducer } = await macrotask("sendbirdReducer", () =>
    require("store/sendbird/reducers.ts") as { sendbirdReducer: unknown }
  );

  const { persistCombineReducers, persistStore } = await macrotask("redux-persist", () =>
    require("redux-persist") as typeof import("redux-persist")
  );

  const { configureStore } = await macrotask("redux-toolkit", () =>
    require("@reduxjs/toolkit") as typeof import("@reduxjs/toolkit")
  );

  const reducers = await macrotask("persistCombineReducers", () =>
    persistCombineReducers(
      {
        key: "root",
        storage: mmkvStorage,
        blacklist: ["loadingReducer"],
        debug: false,
        timeout: undefined as number | undefined
      },
      { authReducer, userReducer, directoryReducer, textReducer, sendbirdReducer }
    )
  );

  const store = await macrotask("configureStore", () =>
    configureStore({
      reducer: reducers,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({ serializableCheck: false }).concat(sagaMiddleware)
    })
  );

  let rehydrated = () => {};
  const rehydratePromise = new Promise<void>((resolve) => {
    let settled = false;
    rehydrated = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });

  const { registerAppStore } = require("store/app-store.ts") as {
    registerAppStore: (s: unknown, r: Promise<void>) => void;
  };
  registerAppStore(store, rehydratePromise);

  await macrotask("persistStore", () => {
    persistStore(store, null, () => {
      AppState.addEventListener("change", (newState) => {
        if (newState === "active") {
          const actionTypes = require("store/global-actions.ts") as {
            APP_FOREGROUND: string;
          };
          store.dispatch({ type: actionTypes.APP_FOREGROUND });
        }
      });
      console.warn(
        `📦 [STORE] ${new Date().toISOString()} Store rehydrated (expo boot)`
      );
      if (require("react-native").Platform.OS === "ios") {
        const { syncIosSmsNotificationCacheFromStore } =
          require("core/notifications/iosSmsContactNameCache.ts") as {
            syncIosSmsNotificationCacheFromStore: () => void;
          };
        syncIosSmsNotificationCacheFromStore();
      }
      rehydrated();
    });
    setTimeout(() => {
      console.warn(`📦 [STORE] rehydrate fallback timeout (expo boot)`);
      rehydrated();
    }, 8000);
  });

  const { setGlobalStoreBridge } = require("./globalStoreBridge.ts") as {
    setGlobalStoreBridge: (bundle: BootStoreBundle) => BootStoreBundle;
  };
  setGlobalStoreBridge({
    store: store as BootStoreBundle["store"],
    rehydratePromise
  });

  setTimeout(() => {
    void macrotask("global-sagas", () => {
      const rootSaga =
        require("store/global-sagas.ts").default ??
        require("store/global-sagas.ts");
      sagaMiddleware.run(rootSaga);
    }).catch((e) => console.error("[loadGlobalStore] deferred sagas failed", e));
  }, 0);

  return { store: store as BootStoreBundle["store"], rehydratePromise };
}
