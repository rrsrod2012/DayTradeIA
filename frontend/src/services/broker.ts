// frontend/src/services/broker.ts
const RAW_BROKER_BASE = (import.meta as any).env?.VITE_BROKER_BASE ?? "";
const BROKER_BASE = String(RAW_BROKER_BASE || "").replace(/\/$/, "");

export type BrokerTrade = {
    idMt5: string;
    symbol: string;
    side: "BUY" | "SELL";
    volume: number;
    entryPrice: number;
    exitPrice: number;
    entryTime: string;
    exitTime: string;
    exitReason: string;
    pnlPoints: number;
    commission?: number | null;
    swap?: number | null;
    slippagePts?: number | null;
};

function q(params: Record<string, any>) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v == null || v === "") continue;
        usp.set(k, String(v));
    }
    return usp.toString();
}

async function j<T>(path: string) {
    const base = BROKER_BASE || window.location.origin.replace(/\/$/, "");
    const url = base + (path.startsWith("/") ? path : `/${path}`);
    const resp = await fetch(url, { cache: "no-store" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || (data && data.ok === false)) throw new Error(data?.error || resp.statusText);
    return data as T;
}

export async function fetchBrokerTrades(opts: { symbol?: string; from?: string; to?: string; limit?: number } = {}): Promise<BrokerTrade[]> {
    const qs = q(opts);
    return await j<BrokerTrade[]>(`/api/broker/trades${qs ? `?${qs}` : ""}`);
}

export async function fetchBrokerSummary(opts: { symbol?: string; from?: string; to?: string } = {}) {
    const qs = q(opts);
    return await j<any>(`/api/broker/summary${qs ? `?${qs}` : ""}`);
}
