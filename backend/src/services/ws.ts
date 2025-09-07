import type { Server } from "http";
import { WebSocketServer } from "ws";
import { bus } from "./events";

type ClientInfo = { symbol: string; timeframe: string };

export function setupWS(server: Server) {
  const wss = new WebSocketServer({ server, path: "/stream" });
  const clients = new Map<any, ClientInfo>();

  function broadcast(obj: any) {
    const payload = JSON.stringify(obj);
    for (const ws of wss.clients) {
      try {
        (ws as any).send(payload);
      } catch {}
    }
  }

  // Bridge import progress events → FE
  try {
    bus.on("import:begin", (p: any) =>
      broadcast({ type: "importProgress", stage: "begin", ...p })
    );
    bus.on("import:progress", (p: any) =>
      broadcast({ type: "importProgress", stage: "progress", ...p })
    );
    bus.on("import:done", (p: any) =>
      broadcast({ type: "importProgress", stage: "done", ...p })
    );
    bus.on("import:error", (p: any) =>
      broadcast({ type: "importProgress", stage: "error", ...p })
    );
  } catch {}

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const symbol = url.searchParams.get("symbol") ?? "WIN";
    const timeframe = url.searchParams.get("timeframe") ?? "M5";
    clients.set(ws, { symbol, timeframe });

    (ws as any).send(JSON.stringify({ type: "hello", symbol, timeframe }));

    (ws as any).on("close", () => {
      clients.delete(ws);
    });
  });

  // (debug) – envia candle simulado a cada 3s
  if (process.env.WS_DEBUG_CANDLES !== "0") {
    setInterval(() => {
      const o = 100000 + Math.random() * 400;
      const c = o + (Math.random() - 0.5) * 60;
      const h = Math.max(o, c) + Math.random() * 20;
      const l = Math.min(o, c) - Math.random() * 20;
      const payload = JSON.stringify({
        type: "candle",
        symbol: "WIN",
        timeframe: "M5",
        candle: {
          time: new Date().toISOString(),
          o,
          h,
          l,
          c,
          v: Math.round(100 + Math.random() * 400),
        },
      });
      for (const ws of wss.clients) {
        try {
          (ws as any).send(payload);
        } catch {}
      }
    }, 3000);
  }

  return wss;
}
