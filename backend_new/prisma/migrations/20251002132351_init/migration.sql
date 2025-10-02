-- CreateTable
CREATE TABLE "IndicatorValue" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "candleId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "value" REAL NOT NULL,
    CONSTRAINT "IndicatorValue_candleId_fkey" FOREIGN KEY ("candleId") REFERENCES "Candle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Pattern" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "candleId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "strength" REAL NOT NULL,
    CONSTRAINT "Pattern_candleId_fkey" FOREIGN KEY ("candleId") REFERENCES "Candle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "instrumentId" INTEGER NOT NULL,
    "timeframe" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "params" TEXT NOT NULL,
    "totalPnL" REAL,
    CONSTRAINT "BacktestRun_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrainingRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "symbol" TEXT,
    "timeframe" TEXT,
    "lookback" INTEGER,
    "horizon" INTEGER,
    "slAtr" REAL,
    "rr" REAL,
    "epochs" INTEGER,
    "batchSize" INTEGER,
    "loss" REAL,
    "accuracy" REAL,
    "evMean" REAL,
    "winRate" REAL,
    "notes" TEXT
);

-- CreateTable
CREATE TABLE "TrainingMetric" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "t" INTEGER NOT NULL,
    "loss" REAL,
    "accuracy" REAL,
    "ev" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingMetric_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TrainingRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BrokerTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "symbol" TEXT,
    "timeframe" TEXT,
    "time" DATETIME,
    "price" INTEGER,
    "volume" INTEGER,
    "slPoints" INTEGER,
    "tpPoints" INTEGER,
    "beAtPoints" INTEGER,
    "beOffsetPoints" INTEGER,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BrokerExecution" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "taskId" TEXT,
    "agentId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "symbol" TEXT,
    "orderId" TEXT,
    "status" TEXT,
    "time" DATETIME,
    "price" INTEGER,
    "volume" INTEGER,
    "pnlPoints" INTEGER,
    "raw" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Trade" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "instrumentId" INTEGER NOT NULL,
    "timeframe" TEXT NOT NULL,
    "entrySignalId" INTEGER NOT NULL,
    "exitSignalId" INTEGER,
    "qty" INTEGER NOT NULL,
    "entryPrice" REAL NOT NULL,
    "exitPrice" REAL,
    "pnlPoints" REAL,
    "pnlMoney" REAL,
    "backtestRunId" INTEGER,
    CONSTRAINT "Trade_backtestRunId_fkey" FOREIGN KEY ("backtestRunId") REFERENCES "BacktestRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Trade_exitSignalId_fkey" FOREIGN KEY ("exitSignalId") REFERENCES "Signal" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Trade_entrySignalId_fkey" FOREIGN KEY ("entrySignalId") REFERENCES "Signal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Trade_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Trade" ("entryPrice", "entrySignalId", "exitPrice", "exitSignalId", "id", "instrumentId", "pnlPoints", "qty", "timeframe") SELECT "entryPrice", "entrySignalId", "exitPrice", "exitSignalId", "id", "instrumentId", "pnlPoints", "qty", "timeframe" FROM "Trade";
DROP TABLE "Trade";
ALTER TABLE "new_Trade" RENAME TO "Trade";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
