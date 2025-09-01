import React from "react";
import {
  Table,
  Badge,
  OverlayTrigger,
  Tooltip,
  ProgressBar,
} from "react-bootstrap";

type Projected = {
  side: "BUY" | "SELL" | "FLAT";
  suggestedEntry: number;
  conditionText: string;
  validCandles: number;
  expiresAt?: string;
  rationale: string;
  stopSuggestion?: number;
  takeProfitSuggestion?: number;
  score?: number;
  probHit?: number;
  probCalibrated?: number;
  expectedValuePoints?: number;
  volatilityAtr?: number;
  bbWidthNow?: number;
  probModel?: number;
  partialTake?: boolean;
  trailAtr?: number | null;
  timeoutCandles?: number | null;
  hiQ20?: number;
  hiQ50?: number;
  hiQ80?: number;
  loQ20?: number;
  loQ50?: number;
  loQ80?: number;
  transitionRisk?: number;
  meta?: {
    trendBias: "UP" | "DOWN" | "SIDEWAYS";
    volZ?: number;
    todWindow?: string;
    vwapNow?: number;
    bbPercent?: number;
    bucketKey?: string;
  };
};

type Props = { items: Projected[] };

export default function ProjectedSignalsTable({ items }: Props) {
  const fmt = (v?: number) =>
    v !== undefined && v !== null && isFinite(v)
      ? Math.round(v).toString()
      : "—";
  const fmt1 = (v?: number) =>
    v !== undefined && v !== null && isFinite(v) ? v.toFixed(1) : "—";
  const fmt2 = (v?: number, p = 2) =>
    v !== undefined && v !== null && isFinite(v) ? v.toFixed(p) : "—";
  const fmtDate = (iso?: string) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };
  const pct = (v?: number) =>
    v === undefined || v === null ? "—" : `${Math.round(v * 100)}%`;
  const pctRange = (lo?: number, hi?: number) =>
    lo === undefined || lo === null || hi === undefined || hi === null
      ? "—"
      : `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`;

  const semaphore = (prob?: number, ev?: number) => {
    const p = prob ?? 0;
    const e = ev ?? 0;
    if (p >= 0.55 && e > 0) return <Badge bg="success">OK</Badge>;
    if (p >= 0.5 && e >= -5)
      return (
        <Badge bg="warning" text="dark">
          Médio
        </Badge>
      );
    return <Badge bg="danger">Ruim</Badge>;
  };

  const riskBar = (r?: number) => {
    const v = Math.max(0, Math.min(1, r ?? 0));
    const now = Math.round(v * 100);
    const variant = v < 0.33 ? "success" : v < 0.66 ? "warning" : "danger";
    return (
      <OverlayTrigger overlay={<Tooltip>Risco de transição: {now}%</Tooltip>}>
        <div>
          <ProgressBar
            now={now}
            variant={variant}
            style={{ minWidth: 80, height: 8 }}
          />
        </div>
      </OverlayTrigger>
    );
  };

  const iconPartial = (flag?: boolean) =>
    flag ? (
      <Badge bg="info" text="dark">
        ½
      </Badge>
    ) : (
      <span className="text-muted">—</span>
    );

  const iconTrail = (atrMult?: number | null) =>
    atrMult && atrMult > 0 ? (
      <OverlayTrigger overlay={<Tooltip>Trailing ATR × {atrMult}</Tooltip>}>
        <Badge bg="secondary">TRAIL</Badge>
      </OverlayTrigger>
    ) : (
      <span className="text-muted">—</span>
    );

  const iconTimeout = (t?: number | null) =>
    t && t > 0 ? (
      <OverlayTrigger overlay={<Tooltip>Time-out: {t} cdl</Tooltip>}>
        <Badge bg="dark">T/O</Badge>
      </OverlayTrigger>
    ) : (
      <span className="text-muted">—</span>
    );

  return (
    <Table striped bordered hover size="sm" responsive>
      <thead>
        <tr>
          <th>Dir</th>
          <th>Entrada</th>
          <th>Stop</th>
          <th>Alvo</th>
          <th>Prob</th>
          <th>Prob (modelo)</th>
          <th>EV (pts)</th>
          <th>ATR</th>
          <th>BBWidth</th>
          <th>Regime</th>
          <th>VWAP</th>
          <th>%b</th>
          <th>TTE</th>
          <th>Expira</th>
          <th>Score</th>
          <th>Transição</th>
          <th>Alta fut. q20/50/80</th>
          <th>Baixa fut. q20/50/80</th>
          <th>Parcial</th>
          <th>Trail</th>
          <th>Timeout</th>
          <th>Condição</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it, i) => {
          const dir =
            it.side === "BUY" ? (
              <Badge bg="success">BUY</Badge>
            ) : it.side === "SELL" ? (
              <Badge bg="danger">SELL</Badge>
            ) : (
              <Badge bg="secondary">FLAT</Badge>
            );

          const cond = (
            <OverlayTrigger overlay={<Tooltip>{it.rationale}</Tooltip>}>
              <span style={{ cursor: "help" }}>{it.conditionText}</span>
            </OverlayTrigger>
          );

          const probShown = it.probCalibrated ?? it.probHit;
          const sem = semaphore(probShown, it.expectedValuePoints);
          const hiTriplet = `${fmt1(it.hiQ20)} / ${fmt1(it.hiQ50)} / ${fmt1(
            it.hiQ80
          )}`;
          const loTriplet = `${fmt1(it.loQ20)} / ${fmt1(it.loQ50)} / ${fmt1(
            it.loQ80
          )}`;

          return (
            <tr key={i}>
              <td>{dir}</td>
              <td>{fmt(it.suggestedEntry)}</td>
              <td>{fmt(it.stopSuggestion)}</td>
              <td>{fmt(it.takeProfitSuggestion)}</td>
              <td>
                <div className="d-flex gap-2 align-items-center">
                  <b>{pct(probShown)}</b> {sem}
                </div>
              </td>
              <td>{pct(it.probModel)}</td>
              <td
                className={
                  Number(it.expectedValuePoints) > 0
                    ? "text-success"
                    : "text-danger"
                }
              >
                {fmt2(it.expectedValuePoints, 1)}
              </td>
              <td>{fmt2(it.volatilityAtr, 0)}</td>
              <td>{fmt2(it.bbWidthNow, 3)}</td>
              <td>
                <Badge bg="info" text="dark">
                  {it.meta?.trendBias ?? "—"}
                </Badge>{" "}
                {it.meta?.todWindow && (
                  <Badge bg="secondary">{it.meta.todWindow}</Badge>
                )}
              </td>
              <td>{fmt1(it.meta?.vwapNow)}</td>
              <td>{fmt2(it.meta?.bbPercent, 2)}</td>
              <td>{it.validCandles} cdl</td>
              <td>{fmtDate(it.expiresAt)}</td>
              <td>{fmt2(it.score)}</td>
              <td>{riskBar(it.transitionRisk)}</td>
              <td>
                <OverlayTrigger
                  overlay={
                    <Tooltip>
                      Quantis de alcance de HIGH nos próximos candles
                    </Tooltip>
                  }
                >
                  <span>{hiTriplet}</span>
                </OverlayTrigger>
              </td>
              <td>
                <OverlayTrigger
                  overlay={
                    <Tooltip>
                      Quantis de alcance de LOW nos próximos candles
                    </Tooltip>
                  }
                >
                  <span>{loTriplet}</span>
                </OverlayTrigger>
              </td>
              <td className="text-center">{iconPartial(it.partialTake)}</td>
              <td className="text-center">{iconTrail(it.trailAtr)}</td>
              <td className="text-center">{iconTimeout(it.timeoutCandles)}</td>
              <td style={{ minWidth: 260, maxWidth: 420 }}>{cond}</td>
            </tr>
          );
        })}
        {items.length === 0 && (
          <tr>
            <td colSpan={22} className="text-center text-muted">
              Nenhuma condição projetada encontrada para os filtros atuais.
            </td>
          </tr>
        )}
      </tbody>
    </Table>
  );
}
