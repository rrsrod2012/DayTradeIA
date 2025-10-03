/*
  Warnings:

  - You are about to drop the column `beAtPoints` on the `BrokerTask` table. All the data in the column will be lost.
  - You are about to drop the column `beOffsetPoints` on the `BrokerTask` table. All the data in the column will be lost.
  - You are about to drop the column `comment` on the `BrokerTask` table. All the data in the column will be lost.
  - You are about to drop the column `price` on the `BrokerTask` table. All the data in the column will be lost.
  - You are about to drop the column `slPoints` on the `BrokerTask` table. All the data in the column will be lost.
  - You are about to drop the column `time` on the `BrokerTask` table. All the data in the column will be lost.
  - You are about to drop the column `tpPoints` on the `BrokerTask` table. All the data in the column will be lost.
  - You are about to drop the column `volume` on the `BrokerTask` table. All the data in the column will be lost.
  - You are about to drop the column `reason` on the `Signal` table. All the data in the column will be lost.
  - You are about to drop the column `score` on the `Signal` table. All the data in the column will be lost.
  - You are about to drop the column `accuracy` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `batchSize` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `epochs` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `evMean` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `horizon` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `lookback` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `loss` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `rr` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `slAtr` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `symbol` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `timeframe` on the `TrainingRun` table. All the data in the column will be lost.
  - You are about to drop the column `winRate` on the `TrainingRun` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[entrySignalId]` on the table `Trade` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `params` to the `TrainingRun` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "ProcessingCursor" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "instrumentId" INTEGER NOT NULL,
    "timeframe" TEXT NOT NULL,
    "lastProcessedTime" DATETIME NOT NULL,
    CONSTRAINT "ProcessingCursor_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BrokerExecution" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "instrumentId" INTEGER,
    CONSTRAINT "BrokerExecution_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BrokerExecution" ("agentId", "createdAt", "id", "orderId", "pnlPoints", "price", "raw", "side", "status", "symbol", "taskId", "time", "volume") SELECT "agentId", "createdAt", "id", "orderId", "pnlPoints", "price", "raw", "side", "status", "symbol", "taskId", "time", "volume" FROM "BrokerExecution";
DROP TABLE "BrokerExecution";
ALTER TABLE "new_BrokerExecution" RENAME TO "BrokerExecution";
CREATE TABLE "new_BrokerTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "symbol" TEXT,
    "timeframe" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT,
    "payload" TEXT
);
INSERT INTO "new_BrokerTask" ("agentId", "createdAt", "id", "side", "symbol", "timeframe") SELECT "agentId", "createdAt", "id", "side", "symbol", "timeframe" FROM "BrokerTask";
DROP TABLE "BrokerTask";
ALTER TABLE "new_BrokerTask" RENAME TO "BrokerTask";
CREATE TABLE "new_Signal" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "candleId" INTEGER NOT NULL,
    "signalType" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "meta" JSONB,
    CONSTRAINT "Signal_candleId_fkey" FOREIGN KEY ("candleId") REFERENCES "Candle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Signal" ("candleId", "id", "side", "signalType") SELECT "candleId", "id", "side", "signalType" FROM "Signal";
DROP TABLE "Signal";
ALTER TABLE "new_Signal" RENAME TO "Signal";
CREATE UNIQUE INDEX "Signal_candleId_signalType_side_key" ON "Signal"("candleId", "signalType", "side");
CREATE TABLE "new_TrainingRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "params" TEXT NOT NULL,
    "notes" TEXT
);
INSERT INTO "new_TrainingRun" ("finishedAt", "id", "notes", "startedAt") SELECT "finishedAt", "id", "notes", "startedAt" FROM "TrainingRun";
DROP TABLE "TrainingRun";
ALTER TABLE "new_TrainingRun" RENAME TO "TrainingRun";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingCursor_instrumentId_timeframe_key" ON "ProcessingCursor"("instrumentId", "timeframe");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_entrySignalId_key" ON "Trade"("entrySignalId");
