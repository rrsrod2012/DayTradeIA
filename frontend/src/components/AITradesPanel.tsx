// ===============================
// FILE: frontend/src/components/AITradesPanel.tsx
// ===============================
import React, { useState, useEffect } from "react";
import { Table, Card, Badge, Button } from "react-bootstrap";
import { useAIStore } from "../store/ai";
import OrderLogsModal from "./OrderLogsModal";
import { fetchTrades, TradeRow } from "../services/api";
import { useAIControls } from "./AIControlsBar";
import { formatToLocalTime } from "../core/dateUtils"; // <<< NOVA IMPORTAÇÃO

export default function AITradesPanel() {
    const { symbol, timeframe, from, to } = useAIControls();
    const [trades, setTrades] = useState<TradeRow[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedKey, setSelectedKey] = useState<string | number | null>(null);

    const load = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const data = await fetchTrades({
                symbol,
                timeframe,
                from: from || undefined,
                to: to || undefined,
                limit: 500,
            });
            setTrades(data);
        } catch (e: any) {
            setError(e.message || "Erro ao carregar trades.");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, [symbol, timeframe, from, to]);

    const pointValue = useAIStore((s) => s.trades?.pointValue ?? 1);

    return (
        <>
            <Card>
                <Card.Header>
                    <div className="d-flex justify-content-between align-items-center">
                        <strong>Trades do Backtest</strong>
                        <Button variant="outline-secondary" size="sm" onClick={load} disabled={isLoading}>
                            {isLoading ? "A carregar..." : "Recarregar"}
                        </Button>
                    </div>
                </Card.Header>
                <Card.Body className="p-0" style={{ maxHeight: 400, overflowY: "auto" }}>
                    {error && <div className="alert alert-danger m-2">{error}</div>}
                    <Table hover striped size="sm" className="mb-0">
                        <thead>
                            <tr>
                                <th>Lado</th>
                                <th>Entrada</th>
                                <th>Saída</th>
                                <th>Pontos</th>
                                <th>R$</th>
                                <th>Logs</th>
                            </tr>
                        </thead>
                        <tbody>
                            {trades.map((t) => (
                                <tr key={t.id}>
                                    <td>
                                        <Badge bg={t.side === "BUY" ? "success" : "danger"}>
                                            {t.side}
                                        </Badge>
                                    </td>
                                    {/* <<< CORREÇÃO DE FORMATAÇÃO DE HORA >>> */}
                                    <td>{formatToLocalTime(t.entryTime)}</td>
                                    <td>{formatToLocalTime(t.exitTime)}</td>
                                    <td className={Number(t.pnlPoints) >= 0 ? "text-success" : "text-danger"}>
                                        {t.pnlPoints?.toFixed(2)}
                                    </td>
                                    <td className={Number(t.pnlPoints) * pointValue >= 0 ? "text-success" : "text-danger"}>
                                        {(Number(t.pnlPoints) * pointValue).toFixed(2)}
                                    </td>
                                    <td>
                                        {t.taskId && (
                                            <Button
                                                variant="link"
                                                size="sm"
                                                className="p-0"
                                                onClick={() => setSelectedKey(t.taskId!)}
                                            >
                                                Ver
                                            </Button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </Table>
                </Card.Body>
            </Card>

            <OrderLogsModal
                show={!!selectedKey}
                handleClose={() => setSelectedKey(null)}
                orderKey={selectedKey}
            />
        </>
    );
}