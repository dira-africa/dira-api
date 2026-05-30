export class AirtimeService {
  async sendAirtime(phoneNumber: string, amount: number): Promise<{ success: boolean; txId?: string }> {
    return { success: true, txId: "at_tx_placeholder_123" };
  }
}

export const airtimeService = new AirtimeService();
