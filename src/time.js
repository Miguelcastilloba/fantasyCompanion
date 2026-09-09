import { DateTime } from "luxon";

export function asUtc(value) {
  if (value instanceof DateTime) return value.toUTC();
  const dt = DateTime.fromISO(String(value), { zone: "utc" });
  if (!dt.isValid) throw new Error(`Invalid timestamp: ${value}`);
  return dt;
}

export function isoUtc(value = DateTime.utc()) {
  return asUtc(value).toISO({ suppressMilliseconds: false });
}

export function displayTime(value, timezone = "America/Mexico_City") {
  return asUtc(value).setZone(timezone).toFormat("yyyy-LL-dd HH:mm ZZZZ");
}

function expandCronField(field, min, max, { sundayAlias = false } = {}) {
  const values = new Set();
  for (const part of String(field).split(",")) {
    const [base, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${field}`);
    let start = min;
    let end = max;
    if (base !== "*") {
      const range = base.split("-").map(Number);
      if (range.some((n) => !Number.isInteger(n))) throw new Error(`Invalid cron field: ${field}`);
      start = range[0];
      end = range.length === 1 ? range[0] : range[1];
    }
    if (sundayAlias && base !== "*" && start === 7 && end === 7) { start = 0; end = 0; }
    if (start < min || end > max || end < start) throw new Error(`Cron range outside bounds: ${field}`);
    for (let value = start; value <= end; value += step) values.add(sundayAlias && value === 7 ? 0 : value);
  }
  return values;
}

export function parseCron(expression) {
  const fields = String(expression).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Only five-field cron expressions are supported: ${expression}`);
  return {
    minute: expandCronField(fields[0], 0, 59),
    hour: expandCronField(fields[1], 0, 23),
    dayOfMonth: expandCronField(fields[2], 1, 31),
    month: expandCronField(fields[3], 1, 12),
    dayOfWeek: expandCronField(fields[4], 0, 7, { sundayAlias: true }),
    domWildcard: fields[2] === "*",
    dowWildcard: fields[4] === "*"
  };
}

export function cronMatches(expressionOrParsed, instant, timezone = "America/Mexico_City") {
  const cron = typeof expressionOrParsed === "string" ? parseCron(expressionOrParsed) : expressionOrParsed;
  const local = asUtc(instant).setZone(timezone);
  const domMatches = cron.dayOfMonth.has(local.day);
  const dowMatches = cron.dayOfWeek.has(local.weekday % 7);
  const dayMatches = cron.domWildcard || cron.dowWildcard ? domMatches && dowMatches : domMatches || dowMatches;
  return cron.minute.has(local.minute) && cron.hour.has(local.hour) && cron.month.has(local.month) && dayMatches;
}

export function dueClockJobs(schedule, instant, timezone = "America/Mexico_City") {
  const due = [];
  const now = asUtc(instant).startOf("minute");
  for (const [jobType, expression] of Object.entries(schedule.clock_jobs || {})) {
    if (cronMatches(expression, now, timezone)) {
      due.push({ jobType, scheduledAtUtc: isoUtc(now), localOccurrence: now.setZone(timezone).toFormat("yyyy-LL-dd'T'HH:mm:ssZZ") });
    }
  }
  return due;
}

export function actionByFromDeadline(deadline, bufferMinutes = 15) {
  return isoUtc(asUtc(deadline).minus({ minutes: bufferMinutes }));
}

export function minIso(...values) {
  const present = values.filter(Boolean).map(asUtc);
  if (!present.length) return null;
  return isoUtc(present.reduce((a, b) => (a < b ? a : b)));
}
