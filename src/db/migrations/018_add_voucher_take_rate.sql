-- Add take_rate and fee_amount to voucher_redemptions
ALTER TABLE voucher_redemptions ADD COLUMN take_rate DECIMAL(5,2);
ALTER TABLE voucher_redemptions ADD COLUMN fee_amount DECIMAL(10,2);
