-- Additive Website Story / approved About copy.
-- rawOwnerStory is never public. approvedPublicAboutCopy is owner-controlled.
ALTER TABLE "BusinessSettings" ADD COLUMN "rawOwnerStory" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN "approvedPublicAboutCopy" TEXT;
