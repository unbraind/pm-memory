/** Scale harness deadlines on slow hardware; invalid settings keep the baseline. */
export function testTime(milliseconds: number): number {
  const scale = Number(process.env.PM_TEST_TIME_SCALE ?? 1);
  return milliseconds * (Number.isFinite(scale) && scale > 0 ? scale : 1);
}
