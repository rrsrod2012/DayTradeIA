import React from "react";
import { Row, Col, Card } from "react-bootstrap";
import EquitySparkline from "./EquitySparkline";

type BacktestSummary = {
  trades?: number;
  wins?: number;
  losses?: number;
  winRate?: number; // 0..1
  pnlPoints?: number;
  pnlMoney?: number;
  profitFactor?: number | string;
  maxDrawdownPoints?: number;
  equityCurve?: { time: string; equity: number }[];
};

type Props =
  | {
      pnlPoints?: number; // compat antigo
      pnlMoney?: number; // compat antigo
      details?: BacktestSummary | null;
    }
  | undefined;

function Metric({
  title,
  value,
  suffix = "",
}: {
  title: string;
  value: React.ReactNode;
  suffix?: string;
}) {
  return (
    <Card className="shadow-sm h-100">
      <Card.Body>
        <div className="text-muted" style={{ fontSize: 12 }}>
          {title}
        </div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>
          {value}
          {suffix}
        </div>
      </Card.Body>
    </Card>
  );
}

export default function PnLSummary(props: Props) {
  const d: BacktestSummary = props?.details ?? {};
  const pnlPoints = d.pnlPoints ?? props?.pnlPoints ?? 0;
  const pnlMoney = d.pnlMoney ?? props?.pnlMoney ?? 0;

  const winRatePct =
    typeof d.winRate === "number" && isFinite(d.winRate)
      ? `${(d.winRate * 100).toFixed(1)}%`
      : "-";

  const profitFactor =
    d.profitFactor === Infinity
      ? "∞"
      : typeof d.profitFactor === "number"
      ? d.profitFactor.toFixed(3)
      : d.profitFactor ?? "-";

  return (
    <div className="w-100">
      <Row className="g-2 w-100">
        <Col xs={6} md={3}>
          <Metric title="Trades" value={d.trades ?? 0} />
        </Col>
        <Col xs={6} md={3}>
          <Metric title="Vitórias" value={d.wins ?? 0} />
        </Col>
        <Col xs={6} md={3}>
          <Metric title="Derrotas" value={d.losses ?? 0} />
        </Col>
        <Col xs={6} md={3}>
          <Metric title="Taxa de Acerto" value={winRatePct} />
        </Col>

        <Col xs={6} md={3}>
          <Metric title="PnL (pts)" value={pnlPoints} />
        </Col>
        <Col xs={6} md={3}>
          <Metric title="PnL (R$)" value={pnlMoney} />
        </Col>
        <Col xs={6} md={3}>
          <Metric title="Profit Factor" value={profitFactor} />
        </Col>
        <Col xs={6} md={3}>
          <Metric
            title="Máx. Drawdown (pts)"
            value={d.maxDrawdownPoints != null ? d.maxDrawdownPoints : "-"}
          />
        </Col>

        {/* Mini gráfico de equity */}
        <Col xs={12} className="mt-1">
          <Card className="shadow-sm">
            <Card.Body>
              <div
                className="text-muted"
                style={{ fontSize: 12, marginBottom: 4 }}
              >
                Equity (pts)
              </div>
              <EquitySparkline data={d.equityCurve ?? []} height={80} />
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
