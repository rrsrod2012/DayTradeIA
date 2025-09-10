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
