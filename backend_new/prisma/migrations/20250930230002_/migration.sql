-- CreateTable
CREATE TABLE "Instrument" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Candle" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "instrumentId" INTEGER NOT NULL,
    "timeframe" TEXT NOT NULL,
    "time" DATETIME NOT NULL,
    "open" REAL NOT NULL,
    "high" REAL NOT NULL,
    "low" REAL NOT NULL,
    "close" REAL NOT NULL,
    "volume" REAL NOT NULL,
    CONSTRAINT "Candle_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "candleId" INTEGER NOT NULL,
    "signalType" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "score" REAL,
    "reason" TEXT,
    CONSTRAINT "Signal_candleId_fkey" FOREIGN KEY ("candleId") REFERENCES "Candle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "instrumentId" INTEGER NOT NULL,
    "timeframe" TEXT NOT NULL,
    "entrySignalId" INTEGER NOT NULL,
    "exitSignalId" INTEGER,
    "qty" INTEGER NOT NULL,
    "entryPrice" REAL NOT NULL,
    "exitPrice" REAL,
    "pnlPoints" REAL,
    CONSTRAINT "Trade_exitSignalId_fkey" FOREIGN KEY ("exitSignalId") REFERENCES "Signal" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Trade_entrySignalId_fkey" FOREIGN KEY ("entrySignalId") REFERENCES "Signal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Trade_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_symbol_key" ON "Instrument"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_instrumentId_timeframe_time_key" ON "Candle"("instrumentId", "timeframe", "time");

-- CreateIndex
CREATE INDEX "Signal_candleId_idx" ON "Signal"("candleId");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_candleId_signalType_side_key" ON "Signal"("candleId", "signalType", "side");
