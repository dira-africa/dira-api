export class TriangulationService {
  async processBarometricSync(userId: string, dataPoints: Array<{ timestamp: string; value: number }>): Promise<boolean> {
    return true;
  }
}

export const triangulationService = new TriangulationService();
