import React, { useEffect, useMemo, useState } from "react";
import AIControlsBar from "./components/AIControlsBar";
import AIProjectedPanel from "./components/AIProjectedPanel";
import AIConfirmedPanel from "./components/AIConfirmedPanel";
import AIPnLPanel from "./components/AIPnLPanel";
import AIChartWithMarkers from "./components/AIChartWithMarkers";
import ImportProgress from "./components/ImportProgress";
import { AIControlsProvider } from "./components/AIControlsContext";
import { BrokerComparison } from "./components/BrokerComparison";

// NOVO: tabela de trades (usa /api/trades)
import AITradesPanel from "./components/AITradesPanel";

/**
 * Seção simples para validar trades manualmente via tradeId
 * - Lê ?tradeId= da URL (se existir)
 * - Permite digitar/colar um id para abrir o BrokerComparison
 */
function TradesValidation() {
  const [inputId, setInputId] = useState<string>("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Prefill a partir da URL (?tradeId=123)
  useEffect(() => {
    try {
      const qs = new URLSearchParams(window.location.search);
      const idStr = qs.get("tradeId");
      if (idStr) {
        const n = Number(idStr);
        if (Number.isFinite(n)) {
          setSelectedId(n);
          setInputId(String(n));
        }
      }
    } catch {}
  }, []);

  const adminUrl = useMemo(() =>
    selectedId ? `/admin/broker/compare-detailed?tradeId=${selectedId}` : "#",
  [selectedId]);

  return (
    <div className="mx-auto max-w-6xl w-full px-4 sm:px-6 lg:px-8 mt-8">
      <div className="rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 bg-white">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Validação de Trades</h2>
            <p className="text-sm text-gray-500">Digite um <code>tradeId</code> para abrir a comparação de execução (logs por corretora).</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              className="border rounded-xl px-3 py-2 text-sm w-40"
              placeholder="tradeId"
              value={inputId}
              onChange={(e) => setInputId(e.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
            />
            <button
              className="rounded-2xl px-4 py-2 text-sm font-medium border border-gray-300 hover:bg-gray-50"
              onClick={() => {
                const n = Number(inputId);
                if (Number.isFinite(n)) setSelectedId(n);
              }}
            >
              Validar
            </button>
          </div>
        </div>

        {selectedId ? (
          <div className="mt-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm text-gray-600">
                Validando <span className="font-mono font-medium">tradeId={selectedId}</span>
              </div>
              <a
                href={adminUrl}
                className="text-sm underline text-blue-600 hover:text-blue-700"
                target="_blank"
                rel="noreferrer"
              >
                Abrir em /admin
              </a>
            </div>
            {/* Mostra comparação detalhada dos logs para o trade selecionado */}
            <BrokerComparison tradeId={selectedId} />
          </div>
        ) : (
          <div className="mt-3 text-sm text-gray-500">Nenhum trade selecionado.</div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AIControlsProvider>
      {/* Progresso de importação de CSV */}
      <ImportProgress />

      {/* Barra fixa com calendário, seletor de tipo e PnL */}
      <AIControlsBar collapsedByDefault />

      {/* Gráfico com marcadores dos dois tipos */}
      <AIChartWithMarkers />

      {/* Tabelas */}
      <AIProjectedPanel />
      <AIConfirmedPanel />


      {/* Resumo de PnL (backtest) */}
      <AIPnLPanel />

      {/* NOVO: Tabela de Trades consolidando sinais confirmados */}
      <AITradesPanel />

      {/* Validação (comparação de execução por corretora) */}
      <TradesValidation />
    </AIControlsProvider>
  );
}
