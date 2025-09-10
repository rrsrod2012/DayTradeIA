export type TradeDTO = {
    id: number;
    symbol: string;
    timeframe: string;
    qty: number;
    side: "BUY" | "SELL" | null;
    entrySignalId: number;
    exitSignalId: number | null;
    entryPrice: number;
    exitPrice: number | null;
    pnlPoints: number | null;
    pnlMoney: number | null;
    entryTime: string | null; // ISO
    exitTime: string | null;  // ISO
};

function apiBase() {
    return (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
}

export async function fetchTrades(params: {
    symbol?: string;
    timeframe?: string;
    from?: string; // "YYYY-MM-DD" ou ISO
    to?: string;   // "YYYY-MM-DD" ou ISO
    limit?: number;
}): Promise<TradeDTO[]> {
    const url = new URL(`${apiBase()}/api/trades`);
    if (params.symbol) url.searchParams.set("symbol", params.symbol);
    if (params.timeframe) url.searchParams.set("timeframe", params.timeframe);
    if (params.from) url.searchParams.set("from", params.from);
    if (params.to) url.searchParams.set("to", params.to);
    if (params.limit) url.searchParams.set("limit", String(params.limit));
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as TradeDTO[];
}
