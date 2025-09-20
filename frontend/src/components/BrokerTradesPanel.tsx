import React, { useEffect, useState } from "react";
import { fetchBrokerTrades, BrokerTrade } from "../services/broker";

type Props = { symbol?: string; from?: string; to?: string };

function fmt(iso?: string) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return "—"; }
}

export default function BrokerTradesPanel({ symbol, from, to }: Props) {
    const [rows, setRows] = useState<BrokerTrade[]>([]);
    const [err, setErr] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                setLoading(true);
                setErr(null);
                const r = await fetchBrokerTrades({ symbol, from, to, limit: 1000 });
                if (alive) setRows(r);
            } catch (e: any) {
                if (alive) setErr(e?.message || "erro");
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [symbol, from, to]);

    if (err) return <div className="text-danger small">Erro: {err}</div>;
    return (
        <div>
            {loading && <div className="small opacity-75">Carregando trades (MT5)…</div>}
            {!loading && rows.length === 0 && <div className="small opacity-75">Sem trades MT5 no período</div>}
            {rows.length > 0 && (
                <div className="table-responsive">
                    <table className="table table-sm">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Symbol</th>
                                <th>Side</th>
                                <th>Entry</th>
                                <th>Exit</th>
                                <th>PnL (pts)</th>
                                <th>Reason</th>
                                <th>Entry time</th>
                                <th>Exit time</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.idMt5 + r.exitTime}>
                                    <td>{r.idMt5}</td>
                                    <td>{r.symbol}</td>
                                    <td>{r.side}</td>
                                    <td>{r.entryPrice}</td>
                                    <td>{r.exitPrice}</td>
                                    <td>{r.pnlPoints.toFixed(2)}</td>
                                    <td>{r.exitReason}</td>
                                    <td>{fmt(r.entryTime)}</td>
                                    <td>{fmt(r.exitTime)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
