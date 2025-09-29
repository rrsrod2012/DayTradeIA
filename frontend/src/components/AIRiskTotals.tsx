import React, { useEffect, useMemo, useState } from "react";

/**
 * Componente para exibir Ganhos, Perdas e PnL diário (em pontos),
 * consumindo GET /broker/risk/state do backend.
 *
 * - Usa VITE_API_BASE como base (ex.: http://127.0.0.1:3000)
 * - Atualiza automaticamente a cada 5s
 * - Estilo neutro com Tailwind; ajuste como quiser
 */
type RiskState = {
    ok: boolean;
    mode: "block" | "conservative";
    dailyPnL: number;
    pontosGanhos: number;
    pontosPerdidos: number; // negativo
    hitLoss: boolean;
    hitProfit: boolean;
    maxLoss?: number | null;
    profitTarget?: number | null;
};

const API_BASE = import.meta.env.VITE_API_BASE || "";

export default function AIRiskTotals() {
    const [data, setData] = useState<RiskState | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchState = async () => {
        setErr(null);
        try {
            const res = await fetch(`${API_BASE}/broker/risk/state`, { method: "GET" });
            const json = await res.json();
            setData(json as RiskState);
        } catch (e: any) {
            setErr(e?.message || "Falha ao carregar");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchState();
        const id = setInterval(fetchState, 5000);
        return () => clearInterval(id);
    }, []);

    const gains = useMemo(() => data?.pontosGanhos ?? 0, [data]);
    const losses = useMemo(() => data?.pontosPerdidos ?? 0, [data]); // negativo
    const pnl = useMemo(() => data?.dailyPnL ?? 0, [data]);

    const badge = useMemo(() => {
        if (!data) return null;
        if (data.hitLoss) return <span className="ml-2 px-2 py-0.5 rounded bg-red-100 text-red-800 text-xs">Stop diário atingido</span>;
        if (data.hitProfit) return <span className="ml-2 px-2 py-0.5 rounded bg-green-100 text-green-800 text-xs">Meta diária atingida</span>;
        if (data.mode === "conservative") return <span className="ml-2 px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-xs">Modo conservador</span>;
        return null;
    }, [data]);

    return (
        <div className="w-full">
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold">
                    Resultado do Dia (pontos)
                    {badge}
                </h3>
                <button
                    onClick={fetchState}
                    className="text-xs px-2 py-1 rounded border hover:bg-gray-50"
                    title="Atualizar agora"
                >
                    Atualizar
                </button>
            </div>

            {loading ? (
                <div className="text-sm text-gray-500">Carregando…</div>
            ) : err ? (
                <div className="text-sm text-red-600">Erro: {err}</div>
            ) : (
                <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-2xl border p-3">
                        <div className="text-xs text-gray-500">Ganhos</div>
                        <div className="mt-1 text-lg font-bold text-green-700">+{gains.toLocaleString("pt-BR")}</div>
                    </div>
                    <div className="rounded-2xl border p-3">
                        <div className="text-xs text-gray-500">Perdas</div>
                        <div className="mt-1 text-lg font-bold text-red-700">{losses.toLocaleString("pt-BR")}</div>
                    </div>
                    <div className="rounded-2xl border p-3">
                        <div className="text-xs text-gray-500">PnL do dia</div>
                        <div className={`mt-1 text-lg font-bold ${pnl >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                            {pnl >= 0 ? "+" : ""}{pnl.toLocaleString("pt-BR")}
                        </div>
                    </div>
                </div>
            )}

            {data && (data.maxLoss != null || data.profitTarget != null) && (
                <div className="mt-2 text-[11px] text-gray-500">
                    Limites: {data.maxLoss != null && <span>Stop {data.maxLoss} </span>}
                    {data.maxLoss != null && data.profitTarget != null && <span className="mx-1">•</span>}
                    {data.profitTarget != null && <span>Meta {data.profitTarget}</span>}
                </div>
            )}
        </div>
    );
}
