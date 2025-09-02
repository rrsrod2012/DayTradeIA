// ===============================
// FILE: backend/src/index.ts
// ===============================
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import logger from "./logger";
import router from "./routes";
import { bootCsvWatchersIfConfigured } from "./services/csvWatcher";
import { bootConfirmedSignalsWorker } from "./workers/confirmedSignalsWorker";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(router);

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  logger.info({ msg: `API up on http://localhost:${port}` });
  bootCsvWatchersIfConfigured?.();
  bootConfirmedSignalsWorker?.();
});
