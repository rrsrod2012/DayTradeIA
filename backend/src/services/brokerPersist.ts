/* backend/src/services/brokerPersist.ts
   Persistência de eventos MT5 usando Prisma (RAW SQL) sem alterar schema.prisma.
   Cria tabelas mt5_order e mt5_trade se não existirem e expõe helpers de gravação/leitura.
*/
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

export async function ensureTables() {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS mt5_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idMt5 TEXT UNIQUE,
    symbol TEXT,
    side TEXT,
    volume REAL,
    entryPrice REAL,
    entryTime TEXT,
    sl REAL,
    tp REAL,
    status TEXT DEFAULT 'OPEN'
  )`);

    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS mt5_trade (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idMt5 TEXT,
    symbol TEXT,
    side TEXT,
    volume REAL,
    entryPrice REAL,
    exitPrice REAL,
    entryTime TEXT,
    exitTime TEXT,
    exitReason TEXT,
    pnlPoints REAL,
    commission REAL,
    swap REAL,
    slippagePts REAL
  )`);

    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_mt5_trade_time ON mt5_trade(exitTime)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_mt5_trade_symbol ON mt5_trade(symbol)`);
}

export type OrderNew = {
    idMt5: string; symbol: string; side: 'BUY' | 'SELL'; volume: number;
    entryPrice: number; entryTime: string; sl?: number | null; tp?: number | null;
};
export type OrderModify = {
    idMt5: string; sl?: number | null; tp?: number | null; time?: string | null;
};
export type OrderClose = {
    idMt5: string; exitPrice: number; exitTime: string; exitReason: string;
    commission?: number | null; swap?: number | null; slippagePts?: number | null;
};

export async function recordOrderNew(ev: OrderNew) {
    await ensureTables();
    await prisma.$executeRawUnsafe(
        `INSERT INTO mt5_order (idMt5, symbol, side, volume, entryPrice, entryTime, sl, tp, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
     ON CONFLICT(idMt5) DO UPDATE SET
       symbol=excluded.symbol, side=excluded.side, volume=excluded.volume,
       entryPrice=excluded.entryPrice, entryTime=excluded.entryTime,
       sl=excluded.sl, tp=excluded.tp, status='OPEN'`,
        ev.idMt5, ev.symbol, ev.side, ev.volume, ev.entryPrice, ev.entryTime,
        ev.sl ?? null, ev.tp ?? null
    );
}

export async function recordOrderModify(ev: OrderModify) {
    await ensureTables();
    await prisma.$executeRawUnsafe(
        `UPDATE mt5_order SET sl=COALESCE(?, sl), tp=COALESCE(?, tp) WHERE idMt5 = ?`,
        ev.sl ?? null, ev.tp ?? null, ev.idMt5
    );
}

export async function recordOrderClose(ev: OrderClose) {
    await ensureTables();
    const row: any = await prisma.$queryRawUnsafe(`SELECT * FROM mt5_order WHERE idMt5 = ?`, ev.idMt5);
    const order = Array.isArray(row) ? row[0] : row;

    if (!order) {
        // se não existe, cria stub para não perder info
        await prisma.$executeRawUnsafe(
            `INSERT INTO mt5_order (idMt5, symbol, side, volume, entryPrice, entryTime, sl, tp, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CLOSED')`,
            ev.idMt5, '', 'BUY', 0, ev.exitPrice, ev.exitTime, null, null
        );
    }

    const o: any = order || { symbol: '', side: 'BUY', volume: 0, entryPrice: ev.exitPrice, entryTime: ev.exitTime };
    const pnlPoints = (o.side === 'BUY')
        ? (ev.exitPrice - Number(o.entryPrice || 0))
        : (Number(o.entryPrice || 0) - ev.exitPrice);

    await prisma.$executeRawUnsafe(
        `INSERT INTO mt5_trade
      (idMt5, symbol, side, volume, entryPrice, exitPrice, entryTime, exitTime, exitReason, pnlPoints, commission, swap, slippagePts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ev.idMt5, o.symbol, o.side, o.volume, o.entryPrice, ev.exitPrice,
        o.entryTime, ev.exitTime, ev.exitReason, pnlPoints, ev.commission ?? null, ev.swap ?? null, ev.slippagePts ?? null
    );

    await prisma.$executeRawUnsafe(`UPDATE mt5_order SET status='CLOSED' WHERE idMt5 = ?`, ev.idMt5);
}

export async function listTrades(params: { symbol?: string; from?: string; to?: string; limit?: number } = {}) {
    await ensureTables();
    const conds: string[] = [];
    const args: any[] = [];
    if (params.symbol) { conds.push('symbol = ?'); args.push(params.symbol.toUpperCase()); }
    if (params.from) { conds.push('exitTime >= ?'); args.push(params.from); }
    if (params.to) { conds.push('exitTime <= ?'); args.push(params.to); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const lim = params.limit ? ` LIMIT ${Math.max(1, params.limit)}` : '';
    const rows: any[] = await prisma.$queryRawUnsafe(`SELECT * FROM mt5_trade ${where} ORDER BY exitTime ASC${lim}`, ...args);
    return rows;
}

export async function summary(params: { symbol?: string; from?: string; to?: string } = {}) {
    const rows = await listTrades(params);
    const n = rows.length;
    let wins = 0, losses = 0, ties = 0, pnl = 0;
    for (const r of rows) {
        const p = Number(r.pnlPoints || 0);
        pnl += p;
        if (p > 0) wins++; else if (p < 0) losses++; else ties++;
    }
    const winRate = n ? (wins / n) * 100 : 0;
    const avgPnL = n ? pnl / n : 0;
    return { trades: n, wins, losses, ties, winRate, pnlPoints: pnl, avgPnL };
}
