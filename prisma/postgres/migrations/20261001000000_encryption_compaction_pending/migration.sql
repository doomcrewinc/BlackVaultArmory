-- Final review F1: retry marker for the post-encryption / post-rotation compaction.
ALTER TABLE "AppSettings" ADD COLUMN "encryptionCompactionPending" BOOLEAN NOT NULL DEFAULT false;
