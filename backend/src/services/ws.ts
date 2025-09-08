import type { Server } from "http";
import { WebSocketServer } from "ws";
import { bus } from "./events";
import path from "path";

type ClientInfo = { symbol: string; timeframe: string };

export function setupWS(server: Server) {
  // perMessageDeflate: false evita alguns handshakes falharem em dev/proxy
  const wss = new WebSocketServer({
    server,
    path: "/stream",
    perMessageDeflate: false,
  });
  const clients = new Map<any, ClientInfo>();

  function broadcast(obj: any) {
    const payload = JSON.stringify(obj);
    for (const ws of wss.clients) {
      try {
        // 1: OPEN
        // @ts-ignore
        if (ws.readyState === 1) (ws as any).send(payload);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[ws] broadcast erro:", (e as any)?.message || e);
      }
    }
  }

  // Tenta extrair symbol/timeframe pelo nome do arquivo (fallback seguro)
  function guessFromFile(file?: string): { symbol: string; timeframe: string } {
    const base = file ? path.basename(file) : "";
    // Exemplos: WIN_M1.csv, WDO-2025-09_M5.csv, candles_WIN_M15_*.csv
    const symMatch = base.match(/\b([A-Z]{3,5})\b/);
    const tfMatch = base.match(/\b((?:M|H)\d{1,2})\b/i);
    const symbol = (symMatch?.[1] ?? "WIN").toUpperCase();
    const timeframe = (tfMatch?.[1] ?? "M1").toUpperCase();
    return { symbol, timeframe };
  }

  // === Bridge import progress events → FE (formato novo + legado)
  try {
    bus.on("import:begin", (p: any) => {
      broadcast({ type: "import:begin", payload: p }); // NOVO
      broadcast({ type: "importProgress", stage: "begin", ...p }); // LEGADO
    });
    bus.on("import:progress", (p: any) => {
      broadcast({ type: "import:progress", payload: p }); // NOVO
      broadcast({ type: "importProgress", stage: "progress", ...p }); // LEGADO
    });
    bus.on("import:done", (p: any) => {
      broadcast({ type: "import:done", payload: p }); // NOVO
      broadcast({ type: "importProgress", stage: "done", ...p }); // LEGADO

      // ===== NOVO: invalidação para forçar FE a refazer fetch (gráfico/sinais/PnL)
      const meta = {
        symbol: String(p?.symbol || "").toUpperCase(),
        timeframe: String(p?.timeframe || "").toUpperCase(),
      };
      const guess = guessFromFile(p?.file);
      const symbol = meta.symbol || guess.symbol;
      const timeframe = meta.timeframe || guess.timeframe;

      // Envia um único evento genérico com "kinds" para máxima compatibilidade
      broadcast({
        type: "data:invalidate",
        payload: {
          kinds: ["candles", "signals", "projected", "pnl"],
          symbol,
          timeframe,
          reason: "import-done",
          file: p?.file || null,
          totals: {
            total: p?.total ?? null,
            processed: p?.processed ?? null,
            inserted: p?.inserted ?? null,
            updated: p?.updated ?? null,
          },
        },
      });
    });
    bus.on("import:error", (p: any) => {
      broadcast({ type: "import:error", payload: p }); // NOVO
      broadcast({ type: "importProgress", stage: "error", ...p }); // LEGADO
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[ws] não foi possível registrar bridge de import:*:", e);
  }

  // === Heartbeat
  function noop() { }
  function heartbeat(this: any) {
    this.isAlive = true;
  }
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const symbol = url.searchParams.get("symbol") ?? "WIN";
    const timeframe = url.searchParams.get("timeframe") ?? "M5";
    clients.set(ws, { symbol, timeframe });

    // marca vivo e responde pong
    // @ts-ignore
    ws.isAlive = true;
    // @ts-ignore
    ws.on("pong", heartbeat);

    try {
      // eslint-disable-next-line no-console
      console.log(
        `[ws] conectado ${req.socket.remoteAddress} symbol=${symbol} tf=${timeframe}`
      );
      (ws as any).send(JSON.stringify({ type: "hello", symbol, timeframe }));
    } catch { }

    (ws as any).on("close", (code: number, reason: any) => {
      clients.delete(ws);
      // eslint-disable-next-line no-console
      console.log("[ws] close", code, reason?.toString?.() || "");
    });

    (ws as any).on("error", (err: any) => {
      // eslint-disable-next-line no-console
      console.error("[ws] error:", err?.message || err);
    });
  });

  // ping a cada 15s; encerra quem não responde
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      // @ts-ignore
      if (ws.isAlive === false) {
        try {
          // @ts-ignore
          console.warn("[ws] encerrando cliente inativo");
          // @ts-ignore
          return ws.terminate();
        } catch { }
      }
      // @ts-ignore
      ws.isAlive = false;
      try {
        // @ts-ignore
        ws.ping(noop);
      } catch { }
    }
  }, 15000);

  wss.on("close", () => clearInterval(interval));

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
          // 1: OPEN
          // @ts-ignore
          if (ws.readyState === 1) (ws as any).send(payload);
        } catch { }
      }
    }, 3000);
  }

  // eslint-disable-next-line no-console
  console.log("[ws] pronto em /stream");
  return wss;
}
