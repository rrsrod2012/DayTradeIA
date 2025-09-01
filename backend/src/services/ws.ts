import type { Server } from 'http';
import { WebSocketServer } from 'ws';

type ClientInfo = { symbol: string; timeframe: string };

export function setupWS(server: Server) {
  const wss = new WebSocketServer({ server, path: '/stream' });
  const clients = new Map<any, ClientInfo>();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const symbol = url.searchParams.get('symbol') ?? 'WIN';
    const timeframe = url.searchParams.get('timeframe') ?? 'M5';
    clients.set(ws, { symbol, timeframe });

    ws.send(JSON.stringify({ type: 'hello', symbol, timeframe }));

    ws.on('close', () => clients.delete(ws));
  });

  // Simple simulator when SIMULATE=1
  if (process.env.SIMULATE === '1') {
    let last = 129000;
    setInterval(() => {
      const o = last;
      const c = last + Math.round((Math.random() - 0.5) * 60);
      const h = Math.max(o, c) + Math.round(Math.random() * 30);
      const l = Math.min(o, c) - Math.round(Math.random() * 30);
      last = c;
      const payload = JSON.stringify({
        type: 'candle',
        symbol: 'WIN',
        timeframe: 'M5',
        candle: { time: new Date().toISOString(), o, h, l, c, v: Math.round(100 + Math.random() * 400) }
      });
      for (const ws of wss.clients) {
        try { ws.send(payload); } catch {}
      }
    }, 3000);
  }

  return wss;
}
