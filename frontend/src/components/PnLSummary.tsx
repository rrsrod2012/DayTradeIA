import React from "react";
import { Card, Row, Col, Badge } from "react-bootstrap";

type Trade = {
  pnl?: number;
  pnlPoints?: number;
};

type Summary = {
  trades?: number;
  wins?: number;
  losses?: number;
  ties?: number;
  winRate?: number;
  pnlPoints?: number;
  avgPnL?: number;
  profitFactor?: number;
};

type ResultPayload = {
  summary?: Summary;
  trades?: Trade[];
  tradeList?: Trade[];
  pnlPoints?: number;
  pnlMoney?: number;
};

type Props = {
  pnlPoints?: number;
  pnlMoney?: number;
  /** Resultado bruto do backtest (usado para extrair summary/trades) */
  result?: ResultPayload | null;
};

function formatNumber(n: number | undefined | null, decimals = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return "-";
  return n.toLocaleString(undefined, {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

function computeSummaryFromTrades(trades: Trade[]): Summary {
  const toPts = (t: Trade) =>
    typeof t.pnlPoints === "number"
      ? t.pnlPoints
      : typeof t.pnl === "number"
      ? t.pnl
      : 0;

  const total = trades.length;
  const pnlPoints = trades.reduce((acc, t) => acc + toPts(t), 0);
  const wins = trades.filter((t) => toPts(t) > 0).length;
  const losses = trades.filter((t) => toPts(t) < 0).length;
  const ties = trades.filter((t) => toPts(t) === 0).length;
  const avgPnL = total ? pnlPoints / total : 0;

  const grossProfit = trades
    .filter((t) => toPts(t) > 0)
    .reduce((a, t) => a + toPts(t), 0);
  const grossLoss = trades
    .filter((t) => toPts(t) < 0)
    .reduce((a, t) => a + toPts(t), 0);
  const profitFactor =
    grossLoss !== 0
      ? grossProfit / Math.abs(grossLoss)
      : grossProfit > 0
      ? Infinity
      : 0;

  return {
    trades: total,
    wins,
    losses,
    ties,
    winRate: total ? (wins / total) * 100 : 0,
    pnlPoints,
    avgPnL,
    profitFactor,
  };
}

export default function PnLSummary({ pnlPoints, pnlMoney, result }: Props) {
  // Prioriza summary do backend; caso não exista, computa a partir dos trades
  const tradesArr = (result?.trades || result?.tradeList || []) as Trade[];
  const summary =
    result?.summary && typeof result.summary === "object"
      ? result.summary
      : computeSummaryFromTrades(tradesArr);

  const totalTrades = summary?.trades ?? tradesArr.length;
  const wins = summary?.wins ?? 0;
  const losses = summary?.losses ?? 0;
  const ties = summary?.ties ?? 0;
  const winRate =
    summary?.winRate ?? (totalTrades ? (wins / totalTrades) * 100 : 0);
  const pf = summary?.profitFactor;

  // Fallbacks para PnL total
  const totalPoints =
    typeof summary?.pnlPoints === "number"
      ? summary?.pnlPoints
      : typeof pnlPoints === "number"
      ? pnlPoints
      : tradesArr.reduce((acc, t) => acc + (t.pnlPoints ?? t.pnl ?? 0), 0);

  return (
    <Card className="shadow-sm">
      <Card.Body>
        <Row className="gy-3">
          <Col xs={6} md={4}>
            <div className="text-muted small">PnL (pts)</div>
            <div
              className={`fs-5 fw-semibold ${
                totalPoints >= 0 ? "text-success" : "text-danger"
              }`}
            >
              {formatNumber(totalPoints, 2)}
            </div>
          </Col>
          <Col xs={6} md={4}>
            <div className="text-muted small">PnL (R$)</div>
            <div
              className={`fs-5 fw-semibold ${
                Number(pnlMoney) >= 0 ? "text-success" : "text-danger"
              }`}
            >
              {formatNumber(pnlMoney, 2)}
            </div>
          </Col>
          <Col xs={6} md={4}>
            <div className="text-muted small">Trades</div>
            <div className="fs-5 fw-semibold">{totalTrades || 0}</div>
          </Col>

          <Col xs={6} md={3}>
            <div className="text-muted small">Vitórias</div>
            <div className="fs-6 fw-semibold">
              <Badge bg="success" pill>
                {wins}
              </Badge>
            </div>
          </Col>
          <Col xs={6} md={3}>
            <div className="text-muted small">Derrotas</div>
            <div className="fs-6 fw-semibold">
              <Badge bg="danger" pill>
                {losses}
              </Badge>
            </div>
          </Col>
          <Col xs={6} md={3}>
            <div className="text-muted small">Empates</div>
            <div className="fs-6 fw-semibold">
              <Badge bg="secondary" pill>
                {ties}
              </Badge>
            </div>
          </Col>
          <Col xs={6} md={3}>
            <div className="text-muted small">Win Rate</div>
            <div className="fs-6 fw-semibold">{formatNumber(winRate, 2)}%</div>
          </Col>

          <Col xs={6} md={4}>
            <div className="text-muted small">Profit Factor</div>
            <div className="fs-6 fw-semibold">
              {pf === Infinity ? "∞" : formatNumber(pf ?? 0, 2)}
            </div>
          </Col>
          <Col xs={6} md={4}>
            <div className="text-muted small">Médio por trade (pts)</div>
            <div className="fs-6 fw-semibold">
              {formatNumber(summary?.avgPnL ?? 0, 2)}
            </div>
          </Col>
          <Col xs={12} md={4}>
            <div className="text-muted small">Observação</div>
            <div className="small">
              <span className="text-muted">
                PF &gt; 1 indica estratégia positiva; empates não entram no
                cálculo.
              </span>
            </div>
          </Col>
        </Row>
      </Card.Body>
    </Card>
  );
}
