import React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Navbar,
  Container,
  Row,
  Col,
  Form,
  Button,
  Spinner,
  Card,
  Badge,
  Alert,
  InputGroup,
  OverlayTrigger,
  Tooltip,
  Tabs,
  Tab,
  Dropdown,
  ButtonGroup,
} from "react-bootstrap";
import CandleChart from "../components/CandleChart";
import SignalsTable from "../components/SignalsTable";
import ProjectedSignalsTable from "../components/ProjectedSignalsTable";
import PnLSummary from "../components/PnLSummary";
import EquityBars from "../components/EquityBars";
import { api } from "../services/api";
import { toCSV, downloadCSV } from "../utils/csv";
import "../styles/dashboard.css";

type Candle = {
  time: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
type Projected = {
  time?: string | null;
  date?: string | null;
  side?: "BUY" | "SELL" | "FLAT" | string | null;
  suggestedEntry?: number | null;
  stopSuggestion?: number | null;
  takeProfitSuggestion?: number | null;
  conditionText?: string | null;
  score?: number | null;
  probHit?: number | null;
  probCalibrated?: number | null;
  expectedValuePoints?: number | null;
};

export default function Dashboard() {
  const [symbol, setSymbol] = useState("WIN");
  const [timeframe, setTimeframe] = useState("M5");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [projected, setProjected] = useState<Projected[]>([]);
  const [pnl, setPnL] = useState<any>({ pnlPoints: 0, pnlMoney: 0 });

  const [ema9, setEma9] = useState<(number | null)[]>([]);
  const [ema21, setEma21] = useState<(number | null)[]>([]);
  const [showFibo, setShowFibo] = useState(true);
  const [realtime, setRealtime] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState<boolean>(false);

  // Controle de colunas
  const [showColsConfirmed, setShowColsConfirmed] = useState({
    date: true,
    time: true,
    side: true,
    type: true,
    price: true,
    score: true,
    reason: true,
  });
  const [showColsProjected, setShowColsProjected] = useState({
    date: true,
    time: true,
    side: true,
    entry: true,
    stop: true,
    take: true,
    cond: true,
    score: true,
    prob: true,
    ev: true,
  });

  useEffect(() => {
    document.body.classList.toggle("theme-dark", darkMode);
    return () => document.body.classList.remove("theme-dark");
  }, [darkMode]);

  const weekBusinessRange = React.useCallback((): {
    from: string;
    to: string;
  } => {
    const now = new Date();
    const day = now.getDay();
    const diffToMonday = (day + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - diffToMonday);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    const toYMD = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
    return { from: toYMD(monday), to: toYMD(friday) };
  }, []);

  useEffect(() => {
    if (!dateFrom || !dateTo) {
      const r = weekBusinessRange();
      setDateFrom(r.from);
      setDateTo(r.to);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Parâmetros preditivos
  const [horizon, setHorizon] = useState<number>(8);
  const [rr, setRR] = useState<number>(2);
  const [evalWindow, setEvalWindow] = useState<number>(200);
  const [gateRegime, setGateRegime] = useState<boolean>(true);
  const [gateToD, setGateToD] = useState<boolean>(true);
  const [calibrate, setCalibrate] = useState<boolean>(true);
  const [useMicroModel, setUseMicroModel] = useState<boolean>(false);
  const [minProb, setMinProb] = useState<number>(0);
  const [minEV, setMinEV] = useState<number>(0);
  const [dailyLossCap, setDailyLossCap] = useState<number>(0);

  const params = useMemo(
    () => ({
      symbol: symbol.toUpperCase(),
      timeframe: timeframe.toUpperCase(),
      from: dateFrom || undefined,
      to: dateTo || undefined,
    }),
    [symbol, timeframe, dateFrom, dateTo]
  );

  const canApply = useMemo(
    () => Boolean(dateFrom && dateTo),
    [dateFrom, dateTo]
  );

  const computeEMA = useCallback(
    (series: number[], period: number): number[] => {
      if (period <= 1) return series.slice();
      const k = 2 / (period + 1);
      const out: number[] = [];
      let prev = series[0];
      out.push(prev);
      for (let i = 1; i < series.length; i++) {
        const cur = series[i] * k + prev * (1 - k);
        out.push(cur);
        prev = cur;
      }
      return out;
    },
    []
  );

  useEffect(() => {
    if (!candles?.length) {
      setEma9([]);
      setEma21([]);
      return;
    }
    const closes = candles.map((c) => c.close);
    const e9 = computeEMA(closes, 9).map((v) =>
      Number.isFinite(v) ? Number(v.toFixed(2)) : null
    );
    const e21 = computeEMA(closes, 21).map((v) =>
      Number.isFinite(v) ? Number(v.toFixed(2)) : null
    );
    setEma9(e9);
    setEma21(e21);
  }, [candles, computeEMA]);

  const load = useCallback(async () => {
    if (!dateFrom || !dateTo) return;
    setLoading(true);
    setError(null);
    try {
      const cc = await api.get<Candle[]>("/candles", { params });
      setCandles(cc.data ?? []);

      const ss = await api.get("/signals", { params });
      setSignals(Array.isArray(ss.data?.signals) ? ss.data.signals : []);

      const pp = await api.get("/signals/projected", {
        params: {
          ...params,
          horizon,
          rr,
          evalWindow,
          regime: gateRegime ? 1 : 0,
          tod: gateToD ? 1 : 0,
          adaptive: 1,
          cooldown: 1,
          conformal: calibrate ? 1 : 0,
          useMicroModel: useMicroModel ? 1 : 0,
          minEV: Number(minEV) || 0,
          lossCap: Number(dailyLossCap) || 0,
          minProb: Number(minProb) || 0,
        },
      });
      setProjected(pp.data?.projected ?? []);

      const bt = await api.post("/backtest", {
        symbol,
        timeframe,
        from: dateFrom || undefined,
        to: dateTo || undefined,
      });
      setPnL(bt.data ?? { pnlPoints: 0, pnlMoney: 0 });
    } catch (e: any) {
      setError(e?.message || "Falha ao carregar dados");
      setCandles([]);
      setSignals([]);
      setProjected([]);
      setPnL({ pnlPoints: 0, pnlMoney: 0 });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    symbol,
    timeframe,
    dateFrom,
    dateTo,
    horizon,
    rr,
    evalWindow,
    gateRegime,
    gateToD,
    calibrate,
    useMicroModel,
    minProb,
    minEV,
    dailyLossCap,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!realtime) return;
    const id = setInterval(() => load(), 10000);
    return () => clearInterval(id);
  }, [realtime, load]);

  // CSV exporters
  const exportConfirmed = () => {
    const csv = toCSV(
      (signals || []).map((s: any) => ({
        time: s.time,
        date: s.date,
        type: s.signalType,
        side: s.side,
        price: s.price,
        reason: s.reason,
        score: s.score,
      })),
      ["time", "date", "type", "side", "price", "reason", "score"]
    );
    downloadCSV(
      `confirmed_${symbol}_${timeframe}_${dateFrom}_${dateTo}.csv`,
      csv
    );
  };
  const exportProjected = () => {
    const csv = toCSV(
      (projected || []).map((p: any) => ({
        time: p.time,
        date: p.date,
        side: p.side,
        entry: p.suggestedEntry,
        stop: p.stopSuggestion,
        take: p.takeProfitSuggestion,
        condition: p.conditionText,
        score: p.score,
        prob: p.probCalibrated ?? p.probHit,
        ev_points: p.expectedValuePoints,
      })),
      [
        "time",
        "date",
        "side",
        "entry",
        "stop",
        "take",
        "condition",
        "score",
        "prob",
        "ev_points",
      ]
    );
    downloadCSV(
      `projected_${symbol}_${timeframe}_${dateFrom}_${dateTo}.csv`,
      csv
    );
  };
  const exportTrades = () => {
    const csv = toCSV(
      (pnl?.tradeList || []).map((t: any) => ({
        side: t.side,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        exitTime: t.exitTime,
        exitPrice: t.exitPrice,
        pnlPoints: t.pnlPoints,
      })),
      ["side", "entryTime", "entryPrice", "exitTime", "exitPrice", "pnlPoints"]
    );
    downloadCSV(`trades_${symbol}_${timeframe}_${dateFrom}_${dateTo}.csv`, csv);
  };

  return (
    <div className="dash-wrapper">
      <Navbar className="mb-3 dash-navbar">
        <Container>
          <Navbar.Brand>DayTrader IA</Navbar.Brand>
          <div className="ms-auto d-flex align-items-center gap-3">
            <Badge className="badge-soft">
              {symbol.toUpperCase()} • {timeframe.toUpperCase()}
            </Badge>
            <Form.Check
              type="switch"
              id="rt"
              label="Tempo Real"
              checked={realtime}
              onChange={(e) => setRealtime(e.target.checked)}
            />
            <Form.Check
              type="switch"
              id="dark"
              label="Escuro"
              checked={darkMode}
              onChange={(e) => setDarkMode(e.target.checked)}
            />
          </div>
        </Container>
      </Navbar>

      <Container>
        {/* Hero */}
        <Row className="mb-3">
          <Col>
            <Card className="elevated-card border-0">
              <Card.Body className="d-flex flex-wrap align-items-center justify-content-between gap-2">
                <div>
                  <div className="section-title">Visão Geral</div>
                  <div className="small-muted">
                    Período: <strong>{dateFrom}</strong> →{" "}
                    <strong>{dateTo}</strong>
                  </div>
                </div>
                <div className="d-flex align-items-center gap-2 flex-wrap">
                  <Badge className="badge-soft">
                    Ativo: {symbol.toUpperCase()}
                  </Badge>
                  <Badge className="badge-soft-success">
                    TF: {timeframe.toUpperCase()}
                  </Badge>
                  <Badge bg="light" text="dark" className="badge-plain">
                    {candles.length} candles
                  </Badge>
                  <Badge bg="light" text="dark" className="badge-plain">
                    {signals?.length ?? 0} sinais
                  </Badge>
                  <Badge bg="light" text="dark" className="badge-plain">
                    {projected?.length ?? 0} projeções
                  </Badge>
                </div>
              </Card.Body>
            </Card>
          </Col>
        </Row>

        {/* Filtros */}
        <Card className="shadow-sm mb-3 elevated-card filter-card">
          <Card.Body>
            <Row className="gy-2 align-items-end">
              <Col sm={2}>
                <Form.Label>Ativo</Form.Label>
                <Form.Control
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  placeholder="WIN"
                />
              </Col>
              <Col sm={2}>
                <Form.Label>Timeframe</Form.Label>
                <Form.Select
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value)}
                >
                  <option value="M1">M1</option>
                  <option value="M5">M5</option>
                  <option value="M15">M15</option>
                  <option value="M30">M30</option>
                  <option value="H1">H1</option>
                </Form.Select>
                <small className="text-muted">
                  Use <b>M1</b> se for seu dado base
                </small>
              </Col>
              <Col sm={2}>
                <Form.Label>De</Form.Label>
                <Form.Control
                  type="date"
                  required
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </Col>
              <Col sm={2}>
                <Form.Label>Até</Form.Label>
                <Form.Control
                  type="date"
                  required
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </Col>
              <Col sm="auto" className="d-flex gap-2">
                <Button
                  variant="primary"
                  className="btn-pill"
                  onClick={load}
                  disabled={!canApply || loading}
                  title={canApply ? "Aplicar filtros" : "Selecione o período"}
                >
                  {loading ? <Spinner size="sm" /> : "Aplicar Filtros"}
                </Button>
                <OverlayTrigger
                  placement="top"
                  overlay={
                    <Tooltip id="tip-rec">
                      Recalcula projeções com os parâmetros abaixo (RR, janelas,
                      gates, etc).
                    </Tooltip>
                  }
                >
                  <span>
                    <Button
                      variant="outline-primary"
                      className="btn-pill"
                      onClick={load}
                      disabled={loading}
                    >
                      {loading ? <Spinner size="sm" /> : "Recalcular Projeções"}
                    </Button>
                  </span>
                </OverlayTrigger>
              </Col>
            </Row>

            <hr className="my-3" />

            {/* Parâmetros preditivos */}
            <Row className="gy-2">
              <Col sm={2}>
                <Form.Label>Horizon (barras)</Form.Label>
                <Form.Control
                  type="number"
                  min={1}
                  max={64}
                  step={1}
                  value={horizon}
                  onChange={(e) =>
                    setHorizon(Math.max(1, Number(e.target.value) || 1))
                  }
                />
              </Col>
              <Col sm={2}>
                <Form.Label>RR</Form.Label>
                <Form.Control
                  type="number"
                  min={1}
                  max={6}
                  step={1}
                  value={rr}
                  onChange={(e) =>
                    setRR(Math.max(1, Number(e.target.value) || 1))
                  }
                />
              </Col>
              <Col sm={2}>
                <Form.Label>Eval Window</Form.Label>
                <Form.Control
                  type="number"
                  min={50}
                  max={2000}
                  step={10}
                  value={evalWindow}
                  onChange={(e) =>
                    setEvalWindow(Math.max(50, Number(e.target.value) || 50))
                  }
                />
              </Col>
              <Col sm={2}>
                <Form.Label>Min Prob (%)</Form.Label>
                <InputGroup>
                  <Form.Control
                    type="number"
                    step="1"
                    min={0}
                    max={100}
                    value={minProb}
                    onChange={(e) =>
                      setMinProb(
                        Math.max(0, Math.min(100, Number(e.target.value) || 0))
                      )
                    }
                  />
                  <InputGroup.Text>%</InputGroup.Text>
                </InputGroup>
              </Col>
              <Col sm={2}>
                <Form.Label>Min EV (pts)</Form.Label>
                <InputGroup>
                  <Form.Control
                    type="number"
                    step="1"
                    min={0}
                    value={minEV}
                    onChange={(e) => setMinEV(Number(e.target.value) || 0)}
                  />
                </InputGroup>
              </Col>
              <Col sm={2}>
                <Form.Label>Cap Perda Dia</Form.Label>
                <InputGroup>
                  <Form.Control
                    type="number"
                    step="1"
                    min={0}
                    value={dailyLossCap}
                    onChange={(e) =>
                      setDailyLossCap(Math.max(0, Number(e.target.value) || 0))
                    }
                  />
                  <InputGroup.Text>pts</InputGroup.Text>
                </InputGroup>
              </Col>
            </Row>

            <Row className="mt-2">
              <Col sm={6} className="d-flex align-items-center gap-3 flex-wrap">
                <Form.Check
                  type="switch"
                  id="rg"
                  label="Gate Regime"
                  checked={gateRegime}
                  onChange={(e) => setGateRegime(e.target.checked)}
                />
                <Form.Check
                  type="switch"
                  id="tod"
                  label="Gate Time-of-Day"
                  checked={gateToD}
                  onChange={(e) => setGateToD(e.target.checked)}
                />
                <Form.Check
                  type="switch"
                  id="cal"
                  label="Calibrar (Conformal)"
                  checked={calibrate}
                  onChange={(e) => setCalibrate(e.target.checked)}
                />
                <Form.Check
                  type="switch"
                  id="mm"
                  label="Micro-model"
                  checked={useMicroModel}
                  onChange={(e) => setUseMicroModel(e.target.checked)}
                />
                <Form.Check
                  type="switch"
                  id="fibo"
                  label="Fibo no Gráfico"
                  checked={showFibo}
                  onChange={(e) => setShowFibo(e.target.checked)}
                />
              </Col>
            </Row>
          </Card.Body>
        </Card>

        {/* Status de erro */}
        {error && (
          <Alert variant="danger" className="elevated-card">
            {error}
          </Alert>
        )}

        <Row className="g-3">
          {/* Gráfico */}
          <Col md={8}>
            <Card className="elevated-card h-100">
              <Card.Header className="bg-white d-flex align-items-center justify-content-between">
                <Card.Title as="h6" className="mb-0 section-title">
                  Gráfico
                </Card.Title>
                <div className="d-flex align-items-center gap-2">
                  <Badge className="badge-soft">
                    {symbol.toUpperCase()} • {timeframe.toUpperCase()}
                  </Badge>
                  {dateFrom && dateTo && (
                    <small className="text-muted">
                      {dateFrom} → {dateTo}
                    </small>
                  )}
                </div>
              </Card.Header>
              <Card.Body style={{ minHeight: 420 }}>
                {candles.length === 0 ? (
                  <EmptyState />
                ) : (
                  <CandleChart
                    candles={candles}
                    ema9={ema9}
                    ema21={ema21 as any}
                    showFibo={showFibo}
                  />
                )}
              </Card.Body>
            </Card>
          </Col>

          {/* Performance + equity + export trades */}
          <Col md={4}>
            <Card className="elevated-card h-100">
              <Card.Header className="bg-white d-flex align-items-center justify-content-between">
                <Card.Title as="h6" className="mb-0 section-title">
                  Performance
                </Card.Title>
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={exportTrades}
                >
                  CSV Trades
                </Button>
              </Card.Header>
              <Card.Body className="d-flex flex-column gap-2">
                <PnLSummary
                  pnlPoints={pnl?.pnlPoints}
                  pnlMoney={pnl?.pnlMoney}
                  details={pnl}
                />
                <EquityBars trades={pnl?.tradeList || []} bucket="day" />
              </Card.Body>
            </Card>
          </Col>
        </Row>

        {/* Abas: Confirmados / Projetados */}
        <Row className="mt-3 mb-5 g-3">
          <Col>
            <Card className="elevated-card">
              <Card.Header className="bg-white d-flex align-items-center justify-content-between">
                <Card.Title as="h6" className="mb-0 section-title">
                  Sinais
                </Card.Title>
                <div className="d-flex align-items-center gap-2">
                  <Dropdown as={ButtonGroup}>
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      onClick={exportConfirmed}
                    >
                      CSV Confirmados
                    </Button>
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      onClick={exportProjected}
                    >
                      CSV Projetados
                    </Button>
                  </Dropdown>
                </div>
              </Card.Header>
              <Card.Body>
                <Tabs
                  defaultActiveKey="confirmed"
                  id="signals-tabs"
                  className="signals-tabs"
                  justify
                >
                  <Tab
                    eventKey="confirmed"
                    title={`Confirmados (${signals?.length ?? 0})`}
                  >
                    <div className="pt-3">
                      {/* Toggle de colunas simples */}
                      <div
                        className="d-flex flex-wrap gap-3 mb-2"
                        style={{ fontSize: 12 }}
                      >
                        {Object.keys(showColsConfirmed).map((k) => (
                          <Form.Check
                            key={k}
                            type="checkbox"
                            id={`c-${k}`}
                            label={k}
                            checked={(showColsConfirmed as any)[k]}
                            onChange={(e) =>
                              setShowColsConfirmed((prev) => ({
                                ...prev,
                                [k]: e.target.checked,
                              }))
                            }
                          />
                        ))}
                      </div>
                      <SignalsTable
                        items={signals ?? []}
                        visibleCols={showColsConfirmed}
                      />
                    </div>
                  </Tab>
                  <Tab
                    eventKey="projected"
                    title={`Projetados (${projected?.length ?? 0})`}
                  >
                    <div className="pt-3">
                      <div
                        className="d-flex flex-wrap gap-3 mb-2"
                        style={{ fontSize: 12 }}
                      >
                        {Object.keys(showColsProjected).map((k) => (
                          <Form.Check
                            key={k}
                            type="checkbox"
                            id={`p-${k}`}
                            label={k}
                            checked={(showColsProjected as any)[k]}
                            onChange={(e) =>
                              setShowColsProjected((prev) => ({
                                ...prev,
                                [k]: e.target.checked,
                              }))
                            }
                          />
                        ))}
                      </div>
                      <ProjectedSignalsTable
                        items={projected}
                        visibleCols={showColsProjected}
                      />
                    </div>
                  </Tab>
                </Tabs>
              </Card.Body>
            </Card>
          </Col>
        </Row>
      </Container>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="d-flex flex-column justify-content-center align-items-center text-muted h-100">
      <div style={{ fontSize: 14, textAlign: "center", maxWidth: 420 }}>
        Se o gráfico estiver vazio, verifique:
        <ul className="mt-2">
          <li>
            O <b>timeframe</b> combina com os dados? (ex.: M1/M5)
          </li>
          <li>
            O <b>período</b> está correto e contém candles?
          </li>
        </ul>
      </div>
    </div>
  );
}
