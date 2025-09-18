// frontend/src/services/mt5.ts
// Cliente leve para a fila MT5 (microservidor Node na porta 3002 por padrão)

type EnqueueTask = {
    id: string; // único por sinal (ex: `${symbol}|${timeframe}|${iso}|${side}`)
    symbol: string;       // WIN/WDO (do seu backend)
    timeframe: string;    // M1/M5...
    side: "BUY" | "SELL";
    time: string;         // ISO do sinal confirmado
    price?: number | null;
    volume?: number | null;      // lotes (opcional, default no EA)
    slPoints?: number | null;    // SL em pontos (opcional)
    tpPoints?: number | null;    // TP em pontos (opcional)
    beAtPoints?: number | null;  // BE: quando andar X pontos
    beOffsetPoints?: number | null; // offset no BE
    comment?: string | null;
};

const MT5_BASE =
    ((import.meta as any).env?.VITE_MT5_API_BASE as string | undefined)?.replace(/\/$/, "") ||
    "http://localhost:3002"; // default para dev

async function mt5Fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${MT5_BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const resp = await fetch(url, {
        headers: { "content-type": "application/json" },
        ...init,
    });
    const txt = await resp.text();
    let data: any = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { /* ignore */ }
    if (!resp.ok || (data && data.ok === false)) {
        const msg = (data && data.error) || `HTTP ${resp.status}`;
        const err: any = new Error(msg);
        err.response = data ?? txt;
        throw err;
    }
    return (data ?? {}) as T;
}

export async function mt5GetConfig(): Promise<{ enabled: boolean, queueSize: number }> {
    return mt5Fetch("/config", { method: "GET" });
}
export async function mt5SetEnabled(enabled: boolean) {
    return mt5Fetch("/enable", { method: "POST", body: JSON.stringify({ enabled }) });
}
export async function mt5Enqueue(tasks: EnqueueTask[]) {
    return mt5Fetch("/enqueue", { method: "POST", body: JSON.stringify({ tasks }) });
}
