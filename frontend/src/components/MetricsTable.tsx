import React from "react";
import { Table, Badge, OverlayTrigger, Tooltip } from "react-bootstrap";

type SideStats = {
  probHit: number;
  evPts: number;
  wins: number;
  ties: number;
  total: number;
  brierApprox: number | null;
};

type Buckets = Record<string, { BUY: SideStats; SELL: SideStats }>;

type Props = {
  buckets: Buckets;
  limit?: number; // quantos buckets exibir
};

export default function MetricsTable({ buckets, limit = 12 }: Props) {
  const entries = Object.entries(buckets)
    .filter(([, v]) => v.BUY?.total + v.SELL?.total > 0)
    .sort(
      (a, b) =>
        b[1].BUY.total + b[1].SELL.total - (a[1].BUY.total + a[1].SELL.total)
    )
    .slice(0, limit);

  const pct = (v?: number) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const fmt = (v?: number, p = 1) => (v == null ? "—" : v.toFixed(p));

  return (
    <Table size="sm" bordered hover responsive>
      <thead>
        <tr>
          <th>Bucket</th>
          <th className="text-center">BUY prob</th>
          <th className="text-center">BUY EV</th>
          <th className="text-center">BUY N (W/T/Tot)</th>
          <th className="text-center">SELL prob</th>
          <th className="text-center">SELL EV</th>
          <th className="text-center">SELL N (W/T/Tot)</th>
          <th className="text-center">Brier~</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([bk, s]) => {
          const buy = s.BUY,
            sell = s.SELL;
          const brierAvg =
            buy && buy.brierApprox != null && sell && sell.brierApprox != null
              ? (buy.brierApprox + sell.brierApprox) / 2
              : buy?.brierApprox ?? sell?.brierApprox ?? null;

          const pill = (key: string) => {
            const [tb, vol, tod] = key.split("_"); // ex.: UP_vN_o
            return (
              <>
                <Badge
                  bg={
                    tb === "UP"
                      ? "success"
                      : tb === "DOWN"
                      ? "danger"
                      : "secondary"
                  }
                  className="me-1"
                >
                  {tb}
                </Badge>
                <Badge bg="info" text="dark" className="me-1">
                  {vol}
                </Badge>
                <Badge bg="secondary">{tod}</Badge>
              </>
            );
          };

          return (
            <tr key={bk}>
              <td>
                <OverlayTrigger overlay={<Tooltip>{bk}</Tooltip>}>
                  <span style={{ cursor: "help" }}>{pill(bk)}</span>
                </OverlayTrigger>
              </td>
              <td className="text-center">
                <b>{pct(buy?.probHit)}</b>
              </td>
              <td
                className={`text-center ${
                  Number(buy?.evPts) > 0 ? "text-success" : "text-danger"
                }`}
              >
                {fmt(buy?.evPts)}
              </td>
              <td className="text-center">
                <small>
                  {buy?.wins ?? 0}/{buy?.ties ?? 0}/{buy?.total ?? 0}
                </small>
              </td>
              <td className="text-center">
                <b>{pct(sell?.probHit)}</b>
              </td>
              <td
                className={`text-center ${
                  Number(sell?.evPts) > 0 ? "text-success" : "text-danger"
                }`}
              >
                {fmt(sell?.evPts)}
              </td>
              <td className="text-center">
                <small>
                  {sell?.wins ?? 0}/{sell?.ties ?? 0}/{sell?.total ?? 0}
                </small>
              </td>
              <td className="text-center">
                <small>{brierAvg == null ? "—" : fmt(brierAvg, 3)}</small>
              </td>
            </tr>
          );
        })}
        {entries.length === 0 && (
          <tr>
            <td colSpan={8} className="text-center text-muted">
              Sem dados suficientes para métricas.
            </td>
          </tr>
        )}
      </tbody>
    </Table>
  );
}
