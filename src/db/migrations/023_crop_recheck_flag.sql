-- Migration: Add needs_recheck column to crop_submissions
-- Part of R3 Resilience & Graceful Degradation

ALTER TABLE crop_submissions ADD COLUMN IF NOT EXISTS needs_recheck BOOLEAN DEFAULT FALSE;
