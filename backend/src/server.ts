import express from "express";
import cors from "cors";
import routes from "./routes";
import adminRoutes from "./routesAdmin";
import { bootCsvWatchersIfConfigured } from "./services/csvWatcher";
import logger from "./logger";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.use(routes);
app.use(adminRoutes);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  logger.info({ msg: `API up on http://localhost:${port}` });
  try {
    bootCsvWatchersIfConfigured();
  } catch (e: any) {
    logger.warn("[CSVWatcher] módulo não carregado", { err: e?.message || e });
  }
});
