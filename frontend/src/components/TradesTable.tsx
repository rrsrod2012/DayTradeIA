import React from "react";
import { fetchTrades, TradeDTO } from "../services/trades";

type Props = {
    symbol?: string;        // "WIN" | "WDO" ...
    timeframe?: string;     // "M1" | "M5" | "M15" | "H1"
    from?: string;          // "2025-09-01"
    to?: string;            // "2025-09-10"
    limit?: number;         // default 200
};

export default function TradesTable(props: Props) {
    const [rows, setRows] = React.useState<TradeDTO[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);

    React.useEffect(() => {
        let dead = false;
        async function run() {
            try {
                setLoading(true);
                setErr(null);
                const data = await fetchTrades({
                    symbol: props.symbol,
                    timeframe: props.timeframe,
                    from: props.from,
                    to: props.to,
                    limit: props.limit ?? 200,
                });
                if (!dead) setRows(data);
            } catch (e: any) {
                if (!dead) setErr(e?.message || String(e));
            } finally {
                if (!dead) setLoading(false);
            }
        }
        run();
        return () => {
            dead = true;
        };
    }, [props.symbol, props.timeframe, props.from, props.to, props.limit]);

    return (
        <div className="p-2">
            <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-semibold">Trades</h2>
                {loading && <span className="text-sm opacity-70">Carregando…</span>}
            </div>
            {err && (
                <div className="text-sm text-red-600 mb-2">
                    {err}
                </div>
            )}
            <div className="overflow-auto border rounded-xl">
                <table className="min-w-full text-sm">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="text-left p-2">#</th>
                            <th className="text-left p-2">Symbol</th>
                            <th className="text-left p-2">TF</th>
                            <th className="text-left p-2">Side</th>
                            <th className="text-right p-2">Qty</th>
                            <th className="text-right p-2">Entry</th>
                            <th className="text-right p-2">Exit</th>
                            <th className="text-right p-2">PnL (pts)</th>
                            <th className="text-left p-2">Entry Time</th>
                            <th className="text-left p-2">Exit Time</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 ? (
                            <tr>
                                <td colSpan={10} className="p-3 text-center text-gray-500">
                                    Sem trades no filtro atual.
                                </td>
                            </tr>
                        ) : (
                            rows.map((r) => {
                                const pnl = r.pnlPoints ?? 0;
                                const good = pnl > 0;
                                const bad = pnl < 0;
                                return (
                                    <tr key={r.id} className="border-t">
                                        <td className="p-2">{r.id}</td>
                                        <td className="p-2">{r.symbol}</td>
                                        <td className="p-2">{r.timeframe}</td>
                                        <td className="p-2">{r.side ?? "-"}</td>
                                        <td className="p-2 text-right">{r.qty}</td>
                                        <td className="p-2 text-right">{r.entryPrice?.toFixed(2)}</td>
                                        <td className="p-2 text-right">{r.exitPrice != null ? r.exitPrice.toFixed(2) : "-"}</td>
                                        <td className={`p-2 text-right ${good ? "text-green-600" : bad ? "text-red-600" : ""}`}>
                                            {r.pnlPoints != null ? r.pnlPoints.toFixed(2) : "-"}
                                        </td>
                                        <td className="p-2">{r.entryTime ? new Date(r.entryTime).toLocaleString() : "-"}</td>
                                        <td className="p-2">{r.exitTime ? new Date(r.exitTime).toLocaleString() : "-"}</td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
