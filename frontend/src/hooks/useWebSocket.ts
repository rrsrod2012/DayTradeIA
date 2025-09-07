import { useEffect, useRef } from "react";

export function useWebSocketStream(
  enabled: boolean,
  onCandle: (c: any) => void,
  onImport?: (p: any) => void
) {
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    if (!enabled) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }
    const ws = new WebSocket(
      "ws://localhost:4000/stream?symbol=WIN&timeframe=M5"
    );
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "candle") onCandle(data.candle);
        if (data.type === "importProgress") {
          if (onImport) onImport(data);
        }
      } catch {}
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [enabled, onCandle as any, onImport as any]);
}

export function useImportProgress(
  enabled: boolean,
  onUpdate: (p: any) => void
) {
  useWebSocketStream(enabled, () => {}, onUpdate);
}
