export class NotificationService {
  async sendTelegramNotification(telegramId: string, message: string): Promise<boolean> {
    return true;
  }
}

export const notificationService = new NotificationService();
