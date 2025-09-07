/* eslint-disable @typescript-eslint/no-explicit-any */
export type WSOptions = {
  path?: string; // ex: "/stream"
  onOpen?: (ev: Event) => void;
  onMessage?: (data: any, raw: MessageEvent) => void;
  onError?: (ev: Event) => void;
  onClose?: (ev: CloseEvent) => void;
};

export function getWebSocketUrl(path = "/stream"): string {
  const env: any = (import.meta as any).env || {};
  const explicit = env.VITE_WS_URL as string | undefined;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  const apiBase = (env.VITE_API_BASE as string | undefined)?.trim() || "";
  const base =
    apiBase !== ""
      ? apiBase.replace(/^http/i, "ws")
      : window.location.origin.replace(/^http/i, "ws");
  const normalizedBase = base.replace(/\/?$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return normalizedBase + normalizedPath;
}

export function openWebSocket(opts: WSOptions = {}) {
  const url = getWebSocketUrl(opts.path ?? "/stream");
  const ws = new WebSocket(url);

  ws.onopen = (ev) => {
    opts.onOpen?.(ev);
  };

  ws.onmessage = (ev) => {
    let data: any = null;
    try {
      data = JSON.parse(ev.data as any);
    } catch {
      data = ev.data;
    }
    opts.onMessage?.(data, ev);
  };

  ws.onerror = (ev) => {
    opts.onError?.(ev);
  };

  ws.onclose = (ev) => {
    opts.onClose?.(ev);
  };

  return ws;
}
