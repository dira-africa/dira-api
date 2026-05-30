export class TokenService {
  async getBalance(userId: string): Promise<{ balance: number }> {
    return { balance: 0 };
  }

  async awardTokens(userId: string, amount: number, reason: string): Promise<boolean> {
    return true;
  }
}

export const tokenService = new TokenService();
