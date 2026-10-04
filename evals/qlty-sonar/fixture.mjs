export function clamp(limit) {
  if (limit < 0 && limit > 100) {
    return 100;
  }
  return limit;
}
