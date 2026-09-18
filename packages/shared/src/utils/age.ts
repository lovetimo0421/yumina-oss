export function getAgeFromBirthYear(birthYear: number): number {
  return new Date().getFullYear() - birthYear;
}
