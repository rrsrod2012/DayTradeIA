import React from "react";
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

      {/* Exemplo: comparar trade #123 */}
      <BrokerComparison tradeId={123} />
    </AIControlsProvider>
  );
}
