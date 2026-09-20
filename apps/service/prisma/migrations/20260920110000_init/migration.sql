-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "subtopic" TEXT,
    "tone" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "dmStatusCode" INTEGER,
    "dmResponse" JSONB,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fingerprint" (
    "hash" TEXT NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastPostedSignalId" TEXT,
    "suppressUntil" TIMESTAMPTZ(3),

    CONSTRAINT "Fingerprint_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "AdapterRun" (
    "id" SERIAL NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL,
    "itemsFetched" INTEGER NOT NULL DEFAULT 0,
    "candidatesEmitted" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "AdapterRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxonomySnapshot" (
    "id" SERIAL NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "body" JSONB NOT NULL,

    CONSTRAINT "TaxonomySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Signal_fingerprint_idx" ON "Signal"("fingerprint");

-- CreateIndex
CREATE INDEX "Signal_adapterKey_createdAt_idx" ON "Signal"("adapterKey", "createdAt");

-- CreateIndex
CREATE INDEX "Signal_status_postedAt_idx" ON "Signal"("status", "postedAt");

-- CreateIndex
CREATE INDEX "Signal_adapterKey_status_postedAt_idx" ON "Signal"("adapterKey", "status", "postedAt");

-- CreateIndex
CREATE INDEX "Signal_status_nextAttemptAt_createdAt_idx" ON "Signal"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "AdapterRun_adapterKey_startedAt_idx" ON "AdapterRun"("adapterKey", "startedAt");

-- CreateIndex
CREATE INDEX "TaxonomySnapshot_fetchedAt_idx" ON "TaxonomySnapshot"("fetchedAt");
