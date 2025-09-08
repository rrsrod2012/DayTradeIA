import * as tf from "@tensorflow/tfjs";
import fs from "fs";
import path from "path";

// Tenta habilitar backend nativo; se não tiver instalado, segue no backend JS
let tfn: typeof tf | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  tfn = require("@tensorflow/tfjs-node");
  // Se carregou, força backend "tensorflow" (nativo)
  // @ts-ignore
  if (tf.getBackend() !== "tensorflow") {
    // @ts-ignore
    tf.setBackend("tensorflow");
  }
  // garante pronto
  tf.ready?.();
  // eslint-disable-next-line no-console
  console.info("[AI] Backend nativo @tensorflow/tfjs-node ativado");
} catch {
  // eslint-disable-next-line no-console
  console.warn(
    "[AI] Rodando sem @tensorflow/tfjs-node — usando backend JS puro (mais lento)"
  );
}

export type Row = { features: Record<string, number>; label: 0 | 1 };

type Meta = {
  features: string[]; // ordem fixa das features
  createdAt: string;
  updatedAt: string;
  version: string;
  // normalização e tracking
  mean?: Record<string, number>;
  var?: Record<string, number>;
  countTrained?: number;
};

const MODELDIR = path.resolve(process.env.MODEL_DIR || "models/model-latest");
const METAPATH = path.join(MODELDIR, "meta.json");

// util: garante dir
function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// vetor a partir do mapa (sem normalização)
function vecFrom(
  feats: Record<string, number>,
  order: string[]
): number[] {
  const x = new Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const v = feats[order[i]];
    x[i] = Number.isFinite(v) ? Number(v) : 0;
  }
  return x;
}

// normalização z-score usando mean/var
function zVecFrom(
  feats: Record<string, number>,
  order: string[],
  mean: Record<string, number>,
  vari: Record<string, number>
): number[] {
  const x = new Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const k = order[i];
    const v = Number.isFinite(feats[k]) ? Number(feats[k]) : 0;
    const m = mean[k] ?? 0;
    const s2 = vari[k] ?? 1;
    const s = Math.sqrt(Math.max(1e-8, s2));
    x[i] = (v - m) / s;
  }
  return x;
}

export class OnlineBinaryClassifier {
  private model: tf.LayersModel | null = null;
  private meta: Meta | null = null;
  private order: string[] = [];
  // replay buffer para estabilizar treino incremental
  private replay: { x: number[]; y: number }[] = [];

  async load(): Promise<boolean> {
    try {
      const modelPath = path.join(MODELDIR, "model.json");
      if (fs.existsSync(modelPath)) {
        // usa o loader disponível (tfn se existir, senão tf)
        const loader = (tfn || tf) as any;
        this.model = await loader.loadLayersModel(`file://${modelPath}`);
      }
      if (fs.existsSync(METAPATH)) {
        const raw = JSON.parse(fs.readFileSync(METAPATH, "utf-8")) as Meta;
        raw.mean = raw.mean || {};
        raw.var = raw.var || {};
        raw.countTrained = raw.countTrained || 0;
        this.meta = raw;
        this.order = (raw.features || []).slice();
      }
      return !!(this.model && this.meta);
    } catch {
      this.model = null;
      this.meta = null;
      this.order = [];
      return false;
    }
  }

  private build(featureOrder: string[]) {
    const n = featureOrder.length;
    const model = tf.sequential();
    model.add(
      tf.layers.dense({
        inputShape: [n],
        units: Math.max(4, Math.ceil(n / 3)),
        activation: "relu",
        kernelInitializer: "glorotUniform",
      })
    );
    model.add(
      tf.layers.dense({
        units: 1,
        activation: "sigmoid",
        kernelInitializer: "glorotUniform",
      })
    );
    model.compile({
      optimizer: tf.train.adam(0.003),
      loss: "binaryCrossentropy",
    });
    this.model = model;

    const now = new Date().toISOString();
    this.meta = {
      features: featureOrder.slice(),
      createdAt: this.meta?.createdAt || now,
      updatedAt: now,
      version: "1.1.0",
      mean: Object.fromEntries(featureOrder.map((k) => [k, 0])),
      var: Object.fromEntries(featureOrder.map((k) => [k, 1])),
      countTrained: this.meta?.countTrained || 0,
    };
    this.order = featureOrder.slice();
  }

  async initIfNeeded(featureOrder: string[]) {
    if (this.model && this.meta) return;
    const ord =
      featureOrder && featureOrder.length
        ? featureOrder.slice()
        : this.order.length
          ? this.order
          : [];
    if (!ord.length) throw new Error("Feature order vazio para inicialização");
    this.build(ord);
  }

