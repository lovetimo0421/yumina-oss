export interface ProfileWorldQuery {
  userId: string;
  search: string;
  pageSize: number;
  sort: string;
  contentLevel: "safe" | "sensitive";
}

export function shouldResetProfileWorldPage(
  previous: ProfileWorldQuery,
  current: ProfileWorldQuery,
): boolean {
  return previous.userId !== current.userId
    || previous.search !== current.search
    || previous.pageSize !== current.pageSize
    || previous.sort !== current.sort
    || previous.contentLevel !== current.contentLevel;
}
