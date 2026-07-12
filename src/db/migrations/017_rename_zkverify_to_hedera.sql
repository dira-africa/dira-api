-- Rename zkverify/xion tables and columns to Hedera naming
-- Part of the XION -> Hedera migration

ALTER TABLE IF EXISTS zkverify_anchors RENAME TO hedera_anchors;
ALTER TABLE IF EXISTS zkverify_certificates RENAME TO hedera_certificates;

-- Rename columns in hedera_anchors
ALTER TABLE hedera_anchors RENAME COLUMN xion_tx_hash TO hcs_tx_id;
ALTER TABLE hedera_anchors RENAME COLUMN zkverify_proof_id TO hcs_sequence_number;
ALTER TABLE hedera_anchors RENAME COLUMN zkverify_tx_hash TO hts_tx_id;

-- Rename columns in hedera_certificates
ALTER TABLE hedera_certificates RENAME COLUMN xion_tx_hash TO hcs_tx_id;
ALTER TABLE hedera_certificates RENAME COLUMN zkverify_proof_id TO hcs_sequence_number;
ALTER TABLE hedera_certificates RENAME COLUMN zkverify_tx_hash TO hts_tx_id;
