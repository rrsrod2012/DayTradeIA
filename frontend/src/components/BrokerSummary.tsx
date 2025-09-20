import React, { useEffect, useState } from "react";
import { fetchBrokerSummary } from "../services/broker";

type Props = { symbol?: string; from?: string; to?: string };

export default function BrokerSummary({ symbol, from, to }: Props) {
    const [data, setData] = useState<any>(null);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                setErr(null);
                const r = await fetchBrokerSummary({ symbol, from, to });
                if (alive) setData(r);
            } catch (e: any) {
                if (alive) setErr(e?.message || "erro");
            }
        })();
        return () => { alive = false; };
    }, [symbol, from, to]);

    if (err) return <div className="text-danger small">Erro: {err}</div>;
    if (!data) return <div className="small opacity-75">Carregando PnL (MT5)…</div>;

    return (
        <div className="d-flex gap-3 flex-wrap">
            <div><strong>Trades:</strong> {data.trades}</div>
            <div><strong>WinRate:</strong> {Number(data.winRate || 0).toFixed(1)}%</div>
            <div><strong>Wins:</strong> {data.wins}</div>
            <div><strong>Losses:</strong> {data.losses}</div>
            <div><strong>Ties:</strong> {data.ties}</div>
            <div><strong>PnL (pts):</strong> {Number(data.pnlPoints || 0).toFixed(2)}</div>
            <div><strong>Avg (pts):</strong> {Number(data.avgPnL || 0).toFixed(2)}</div>
        </div>
    );
}
