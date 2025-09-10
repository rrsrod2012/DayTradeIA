import React, { useEffect, useMemo, useState } from "react";
// IMPORTANTE: assumindo que o AIControlsBar expõe o estado global via este hook.
// Caso o seu hook tenha outro nome/caminho, me avise que eu mando a versão correspondente.
import { useAIControls } from "./AIControlsBar";

type TradeRow = {
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

function fmtTime(iso: string | null) {
    if (!iso) return "-";
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "-";
        // Mostra em horário local do navegador (ok para UI)
        return d.toLocaleString();
    } catch {
        return "-";
    }
}

function withinRange(iso: string | null, from?: string, to?: string) {
    if (!iso) return false;
    try {
        const t = new Date(iso).getTime();
        if (!Number.isFinite(t)) return false;

        // Se vierem strings vindas do AIControlsBar, o backend já entende “dd/MM/yyyy” e ISO.
        // Aqui no cliente só checamos de forma defensiva:
        const f = from ? new Date(from).getTime() : NaN;
        const tt = to ? new Date(to).getTime() : NaN;

        // Quando usuário escolhe apenas a data (sem hora), seu backend expande o dia todo.
        // Para o cliente ficar coerente, se "to" for só data, considere fim do dia:
        let tFrom = Number.isFinite(f) ? f : -Infinity;
        let tTo = Number.isFinite(tt) ? tt : Infinity;

        // heurística simples: se `to` parecer ISO só com data, empurra para 23:59:59.999
        if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
            const end = new Date(to + "T23:59:59.999");
            if (Number.isFinite(end.getTime())) tTo = end.getTime();
        }
        return t >= tFrom && t <= tTo;
    } catch {
        return false;
    }
}

export default function AITradesPanel() {
    const { symbol, timeframe, from, to } = useAIControls(); // <- estado global de filtros
    const [rows, setRows] = useState<TradeRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                setLoading(true);
                setErr(null);

                const params = new URLSearchParams();
                if (symbol) params.set("symbol", String(symbol).toUpperCase());
                if (timeframe) params.set("timeframe", String(timeframe).toUpperCase());
                // Passa o range para o backend (que já expande “dia inteiro” se vier só a data):
                if (from) params.set("from", String(from));
                if (to) params.set("to", String(to));
                params.set("limit", "500"); // margem

                const resp = await fetch(`/api/trades?${params.toString()}`);
                const data = await resp.json();

                if (!cancelled) {
                    if (Array.isArray(data)) setRows(data as TradeRow[]);
                    else if (data?.ok === false && data?.error) {
                        setErr(String(data.error));
                        setRows([]);
                    } else {
                        setRows([]);
                    }
                }
            } catch (e: any) {
                if (!cancelled) {
                    setErr(e?.message || "erro ao carregar");
                    setRows([]);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        load();
        return () => {
            cancelled = true;
        };
    }, [symbol, timeframe, from, to]);

    // Filtro defensivo no cliente (garante consistência caso /api/trades um dia mude)
    const filtered = useMemo(() => {
        if (!rows?.length) return [];
        return rows.filter((r) => withinRange(r.entryTime, from, to));
    }, [rows, from, to]);

    return (
        <div className="p-4">
            <h2 className="text-lg font-semibold mb-2">Trades</h2>

            {loading && (
                <div className="text-sm opacity-70 mb-2">Carregando trades…</div>
            )}
            {err && (
                <div className="text-sm text-red-600 mb-2">Erro: {err}</div>
            )}

            {!loading && !err && filtered.length === 0 && (
                <div className="text-sm opacity-70">Sem trades no filtro atual.</div>
            )}

            {!loading && !err && filtered.length > 0 && (
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="text-left border-b">
                                <th className="py-2 pr-4">#</th>
                                <th className="py-2 pr-4">Symbol</th>
                                <th className="py-2 pr-4">TF</th>
                                <th className="py-2 pr-4">Side</th>
                                <th className="py-2 pr-4">Qty</th>
                                <th className="py-2 pr-4">Entry</th>
                                <th className="py-2 pr-4">Exit</th>
                                <th className="py-2 pr-4">PnL (pts)</th>
                                <th className="py-2 pr-4">Entry Time</th>
                                <th className="py-2 pr-4">Exit Time</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((r) => (
                                <tr key={r.id} className="border-b hover:bg-black/5">
                                    <td className="py-2 pr-4">{r.id}</td>
                                    <td className="py-2 pr-4">{r.symbol}</td>
                                    <td className="py-2 pr-4">{r.timeframe}</td>
                                    <td className="py-2 pr-4">{r.side ?? "-"}</td>
                                    <td className="py-2 pr-4">{r.qty}</td>
                                    <td className="py-2 pr-4">{Number.isFinite(r.entryPrice) ? r.entryPrice : "-"}</td>
                                    <td className="py-2 pr-4">{r.exitPrice ?? "-"}</td>
                                    <td className="py-2 pr-4">{r.pnlPoints ?? "-"}</td>
                                    <td className="py-2 pr-4">{fmtTime(r.entryTime)}</td>
                                    <td className="py-2 pr-4">{fmtTime(r.exitTime)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
