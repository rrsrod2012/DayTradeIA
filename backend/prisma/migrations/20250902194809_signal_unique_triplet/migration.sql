-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Signal" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "candleId" INTEGER NOT NULL,
    "signalType" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "score" REAL,
    "reason" TEXT,
    CONSTRAINT "Signal_candleId_fkey" FOREIGN KEY ("candleId") REFERENCES "Candle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Signal" ("candleId", "id", "reason", "score", "side", "signalType") SELECT "candleId", "id", "reason", "score", "side", "signalType" FROM "Signal";
DROP TABLE "Signal";
ALTER TABLE "new_Signal" RENAME TO "Signal";
CREATE INDEX "Signal_candleId_idx" ON "Signal"("candleId");
CREATE UNIQUE INDEX "Signal_candleId_signalType_side_key" ON "Signal"("candleId", "signalType", "side");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
