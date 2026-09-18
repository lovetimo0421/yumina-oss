interface NotificationDeleteDependencies {
  deleteOwned: (userId: string, notificationId: string) => Promise<boolean>;
  flagWrite: (userId: string) => void;
}

export async function executeNotificationDelete(
  userId: string,
  notificationId: string,
  dependencies: NotificationDeleteDependencies,
): Promise<boolean> {
  const deleted = await dependencies.deleteOwned(userId, notificationId);
  if (!deleted) return false;

  dependencies.flagWrite(userId);
  return true;
}
