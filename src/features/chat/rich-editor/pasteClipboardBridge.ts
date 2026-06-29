import type { WebViewMessageEvent } from "react-native-webview";

const CHUNK_SIZE = 480_000;

type ClipSession = {
  header: string;
  chunks: Map<number, string>;
  targetB64Len: number | null;
};

const clipSessions = new Map<string, ClipSession>();

const listeners = new Set<(dataUrl: string) => void>();

/** Subscribe to fully reassembled clipboard image `data:` URLs from the WebView. */
export function subscribeClipboardImageDataUrl(
  listener: (dataUrl: string) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitClipboardImage(dataUrl: string) {
  listeners.forEach((fn) => {
    try {
      fn(dataUrl);
    } catch {
      /* ignore */
    }
  });
}

/**
 * @returns true if consumed — chain before TenTap `onMessage` handling.
 */
export function handleVoxoClipWebMessage(event: WebViewMessageEvent): boolean {
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
  if (!t || typeof t !== "string" || !t.startsWith("VOXO_CLIP_")) return false;
  const id = parsed.requestId;
  if (!id) return true;

  if (t === "VOXO_CLIP_ERROR") {
    clipSessions.delete(id);
    return true;
  }

  if (t === "VOXO_CLIP_START") {
    clipSessions.set(id, {
      header:
        typeof parsed.header === "string" && parsed.header.length > 0
          ? parsed.header
          : "data:image/jpeg;base64,",
      chunks: new Map(),
      targetB64Len:
        typeof parsed.b64Len === "number" && parsed.b64Len >= 0
          ? parsed.b64Len
          : null
    });
    return true;
  }

  if (t === "VOXO_CLIP_PART") {
    const session = clipSessions.get(id);
    if (!session || parsed.seq == null || typeof parsed.chunk !== "string") {
      return true;
    }
    session.chunks.set(parsed.seq, parsed.chunk);
    return true;
  }

  if (t === "VOXO_CLIP_END") {
    const session = clipSessions.get(id);
    clipSessions.delete(id);
    if (!session) return true;
    try {
      const seqs = [...session.chunks.keys()].sort((a, b) => a - b);
      const joined = seqs.map((s) => session.chunks.get(s) ?? "").join("");
      if (
        session.targetB64Len != null &&
        joined.length !== session.targetB64Len
      ) {
        throw new Error(
          `clip b64 length mismatch: got ${joined.length}, expected ${session.targetB64Len}`
        );
      }
      emitClipboardImage(`${session.header}${joined}`);
    } catch {
      /* drop malformed assembly */
    }
    return true;
  }

  return false;
}

/** Injected into the TenTap WebView (iOS): image clipboard → chunked `VOXO_CLIP_*` posts. */
export function buildIosClipboardImagePasteInterceptorJs(
  maxBytes: number
): string {
  return `
(function(){
  if (window.__VOXO_CLIPBOARD_PASTE_IOS) return;
  window.__VOXO_CLIPBOARD_PASTE_IOS = true;
  var CHUNK = ${CHUNK_SIZE};
  var MAX_BYTES = ${maxBytes};
  function postChunked(dataUrl, rid) {
    var lower = dataUrl.toLowerCase();
    var sep = ';base64,';
    var i = lower.indexOf(sep);
    var header, b64;
    if (i >= 0) {
      header = dataUrl.slice(0, i + sep.length);
      b64 = dataUrl.slice(i + sep.length);
    } else {
      var c = dataUrl.indexOf(',');
      if (c < 0) return;
      header = dataUrl.slice(0, c + 1);
      b64 = dataUrl.slice(c + 1);
    }
    function post(o) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
    }
    post({ type: 'VOXO_CLIP_START', requestId: rid, header: header, b64Len: b64.length });
    var seq = 0;
    for (var j = 0; j < b64.length; j += CHUNK) {
      post({
        type: 'VOXO_CLIP_PART',
        requestId: rid,
        seq: seq++,
        chunk: b64.substring(j, Math.min(j + CHUNK, b64.length))
      });
    }
    post({ type: 'VOXO_CLIP_END', requestId: rid });
  }
  document.addEventListener('paste', function(e) {
    var cd = e.clipboardData;
    if (!cd || !cd.items) return;
    for (var k = 0; k < cd.items.length; k++) {
      var it = cd.items[k];
      if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
        e.preventDefault();
        e.stopPropagation();
        var f = it.getAsFile();
        if (!f) return;
        if (f.size && f.size > MAX_BYTES) {
          post({ type: 'VOXO_CLIP_ERROR', requestId: 'size', error: 'Image too large' });
          return;
        }
        var rid = 'clip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
        var fr = new FileReader();
        fr.onloadend = function() {
          var du = fr.result;
          if (typeof du !== 'string') return;
          postChunked(du, rid);
        };
        fr.onerror = function() {
          post({ type: 'VOXO_CLIP_ERROR', requestId: rid, error: 'FileReader failed' });
        };
        fr.readAsDataURL(f);
        return;
      }
    }
  }, true);
})();
true;
`;
}
