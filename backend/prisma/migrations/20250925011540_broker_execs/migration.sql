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
