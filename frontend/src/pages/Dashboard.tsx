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
  ToggleButton,
  ButtonGroup,
  Card,
  Badge,
  Alert,
  InputGroup,
} from "react-bootstrap";
import { api } from "../services/api";
import CandleChart from "../components/CandleChart";
import SignalsTable from "../components/SignalsTable";
import ProjectedSignalsTable from "../components/ProjectedSignalsTable";
import PnLSummary from "../components/PnLSummary";
import { useWebSocketStream } from "../hooks/useWebSocket";

type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

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
  // novos/optionais (se o backend já expuser)
  probModel?: number; // prob. do micro-modelo curto
  partialTake?: boolean; // se há parcial sugerida
  trailAtr?: number | null; // multiplicador de ATR do trailing
  timeoutCandles?: number | null; // time-out para encerrar a trade
  meta?: {
    trendBias: "UP" | "DOWN" | "SIDEWAYS";
    volZ?: number;
    todWindow?: string;
    vwapNow?: number; // VWAP corrente (se calculado no backend)
    bbPercent?: number; // %b (posição na banda)
  };
  // campos de previsão intervalar (compatíveis com versões anteriores)
  hiQ20?: number;
  hiQ50?: number;
  hiQ80?: number;
  loQ20?: number;
  loQ50?: number;
  loQ80?: number;
  transitionRisk?: number; // 0..1
};

