import React, { useEffect, useState } from "react";
import { Card, Badge } from "react-bootstrap";

function getApiBase(): string {
  const env: any = (import.meta as any).env || {};
  return (
    (env.VITE_API_BASE as string)?.replace(/\/$/, "") ||
    window.location.origin.replace(/\/$/, "")
  );
}
function getWsUrl(): string {
  const env: any = (import.meta as any).env || {};
  const explicit = (env.VITE_WS_URL as string) || "";
  if (explicit) return explicit;
  const base = getApiBase().replace(/^http/i, "ws");
  return base + "/stream";
}

export default function BackendDebug(props: {
  symbol?: string;
  timeframe?: string;
}) {
  const symbol = (props.symbol || "WIN").toUpperCase();
  const timeframe = (props.timeframe || "M5").toUpperCase();
  const [health, setHealth] = useState<string>("pendente…");
  const [candlesInfo, setCandlesInfo] = useState<string>("pendente…");
  const [signalsInfo, setSignalsInfo] = useState<string>("pendente…");

  useEffect(() => {
    const api = getApiBase();

    fetch(api + "/healthz", { credentials: "omit", mode: "cors" })
      .then((r) => r.text())
      .then((t) => setHealth(t))
      .catch((e) => setHealth(String(e)));

    const qs = new URLSearchParams({
      symbol,
      timeframe,
      limit: "5",
    }).toString();
    fetch(api + "/api/candles?" + qs, { credentials: "omit", mode: "cors" })
      .then(async (r) => {
        const txt = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} | ${txt}`);
        const data = txt ? JSON.parse(txt) : [];
        setCandlesInfo(
          Array.isArray(data)
            ? `ok (${data.length} itens, exemplo time=${data[0]?.time})`
            : JSON.stringify(data).slice(0, 120)
        );
      })
      .catch((e) => setCandlesInfo(String(e)));

    fetch(api + "/api/signals?" + qs, { credentials: "omit", mode: "cors" })
      .then(async (r) => {
        const txt = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} | ${txt}`);
        const data = txt ? JSON.parse(txt) : [];
        const len = Array.isArray(data)
          ? data.length
          : Array.isArray((data as any)?.data)
          ? (data as any).data.length
          : NaN;
        setSignalsInfo(
          isNaN(len) ? JSON.stringify(data).slice(0, 120) : `ok (${len} itens)`
        );
      })
      .catch((e) => setSignalsInfo(String(e)));
  }, [symbol, timeframe]);

  return (
    <Card className="mb-3">
      <Card.Body>
        <div className="d-flex justify-content-between align-items-center mb-2">
          <strong>Backend Debug</strong>
          <Badge bg="secondary">{getApiBase()}</Badge>
        </div>
        <div className="small text-muted mb-2">WS: {getWsUrl()}</div>
        <div className="small">
          <strong>/healthz:</strong> {health}
        </div>
        <div className="small">
          <strong>/api/candles:</strong> {candlesInfo}
        </div>
        <div className="small">
          <strong>/api/signals:</strong> {signalsInfo}
        </div>
      </Card.Body>
    </Card>
  );
}
