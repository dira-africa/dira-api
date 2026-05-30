export class VoucherService {
  async issueInputVoucher(userId: string, partnerId: string, amount: number): Promise<{ success: boolean; code?: string }> {
    return { success: true, code: "VCH_M1_DEMO_CODE" };
  }
}

export const voucherService = new VoucherService();
