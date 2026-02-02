import { DateTime } from "luxon";

// function nowWithTest() {
//   const iso = process.env.TEST_NOW_ISO;
//   return iso ? DateTime.fromISO(iso) : DateTime.now()
// }

export function currentPeriod(tz: string, now = DateTime.now()) {
  return now.setZone(tz).toFormat("yyyy-LL"); // YYYY-MM
  
  // Для теста периода
  // return nowWithTest().setZone(tz).toFormat("yyyy-LL"); // YYYY-MM
}

export function computeDueAt(tz: string, dueDay: number, dueHour: number, period: string) {
  const [y, m] = period.split("-").map(Number);
  return DateTime.fromObject(
    { year: y, month: m, day: dueDay, hour: dueHour, minute: 0, second: 0 },
    { zone: tz }
  );
}