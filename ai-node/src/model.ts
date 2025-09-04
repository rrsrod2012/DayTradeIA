import * as tf from '@tensorflow/tfjs';
import fs from "fs";
import path from "path";

export type Row = { features: Record<string, number>; label: 0 | 1 };

type Meta = {
  features: string[]; // ordem fixa das features
  createdAt: string;
  updatedAt: string;
  version: string;
};

const MODELDIR = path.resolve(process.env.MODEL_DIR || "models/model-latest");
const METAPATH = path.join(MODELDIR, "meta.json");

// util: garante dir
function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

// mapa -> vetor ordenado
function vecFrom(feats: Record<string, number>, order: string[]): Float32Array {
  const x = new Float32Array(order.length);
  for (let i = 0; i < order.length; i++) {
    x[i] = Number.isFinite(feats[order[i]]) ? feats[order[i]] : 0;
  }
  return x;
}

export class OnlineBinaryClassifier {
  private model: tf.LayersModel | null = null;
  private meta: Meta | null = null;

  async load(): Promise<boolean> {
    try {
      this.model = await tf.loadLayersModel(
        `file://${path.join(MODELDIR, "model.json")}`
      );
      const raw = JSON.parse(fs.readFileSync(METAPATH, "utf-8")) as Meta;
      this.meta = raw;
      return true;
    } catch {
      return false;
    }
  }

  async initIfNeeded(featureOrder: string[]) {
    if (this.model && this.meta) return;

    // cria modelo logístico simples (1 camada)
    const model = tf.sequential();
    model.add(
      tf.layers.dense({
        inputShape: [featureOrder.length],
        units: 1,
        activation: "sigmoid",
        kernelInitializer: "glorotUniform",
        biasInitializer: "zeros",
      })
    );
    model.compile({
      optimizer: tf.train.adam(0.01),
      loss: "binaryCrossentropy",
      metrics: ["accuracy"],
    });
    this.model = model;
    const now = new Date().toISOString();
    this.meta = {
      features: featureOrder.slice(),
      createdAt: now,
      updatedAt: now,
      version: "1.0.0",
    };
  }

  getFeatureOrder(): string[] {
    if (!this.meta) throw new Error("Model meta not loaded");
    return this.meta.features;
  }

  /** Prediz probabilidade [0,1] */
  async predictProba(feats: Record<string, number>): Promise<number> {
    if (!this.model || !this.meta) {
      // fallback conservador
      return 0.5;
    }
    const x = vecFrom(feats, this.meta.features);
    const t = tf.tensor2d(x, [1, this.meta.features.length]);
    const y = this.model.predict(t) as tf.Tensor;
    const p = (await y.data())[0];
    tf.dispose([t, y]);
    // clamp duro
    return Math.max(0, Math.min(1, Number(p)));
  }

  /** Treino incremental com mini-batch */
  async train(
    rows: Row[],
    epochs = 1,
    lr?: number
  ): Promise<{ epochs: number; n: number }> {
    if (!rows.length) return { epochs: 0, n: 0 };

    const order = this.meta?.features ?? Object.keys(rows[0].features).sort();
    await this.initIfNeeded(order);

    if (lr && this.model) {
      // reconfigura otimizador com novo LR
      this.model.compile({
        optimizer: tf.train.adam(lr),
        loss: "binaryCrossentropy",
        metrics: ["accuracy"],
      });
    }

    const X = tf.tensor2d(
      rows.map((r) => Array.from(vecFrom(r.features, order))),
      [rows.length, order.length]
    );
    const y = tf.tensor2d(
      rows.map((r) => [r.label]),
      [rows.length, 1]
    );

    await this.model!.fit(X, y, {
      epochs,
      batchSize: Math.min(256, rows.length),
      verbose: 0,
    });

    tf.dispose([X, y]);
    if (this.meta) this.meta.updatedAt = new Date().toISOString();

    await this.save();
    return { epochs, n: rows.length };
  }

  async save() {
    if (!this.model || !this.meta) return;
    ensureDir(MODELDIR);
    await this.model.save(`file://${MODELDIR}`);
    fs.writeFileSync(METAPATH, JSON.stringify(this.meta, null, 2), "utf-8");
  }

  metaInfo(): Meta | null {
    return this.meta;
  }
}

export default OnlineBinaryClassifier;
