import React from "react";
import { Card, Row, Col, Badge } from "react-bootstrap";

type PnLSummaryProps = {
  pnlPoints?: number | null;
  pnlMoney?: number | null;
  /** Objeto completo retornado pelo /backtest */
  result?: any;
};

type Trade = {
  side: "BUY" | "SELL" | string;
  pnl?: number;
  pnlPoints?: number;
  entryTime?: string;
  exitTime?: string;
  [k: string]: any;
};

function Metric({
  label,
  value,
  subtitle,
  variant = "light",
}: {
  label: string;
  value: string | number;
  subtitle?: string;
  variant?: string;
}) {
  return (
    <Card className="border-0 shadow-sm">
      <Card.Body className="py-3">
        <div className="d-flex justify-content-between align-items-center">
          <div>
            <div className="text-muted" style={{ fontSize: 12 }}>
              {label}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
            {subtitle && (
              <div className="text-muted" style={{ fontSize: 12 }}>
                {subtitle}
              </div>
            )}
          </div>
          <Badge bg={variant as any} pill>
            {label}
          </Badge>
        </div>
      </Card.Body>
    </Card>
  );
}

export default function PnLSummary({
  pnlPoints,
  pnlMoney,
  result,
}: PnLSummaryProps) {
  // Normaliza estrutura
  const trades: Trade[] = Array.isArray(result?.trades)
    ? result.trades
    : Array.isArray(result?.tradeList)
    ? result.tradeList
    : [];

  // Se o backend já mandou summary, usa; senão, calcula
  const s = result?.summary || {};

  const totalTrades: number =
    typeof s.trades === "number" ? s.trades : trades.length;

  const winsCount: number =
    typeof s.wins === "number"
      ? s.wins
      : trades.filter((t) => {
          const v = Number.isFinite(t.pnlPoints)
            ? (t.pnlPoints as number)
            : Number(t.pnl ?? 0);
          return v > 0;
        }).length;

  const lossesCount: number =
    typeof s.losses === "number"
      ? s.losses
      : trades.filter((t) => {
          const v = Number.isFinite(t.pnlPoints)
            ? (t.pnlPoints as number)
            : Number(t.pnl ?? 0);
          return v <= 0;
        }).length;

  const totalPnLPoints: number =
    typeof s.pnlPoints === "number"
      ? s.pnlPoints
      : typeof pnlPoints === "number"
      ? pnlPoints
      : trades.reduce((acc, t) => {
          const v = Number.isFinite(t.pnlPoints)
            ? (t.pnlPoints as number)
            : Number(t.pnl ?? 0);
          return acc + (Number.isFinite(v) ? v : 0);
        }, 0);

  const money: number =
    typeof s.pnlMoney === "number"
      ? s.pnlMoney
      : typeof pnlMoney === "number"
      ? pnlMoney
      : 0;

  const winRate: number =
    typeof s.winRate === "number"
      ? s.winRate
      : totalTrades
      ? (winsCount / totalTrades) * 100
      : 0;

  const avgPnL: number =
    typeof s.avgPnL === "number"
      ? s.avgPnL
      : totalTrades
      ? totalPnLPoints / totalTrades
      : 0;

  const maxDD: number = Number.isFinite(s.maxDrawdown) ? s.maxDrawdown : 0;

  // Formatadores seguros
  const fmtPts = (n: number) =>
    Number.isFinite(n) ? `${n.toFixed(2)} pts` : "0.00 pts";
  const fmtMoney = (n: number) =>
    Number.isFinite(n) ? `R$ ${n.toFixed(2)}` : "R$ 0,00";
  const fmtPct = (n: number) =>
    Number.isFinite(n) ? `${n.toFixed(2)}%` : "0.00%";

  return (
    <div className="d-flex flex-column gap-2">
      <Row xs={1} md={2} className="g-2">
        <Col>
          <Metric
            label="PnL (pts)"
            value={fmtPts(totalPnLPoints)}
            variant="success"
          />
        </Col>
        <Col>
          <Metric
            label="PnL (R$)"
            value={fmtMoney(money)}
            variant="secondary"
          />
        </Col>
        <Col>
          <Metric
            label="Trades"
            value={Number.isFinite(totalTrades) ? totalTrades : 0}
            variant="light"
            subtitle={`Wins: ${winsCount} • Losses: ${lossesCount}`}
          />
        </Col>
        <Col>
          <Metric label="Win Rate" value={fmtPct(winRate)} variant="info" />
        </Col>
        <Col>
          <Metric label="Avg PnL" value={fmtPts(avgPnL)} variant="warning" />
        </Col>
        <Col>
          <Metric label="Max DD" value={fmtPts(maxDD)} variant="danger" />
        </Col>
      </Row>
    </div>
  );
}
