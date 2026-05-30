export class AiService {
  async verifyCropPhoto(photoUrl: string): Promise<{ isVerified: boolean; confidence: number }> {
    return { isVerified: true, confidence: 0.95 };
  }
}

export const aiService = new AiService();
