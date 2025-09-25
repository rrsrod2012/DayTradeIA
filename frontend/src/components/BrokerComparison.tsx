// frontend/src/components/BrokerComparison.tsx

import React, { useEffect, useState } from "react";
import { getBrokerComparison } from "../services/api";

interface Props {
    tradeId: number;
}

export const BrokerComparison: React.FC<Props> = ({ tradeId }) => {
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const result = await getBrokerComparison(tradeId);
                setData(result);
            } catch (err) {
                console.error("Erro ao buscar comparação:", err);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [tradeId]);

    if (loading) return <div>Carregando comparação...</div>;
    if (!data?.ok) return <div>Nenhum dado encontrado para este trade.</div>;

    return (
        <div className="p-4 bg-white rounded-xl shadow-md">
            <h2 className="text-xl font-bold mb-4">Comparação Trade #{data.tradeId}</h2>

            <table className="table-auto w-full text-sm mb-6">
                <thead>
                    <tr className="bg-gray-100">
                        <th className="px-2 py-1">Campo</th>
                        <th className="px-2 py-1">Simulado</th>
                        <th className="px-2 py-1">Real</th>
                        <th className="px-2 py-1">Δ (Diferença)</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>Entrada</td>
                        <td>{data.simulated.entryPrice}</td>
                        <td>{data.real.open?.price || "-"}</td>
                        <td>{data.deltas.entrySlippagePoints} pts</td>
                    </tr>
                    <tr>
                        <td>Saída</td>
                        <td>{data.simulated.exitPrice}</td>
                        <td>{data.real.close?.price || "-"}</td>
                        <td>{data.deltas.exitSlippagePoints} pts</td>
                    </tr>
                    <tr>
                        <td>PnL</td>
                        <td>{data.simulated.pnlPoints} pts</td>
                        <td>{data.real.pnlPoints || "-"}</td>
                        <td>
                            {data.real.pnlPoints && data.simulated.pnlPoints
                                ? data.real.pnlPoints - data.simulated.pnlPoints
                                : "-"} pts
                        </td>
                    </tr>
                    <tr>
                        <td>Latência Execução</td>
                        <td colSpan={2}>-</td>
                        <td>{data.deltas.latencyMs} ms</td>
                    </tr>
                </tbody>
            </table>

            <h3 className="text-lg font-semibold mb-2">Execuções do Broker</h3>
            <ul className="list-disc ml-5">
                {data.executions.map((exec: any) => (
                    <li key={exec.id}>
                        [{exec.type}] {exec.time} - Preço: {exec.price} - Quantidade: {exec.quantity}
                    </li>
                ))}
            </ul>
        </div>
    );
};
