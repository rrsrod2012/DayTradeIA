// Cliente do microserviço MT5
// Endereço pode ser configurado via VITE_MT5_BASE (ex.: http://localhost:8088)
const RAW_MT5_BASE = (import.meta as any).env?.VITE_MT5_BASE ?? "";
const MT5_BASE = String(RAW_MT5_BASE || "").replace(/\/$/, "");

type EnqueueItem = {
    id?: string; // opcional no servidor
    symbol: string;
    timeframe?: string;
    side: "BUY" | "SELL";
    time?: string; // ISO
    price?: number | null;
    volume?: number | null;
    slPoints?: number | null;
    tpPoints?: number | null;
    beAtPoints?: number | null;
    beOffsetPoints?: number | null;
    comment?: string | null;
};

async function mt5JsonFetch<T>(
    path: string,
    init?: RequestInit
): Promise<T> {
    const base =
        MT5_BASE || window.location.origin.replace(/\/$/, "");
    const url = base + (path.startsWith("/") ? path : `/${path}`);
    const resp = await fetch(url, {
        headers: { "content-type": "application/json", ...(init?.headers || {}) },
        credentials: "omit",
        mode: "cors",
        cache: "no-cache",
        ...init,
    });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : null;
    if (!resp.ok || (data && data.ok === false)) {
        const msg = (data && (data.error || data.message)) || `HTTP ${resp.status} ${resp.statusText}`;
        const err: any = new Error(msg);
        (err as any).response = data ?? text;
        throw err;
    }
    return data as T;
}

export async function mt5SetEnabled(enabled: boolean) {
    try {
        // endpoint opcional: ignore se não existir
        await mt5JsonFetch<any>("/exec/enabled", {
            method: "POST",
            body: JSON.stringify({ enabled }),
        });
    } catch {
        // silencioso — não é crítico
    }
}

export async function mt5Enqueue(items: EnqueueItem[]) {
    if (!Array.isArray(items) || items.length === 0) return { ok: true, queued: 0 };
    return mt5JsonFetch<{ ok: boolean; queued: number }>("/exec/enqueue", {
        method: "POST",
        body: JSON.stringify({ items }),
    });
}

export async function mt5Ping() {
    try {
        return await mt5JsonFetch<{ ok: boolean; ts?: string }>("/exec/ping", {
            method: "GET",
        });
    } catch (e) {
        return { ok: false };
    }
}