  getFeatureOrder(): string[] {
    if (!this.meta) throw new Error("Model meta not loaded");
    return this.meta.features;
  }

  // Atualiza estatísticas de normalização com EMA simples
  private updateStats(rows: Row[]) {
    if (!this.meta) return;
    const order = this.order;
    if (!order.length || !rows.length) return;

    const sums: Record<string, number> = Object.fromEntries(order.map((k) => [k, 0]));
    const sums2: Record<string, number> = Object.fromEntries(order.map((k) => [k, 0]));

    for (const r of rows) {
      for (const k of order) {
        const v = Number.isFinite(r.features[k]) ? Number(r.features[k]) : 0;
        sums[k] += v;
        sums2[k] += v * v;
      }
    }
    const M = rows.length;
    const mean = { ...(this.meta.mean || {}) };
    const vari = { ...(this.meta.var || {}) };
    for (const k of order) {
      const m = sums[k] / M;
      const v = Math.max(1e-6, sums2[k] / M - m * m);
      mean[k] = 0.9 * (mean[k] ?? 0) + 0.1 * m;
      vari[k] = 0.9 * (vari[k] ?? 1) + 0.1 * v;
    }
    this.meta.mean = mean;
    this.meta.var = vari;
  }

  /** Prediz probabilidade [0,1] */
  async predictProba(feats: Record<string, number>): Promise<number> {
    if (!this.model || !this.meta) {
      return 0.5;
    }
    const order = this.order.length ? this.order : this.meta.features;
    const x = zVecFrom(feats, order, this.meta.mean || {}, this.meta.var || {});
    const t = tf.tensor2d([x], [1, order.length]);
    const y = this.model.predict(t) as tf.Tensor;
    const p = (await y.data())[0] as number;
    tf.dispose([t, y]);
    // clipping leve para estabilidade
    return Math.max(0.05, Math.min(0.95, Number(p)));
  }

  /** Treino incremental com mini-batch */
  async train(
    rows: Row[],
    epochs = 1,
    lr?: number
  ): Promise<{ epochs: number; n: number }> {
    if (!rows.length) return { epochs: 0, n: 0 };

    // define/valida ordem das features
    const order =
      this.meta?.features && this.meta.features.length
        ? this.meta.features
        : Array.from(new Set(rows.flatMap((r) => Object.keys(r.features)))).sort();

    await this.initIfNeeded(order);

    if (lr && this.model) {
      this.model.compile({
        optimizer: tf.train.adam(lr),
        loss: "binaryCrossentropy",
      });
    }

    // atualiza estatísticas e normaliza
    this.updateStats(rows);
    const normX = rows.map((r) =>
      zVecFrom(r.features, order, this.meta!.mean!, this.meta!.var!)
    );
    const yArr = rows.map((r) => Number(r.label));

    // adiciona ao replay buffer
    for (let i = 0; i < normX.length; i++) {
      this.replay.push({ x: normX[i], y: yArr[i] });
    }
    const REPLAY_MAX = 2000;
    if (this.replay.length > REPLAY_MAX) {
      this.replay = this.replay.slice(this.replay.length - REPLAY_MAX);
    }

    // treina a partir do buffer (estabiliza o on-line)
    const X = tf.tensor2d(
      this.replay.map((r) => r.x),
      [this.replay.length, order.length]
    );
    const y = tf.tensor2d(
      this.replay.map((r) => [r.y]),
      [this.replay.length, 1]
    );

    await this.model!.fit(X, y, {
      epochs: Math.max(1, epochs),
      batchSize: Math.min(64, this.replay.length),
      shuffle: true,
      verbose: 0,
    });

    tf.dispose([X, y]);

    if (this.meta) {
      this.meta.updatedAt = new Date().toISOString();
      this.meta.countTrained = (this.meta.countTrained || 0) + rows.length;
    }

    await this.save();
    return { epochs: Math.max(1, epochs), n: rows.length };
  }

  async save() {
    if (!this.model || !this.meta) return;
    ensureDir(MODELDIR);
    // salva com o saver disponível (tfn se houver, senão tf)
    const saver = (tfn || tf) as any;
    await this.model.save(`file://${MODELDIR}`);
    fs.writeFileSync(METAPATH, JSON.stringify(this.meta, null, 2), "utf-8");
  }

  metaInfo(): Meta | null {
    return this.meta;
  }
}

export default OnlineBinaryClassifier;