export default function Dashboard() {
  const [symbol, setSymbol] = useState("WIN");
  const [timeframe, setTimeframe] = useState("M1");
  const [dateFrom, setDateFrom] = useState<string>(""); // YYYY-MM-DD
  const [dateTo, setDateTo] = useState<string>(""); // YYYY-MM-DD
  const [loading, setLoading] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [projected, setProjected] = useState<Projected[]>([]);
  const [pnl, setPnL] = useState({ pnlPoints: 0, pnlMoney: 0 });
  const [showFibo, setShowFibo] = useState(true);
  const [realtime, setRealtime] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Controles preditivos (já existentes)
  const [horizon, setHorizon] = useState<number>(8);
  const [rr, setRR] = useState<number>(2);
  const [evalWindow, setEvalWindow] = useState<number>(200);
  const [gateRegime, setGateRegime] = useState<boolean>(true);
  const [gateToD, setGateToD] = useState<boolean>(true);
  const [calibrate, setCalibrate] = useState<boolean>(true); // usado como conformal

  // ✅ Novos controles (opt-in, default conservador)
  const [useMicroModel, setUseMicroModel] = useState<boolean>(false);
  const [minEV, setMinEV] = useState<number>(0); // mínimo EV em pontos
  const [dailyLossCap, setDailyLossCap] = useState<number>(0); // cap de perda diária (0 = desliga)
  const [minProb, setMinProb] = useState<number>(0.0); // mínimo de probabilidade (0 = desliga)

  function ema(arr: number[], p: number) {
    const k = 2 / (p + 1);
    let e: number | undefined;
    return arr.map((v, i) => {
      e = e === undefined ? v : v * k + e * (1 - k);
      return i >= p - 1 ? e : null;
    });
  }

  const ema9 = useMemo(() => {
    const closes = candles.map((c) => c.close);
    const e = ema(closes, 9);
    return candles.map((c, i) => ({
      time: Math.floor(new Date(c.time).getTime() / 1000),
      value: e[i],
    }));
  }, [candles]);

  const ema21 = useMemo(() => {
    const closes = candles.map((c) => c.close);
    const e = ema(closes, 21);
    return candles.map((c, i) => ({
      time: Math.floor(new Date(c.time).getTime()).valueOf() / 1000,
      value: e[i] as number | null,
    }));
  }, [candles]);

  const clearDates = () => {
    setDateFrom("");
    setDateTo("");
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: any = { symbol, timeframe, limit: 500 };
      if (dateFrom) params.from = dateFrom;
      if (dateTo) params.to = dateTo;

      // Candles
      const c = await api.get("/candles", { params });
      const arr =
        c.data?.map((x: any) => ({
          time: x.time,
          open: x.open,
          high: x.high,
          low: x.low,
          close: x.close,
          volume: x.volume,
        })) ?? [];
      setCandles(arr);

      // Sinais confirmados
      const s = await api.get("/signals", { params });
      const sigs = (s.data?.signals ?? [])
        .slice()
        .sort((a: any, b: any) => (a.time < b.time ? 1 : -1));
      setSignals(sigs);

      // Sinais projetados — adiciona novos parâmetros como opt-in
      const pp = await api.get("/signals/projected", {
        params: {
          ...params,
          horizon,
          rr,
          evalWindow,
          regime: gateRegime ? 1 : 0,
          tod: gateToD ? 1 : 0,
          adaptive: 1, // mantido ligado
          cooldown: 1, // mantido ligado
          conformal: calibrate ? 1 : 0, // calibração/intervalo
          // Novos (o backend ignora se não suportar):
          useMicroModel: useMicroModel ? 1 : 0,
          minEV: Number(minEV) || 0,
          lossCap: Number(dailyLossCap) || 0,
          minProb: Number(minProb) || 0,
        },
      });
      setProjected(pp.data?.projected ?? []);

      // Backtest simples
      const bt = await api.post("/backtest", {
        symbol,
        timeframe,
        from: dateFrom || undefined,
        to: dateTo || undefined,
      });
      setPnL(bt.data ?? { pnlPoints: 0, pnlMoney: 0 });
    } catch (err: any) {
      console.error("Falha ao carregar dados", err);
      const msg =
        err?.response?.data?.error ||
        err?.message ||
        "Erro desconhecido ao carregar dados";
      setError(String(msg));
    } finally {
      setLoading(false);
    }
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
    minEV,
    dailyLossCap,
    minProb,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime via WebSocket (SIMULATE=1 no backend)
  useWebSocketStream(realtime, (c) => {
    setCandles((prev) => {
      const next = prev.slice(-499).concat([
        {
          time: c.time,
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          volume: c.v,
        },
      ]);
      return next;
    });
  });

  useEffect(() => {
    if (!realtime) return;
    const id = setInterval(() => load(), 10000);
    return () => clearInterval(id);
  }, [realtime, load]);

  const EmptyState = () => (
    <Alert variant="warning" className="mb-0">
      Nenhum candle carregado para <b>{symbol}</b> {timeframe}
      {(dateFrom || dateTo) && <> no período</>}.<br />
      <small className="text-muted">
        Dicas: importe um CSV (endpoint <code>/api/candles/import/csv</code>),
        configure o watcher do MetaTrader (<code>MT_CSV_WATCHERS</code>), ou
        ative o simulador realtime com <code>SIMULATE=1</code>.
      </small>
    </Alert>
  );

  return (
    <>
      {/* Topbar / Navbar */}
      <Navbar bg="dark" variant="dark" expand="md" className="mb-3">
        <Container>
          <Navbar.Brand className="fw-semibold">DayTrade IA</Navbar.Brand>
          <Navbar.Text className="ms-auto">
            <Badge bg={realtime ? "success" : "secondary"}>
              {realtime ? "Realtime ON" : "Realtime OFF"}
            </Badge>
          </Navbar.Text>
        </Container>
      </Navbar>

      <Container className="pb-4">
        {/* Filtros e Ações */}
        <Card className="mb-3 shadow-sm">
          <Card.Body>
            <Row className="g-3 align-items-end">
              <Col lg={2} md={3}>
                <Form.Label>Ativo</Form.Label>
                <Form.Select
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                >
                  <option value="WIN">WIN (Mini Índice)</option>
                  <option value="WDO">WDO (Mini Dólar)</option>
                </Form.Select>
              </Col>
              <Col lg={2} md={3}>
                <Form.Label>Timeframe</Form.Label>
                <Form.Select
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value)}
                >
                  <option value="M1">M1</option>
                  <option value="M5">M5</option>
                  <option value="M15">M15</option>
                </Form.Select>
              </Col>

              {/* Datas */}
              <Col lg={2} md={3}>
                <Form.Label>De</Form.Label>
                <Form.Control
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </Col>
              <Col lg={2} md={3}>
                <Form.Label>Até</Form.Label>
                <Form.Control
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </Col>

              <Col lg="auto" md="auto">
                <Form.Check
                  className="mt-4"
                  type="switch"
                  id="fibo"
                  label="Exibir Fibonacci"
                  checked={showFibo}
                  onChange={(e) => setShowFibo(e.currentTarget.checked)}
                />
              </Col>

              <Col lg="auto" md="auto" className="mt-4">
                <ButtonGroup>
                  <ToggleButton
                    id="rt-off"
                    type="radio"
                    variant={realtime ? "outline-secondary" : "secondary"}
                    name="rt"
                    value="0"
                    checked={!realtime}
                    onChange={() => setRealtime(false)}
                  >
                    Realtime OFF
                  </ToggleButton>
                  <ToggleButton
                    id="rt-on"
                    type="radio"
                    variant={realtime ? "success" : "outline-success"}
                    name="rt"
                    value="1"
                    checked={realtime}
                    onChange={() => setRealtime(true)}
                  >
                    Realtime ON
                  </ToggleButton>
                </ButtonGroup>
              </Col>

              <Col lg="auto" md="auto" className="mt-4 d-flex gap-2">
                <Button onClick={load} disabled={loading}>
                  {loading ? <Spinner size="sm" /> : "Aplicar Filtros"}
                </Button>
                <Button
                  variant="outline-secondary"
                  onClick={clearDates}
                  disabled={loading}
                >
                  Limpar Datas
                </Button>
              </Col>
            </Row>

            {/* Controles de projeção preditiva */}
            <hr className="my-3" />
            <Row className="g-3 align-items-end">
              <Col sm={2}>
                <Form.Label>Horizonte (cdls)</Form.Label>
                <InputGroup>
                  <Form.Control
                    type="number"
                    min={3}
                    max={40}
                    value={horizon}
                    onChange={(e) => setHorizon(Number(e.target.value) || 8)}
                  />
                </InputGroup>
              </Col>
              <Col sm={2}>
                <Form.Label>Risk:Reward</Form.Label>
                <InputGroup>
                  <Form.Control
                    type="number"
                    step="0.1"
                    min={0.5}
                    max={5}
                    value={rr}
                    onChange={(e) => setRR(Number(e.target.value) || 2)}
                  />
                </InputGroup>
              </Col>
              <Col sm={2}>
                <Form.Label>Janela Hist. (ev)</Form.Label>
                <InputGroup>
                  <Form.Control
                    type="number"
                    min={50}
                    max={1000}
                    value={evalWindow}
                    onChange={(e) =>
                      setEvalWindow(Number(e.target.value) || 200)
                    }
                  />
                </InputGroup>
              </Col>
              <Col sm="auto">
                <Form.Check
                  type="switch"
                  id="gateRegime"
                  label="Gate por Regime"
                  checked={gateRegime}
                  onChange={(e) => setGateRegime(e.currentTarget.checked)}
                />
              </Col>
              <Col sm="auto">
                <Form.Check
                  type="switch"
                  id="gateToD"
                  label="Gate por Horário"
                  checked={gateToD}
                  onChange={(e) => setGateToD(e.currentTarget.checked)}
                />
              </Col>
              <Col sm="auto">
                <Form.Check
                  type="switch"
                  id="calibrate"
                  label="Calibrar Prob."
                  checked={calibrate}
                  onChange={(e) => setCalibrate(e.currentTarget.checked)}
                />
              </Col>

              {/* ✅ Novos controles — opt-in */}
              <Col sm="auto">
                <Form.Check
                  type="switch"
                  id="useMicroModel"
                  label="Usar Micro-Modelo"
                  checked={useMicroModel}
                  onChange={(e) => setUseMicroModel(e.currentTarget.checked)}
                />
              </Col>
              <Col sm={2}>
                <Form.Label>Min. Prob.</Form.Label>
                <InputGroup>
                  <Form.Control
                    type="number"
                    step="0.01"
                    min={0}
                    max={0.99}
                    value={minProb}
                    onChange={(e) => setMinProb(Number(e.target.value) || 0)}
                  />
                </InputGroup>
              </Col>
              <Col sm={2}>
                <Form.Label>Min. EV (pts)</Form.Label>
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
                      setDailyLossCap(Number(e.target.value) || 0)
                    }
                  />
                </InputGroup>
              </Col>

              <Col sm="auto">
                <Button
                  variant="outline-primary"
                  onClick={load}
                  disabled={loading}
                >
                  {loading ? <Spinner size="sm" /> : "Recalcular Projeções"}
                </Button>
              </Col>
            </Row>
          </Card.Body>
        </Card>

        {/* Status de erro */}
        {error && <Alert variant="danger">{error}</Alert>}

        {/* Gráfico + Resumo PnL */}
        <Row>
          <Col md={8}>
            <Card className="shadow-sm">
              <Card.Header className="bg-white d-flex justify-content-between align-items-center">
                <Card.Title as="h6" className="mb-0">
                  Gráfico
                </Card.Title>
                <small className="text-muted">{candles.length} candle(s)</small>
              </Card.Header>
              <Card.Body>
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
          <Col md={4} className="mt-3 mt-md-0">
            <Card className="shadow-sm h-100">
              <Card.Header className="bg-white">
                <Card.Title as="h6" className="mb-0">
                  Performance
                </Card.Title>
              </Card.Header>
              <Card.Body className="d-flex">
                <PnLSummary pnlPoints={pnl.pnlPoints} pnlMoney={pnl.pnlMoney} />
              </Card.Body>
            </Card>
          </Col>
        </Row>

        {/* Tabela de Sinais Confirmados */}
        <Card className="mt-3 shadow-sm">
          <Card.Header className="bg-white d-flex align-items-center justify-content-between">
            <Card.Title as="h6" className="mb-0">
              Sinais (Confirmados)
            </Card.Title>
            <small className="text-muted">
              {signals?.length ?? 0} sinal(is)
            </small>
          </Card.Header>
          <Card.Body>
            <SignalsTable signals={signals} candles={candles} />
          </Card.Body>
        </Card>

        {/* Tabela de Sinais Projetados */}
        <Card className="mt-3 shadow-sm">
          <Card.Header className="bg-white d-flex align-items-center justify-content-between">
            <Card.Title as="h6" className="mb-0">
              Sinais Projetados (Condicionais)
            </Card.Title>
            <small className="text-muted">
              {projected?.length ?? 0} condição(ões)
            </small>
          </Card.Header>
          <Card.Body>
            <ProjectedSignalsTable items={projected} />
          </Card.Body>
        </Card>
      </Container>
    </>
  );
}
