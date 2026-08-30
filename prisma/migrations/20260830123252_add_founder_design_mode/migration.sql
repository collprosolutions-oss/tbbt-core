-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isFounder" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FounderDesignOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pageKey" TEXT NOT NULL,
    "tokens" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FounderDesignOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FounderDesignOverride_userId_idx" ON "FounderDesignOverride"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FounderDesignOverride_userId_pageKey_key" ON "FounderDesignOverride"("userId", "pageKey");

-- AddForeignKey
ALTER TABLE "FounderDesignOverride" ADD CONSTRAINT "FounderDesignOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
