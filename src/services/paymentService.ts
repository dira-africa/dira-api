export class PaymentService {
  async triggerMpesaB2C(phoneNumber: string, amount: number): Promise<{ success: boolean; conversationId?: string }> {
    return { success: true, conversationId: "mpesa_conv_12345" };
  }
}

export const paymentService = new PaymentService();
