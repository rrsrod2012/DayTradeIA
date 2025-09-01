import React, { useMemo } from "react";
import { Table, Badge } from "react-bootstrap";

type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};
type Signal = {
  time: string;
  signalType: "ENTRY" | "EXIT";
  side: "BUY" | "SELL" | "FLAT";
  price: number;
  reason?: string;
  score?: number;
};

type Props = {
  signals: Signal[];
  candles: Candle[];
};

// Busca índice do candle pela data/hora (ISO ou "YYYY-MM-DD HH:mm:ss")
function findCandleIndex(candles: Candle[], iso: string) {
  const t = iso.includes(" ") ? iso.replace(" ", "T") : iso;
  const target = new Date(t).getTime();
  for (let i = 0; i < candles.length; i++) {
    const ct = new Date(
      candles[i].time.includes(" ")
        ? candles[i].time.replace(" ", "T")
        : candles[i].time
    ).getTime();
    if (ct === target) return i;
  }
  // fallback: aproxima pelo mais próximo <= target
  let idx = -1;
  for (let i = 0; i < candles.length; i++) {
    const ct = new Date(
      candles[i].time.includes(" ")
        ? candles[i].time.replace(" ", "T")
        : candles[i].time
    ).getTime();
    if (ct <= target) idx = i;
    else break;
  }
  return idx;
}

function rrTakeProfit(
  entry: number,
  stop: number,
  side: "BUY" | "SELL",
  rr = 2
) {
  const risk = Math.abs(entry - stop);
  if (risk === 0 || !isFinite(risk)) return undefined;
  return side === "BUY" ? entry + rr * risk : entry - rr * risk;
}

/**
 * Calcula sugestões:
 *  - Entrada sugerida: o preço do próprio sinal ENTRY (s.price)
 *  - Stop (desistência) para ENTRY:
 *      BUY  -> menor mínima dos últimos N candles (default 10) antes do sinal
 *      SELL -> maior máxima dos últimos N candles (default 10) antes do sinal
 *  - Saída sugerida (alvo): RR 2:1 em relação ao stop
 *  - Para EXIT: exibe somente "Saída no sinal"
 */
function useSuggestions(signals: Signal[], candles: Candle[], lookback = 10) {
  return useMemo(() => {
    return signals.map((s) => {
      if (s.signalType === "ENTRY" && (s.side === "BUY" || s.side === "SELL")) {
        const idx = findCandleIndex(candles, s.time);
        const start = Math.max(0, idx - lookback);
        const window = candles.slice(start, idx + 1);

        let stop: number | undefined;
        if (s.side === "BUY") {
          stop = Math.min(...window.map((c) => c.low));
        } else {
          stop = Math.max(...window.map((c) => c.high));
        }
        if (!isFinite(stop)) stop = undefined;

        const tp =
          stop !== undefined
            ? rrTakeProfit(s.price, stop, s.side, 2)
            : undefined;

        return {
          ...s,
          suggestedEntry: s.price,
          suggestedExit: tp, // alvo RR 2:1
          suggestedStop: stop, // desistência
        };
      }

      // Para EXIT: mostramos a saída conforme o preço do sinal
      return {
        ...s,
        suggestedEntry: undefined,
        suggestedExit: s.price,
        suggestedStop: undefined,
      };
    });
  }, [signals, candles, lookback]);
}

export default function SignalsTable({ signals, candles }: Props) {
  const enriched = useSuggestions(signals, candles);

  return (
    <Table striped bordered hover size="sm" responsive>
      <thead>
        <tr>
          <th>Hora</th>
          <th>Tipo</th>
          <th>Lado</th>
          <th>Preço Sinal</th>
          <th>Entrada Sugerida</th>
          <th>Saída Sugerida</th>
          <th>Desistência (Stop)</th>
          <th>Motivo</th>
        </tr>
      </thead>
      <tbody>
        {enriched.map((s, i) => {
          const dt = new Date(
            s.time.includes(" ") ? s.time.replace(" ", "T") : s.time
          );
          const hh = String(dt.getHours()).padStart(2, "0");
          const mm = String(dt.getMinutes()).padStart(2, "0");
          const labelTime = `${hh}:${mm}`;

          const tipo =
            s.signalType === "ENTRY" ? (
              <Badge bg={s.side === "BUY" ? "success" : "danger"}>ENTRY</Badge>
            ) : (
              <Badge bg="secondary">EXIT</Badge>
            );

          const lado =
            s.side === "BUY" ? (
              <Badge bg="success">BUY</Badge>
            ) : s.side === "SELL" ? (
              <Badge bg="danger">SELL</Badge>
            ) : (
              <Badge bg="secondary">FLAT</Badge>
            );

          const fmt = (v?: number) =>
            v !== undefined && isFinite(v) ? Math.round(v).toString() : "—";

          return (
            <tr key={i}>
              <td>{labelTime}</td>
              <td>{tipo}</td>
              <td>{lado}</td>
              <td>{fmt(s.price)}</td>
              <td>{fmt((s as any).suggestedEntry)}</td>
              <td>{fmt((s as any).suggestedExit)}</td>
              <td>{fmt((s as any).suggestedStop)}</td>
              <td style={{ maxWidth: 240 }}>{s.reason || "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
