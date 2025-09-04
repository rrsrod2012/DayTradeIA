import "dotenv/config";
import express from "express";
import { z } from "zod";
import { OnlineBinaryClassifier } from "./model";

const PORT = Number(process.env.PORT || 5050);

// modelo global (processo único)
const clf = new OnlineBinaryClassifier();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", async (_req, res) => {
  const ok = await clf.load().catch(() => false);
  return res.json({ ok, loaded: !!ok });
});

/** Predição compatível com o backend atual */
app.post("/predict", async (req, res) => {
  try {
    const schema = z.object({ features: z.record(z.number()).default({}) });
    const { features } = schema.parse(req.body || {});

    // carrega se existir; se não, devolve 0.5
    if (!(await clf.load())) {
      return res.json({ p: 0.5 });
    }
    const p = await clf.predictProba(features);
    return res.json({ p });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || "bad request" });
  }
});

/** Treino incremental com mini-batch; útil para feedback online */
app.post("/train", async (req, res) => {
  try {
    const row = z.object({
      features: z.record(z.number()),
      label: z.number().int().min(0).max(1),
    });
    const schema = z.object({
      rows: z.array(row).min(1),
      epochs: z.number().int().min(1).max(20).default(1),
      lr: z.number().positive().max(1).optional(),
    });
    const { rows, epochs, lr } = schema.parse(req.body || {});
    await clf.load().catch(() => false); // tenta carregar; se não houver, cria
    const info = await clf.train(
      rows.map((r) => ({
        features: r.features,
        label: r.label as 0 | 1,
      })),
      epochs,
      lr
    );
    return res.json({ ok: true, ...info, meta: clf.metaInfo() });
  } catch (e: any) {
    return res
      .status(400)
      .json({ ok: false, error: e?.message || "bad request" });
  }
});

/** Meta/model info */
app.get("/meta", async (_req, res) => {
  await clf.load().catch(() => false);
  return res.json({ meta: clf.metaInfo() });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ msg: `ai-node up on http://localhost:${PORT}` })
  );
});
