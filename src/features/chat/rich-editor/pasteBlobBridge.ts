import type { WebViewMessageEvent } from "react-native-webview";

const CHUNK_SIZE = 480_000;

type Pending = {
  header: string;
  chunks: Map<number, string>;
  targetB64Len: number | null;
  resolve: (dataUrl: string) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingByRequestId = new Map<string, Pending>();

function cleanup(id: string) {
  const p = pendingByRequestId.get(id);
  if (p) {
    clearTimeout(p.timeout);
    pendingByRequestId.delete(id);
  }
}

/**
 * @returns true if consumed — use with `exclusivelyUseCustomOnMessage` and skip TenTap default.
 */
export function handleVoxoBlobWebMessage(event: WebViewMessageEvent): boolean {
  const { data } = event.nativeEvent;
  if (typeof data !== "string") return false;
  let parsed: {
    type?: string;
    requestId?: string;
    header?: string;
    b64Len?: number;
    seq?: number;
    chunk?: string;
    error?: string;
  };
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  const t = parsed.type;
  if (!t || typeof t !== "string" || !t.startsWith("VOXO_BLOB_")) return false;
  const id = parsed.requestId;
  if (!id) return true;

  if (t === "VOXO_BLOB_ERROR") {
    const p = pendingByRequestId.get(id);
    if (p) {
      p.reject(new Error(parsed.error || "blob export failed"));
      cleanup(id);
    }
    return true;
  }

  if (t === "VOXO_BLOB_START") {
    const p = pendingByRequestId.get(id);
    if (!p) return true;
    p.header =
      typeof parsed.header === "string" && parsed.header.length > 0
        ? parsed.header
        : "data:image/jpeg;base64,";
    p.targetB64Len =
      typeof parsed.b64Len === "number" && parsed.b64Len >= 0
        ? parsed.b64Len
        : null;
    p.chunks.clear();
    return true;
  }

  if (t === "VOXO_BLOB_PART") {
    const p = pendingByRequestId.get(id);
    if (!p || parsed.seq == null || typeof parsed.chunk !== "string") return true;
    p.chunks.set(parsed.seq, parsed.chunk);
    return true;
  }

  if (t === "VOXO_BLOB_END") {
    const p = pendingByRequestId.get(id);
    if (!p) return true;
    try {
      const seqs = [...p.chunks.keys()].sort((a, b) => a - b);
      const joined = seqs.map((s) => p.chunks.get(s) ?? "").join("");
      if (p.targetB64Len != null && joined.length !== p.targetB64Len) {
        throw new Error(
          `blob b64 length mismatch: got ${joined.length}, expected ${p.targetB64Len}`
        );
      }
      p.resolve(`${p.header}${joined}`);
    } catch (e) {
      p.reject(e instanceof Error ? e : new Error(String(e)));
    } finally {
      cleanup(id);
    }
    return true;
  }

  return false;
}

function buildInjectJs(requestId: string, blobUrl: string): string {
  const rid = JSON.stringify(requestId);
  const burl = JSON.stringify(blobUrl);
  return `
(function(){
  try {
    var rid = ${rid};
    var url = ${burl};
    var chunkSize = ${CHUNK_SIZE};
    fetch(url).then(function(r){ return r.blob(); }).then(function(blob){
      return new Promise(function(resolve, reject){
        var fr = new FileReader();
        fr.onloadend = function(){ resolve(fr.result); };
        fr.onerror = function(e){ reject(e); };
        fr.readAsDataURL(blob);
      });
    }).then(function(dataUrl){
      var lower = dataUrl.toLowerCase();
      var b64Marker = ';base64,';
      var b64Sep = lower.indexOf(b64Marker);
      var header;
      var b64;
      if (b64Sep >= 0) {
        header = dataUrl.slice(0, b64Sep + b64Marker.length);
        b64 = dataUrl.slice(b64Sep + b64Marker.length);
      } else {
        var comma = dataUrl.indexOf(',');
        if (comma < 0) throw new Error('data URL has no comma separator');
        header = dataUrl.slice(0, comma + 1);
        b64 = dataUrl.slice(comma + 1);
      }
      function post(obj){
        try { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); } catch (e) {}
      }
      post({type:'VOXO_BLOB_START', requestId: rid, header: header, b64Len: b64.length});
      var seq = 0;
      for (var i = 0; i < b64.length; i += chunkSize) {
        post({
          type: 'VOXO_BLOB_PART',
          requestId: rid,
          seq: seq++,
          chunk: b64.substring(i, Math.min(i + chunkSize, b64.length))
        });
      }
      post({type:'VOXO_BLOB_END', requestId: rid});
    }).catch(function(e){
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'VOXO_BLOB_ERROR',
          requestId: rid,
          error: (e && e.message) ? e.message : String(e)
        }));
      } catch (_) {}
    });
  } catch (e) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'VOXO_BLOB_ERROR',
        requestId: ${rid},
        error: String(e)
      }));
    } catch (_) {}
  }
})();
true;
`;
}

/**
 * Read a `blob:` URL from inside the WebView as a `data:image/...;base64,...` string.
 */
export function exportBlobFromWebView(
  injectJS: (js: string) => void,
  blobUrl: string
): Promise<string> {
  const requestId = `blob_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup(requestId);
      reject(new Error("blob export timed out"));
    }, 120_000);
    pendingByRequestId.set(requestId, {
      header: "",
      chunks: new Map(),
      targetB64Len: null,
      resolve,
      reject,
      timeout,
    });
    injectJS(buildInjectJs(requestId, blobUrl));
  });
}
