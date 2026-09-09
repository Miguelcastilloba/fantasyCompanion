export class DeadlineError extends Error {
  constructor(label, deadlineAt) {
    super(`${label} exceeded the worker deadline`);
    this.name = "DeadlineError";
    this.code = "DEADLINE_EXCEEDED";
    this.deadlineAt = deadlineAt;
  }
}

export function remainingMs(deadlineAt) {
  if (!deadlineAt) return null;
  return Math.max(0, Number(deadlineAt) - Date.now());
}

export function assertTimeRemaining(label, deadlineAt) {
  const remaining = remainingMs(deadlineAt);
  if (remaining !== null && remaining <= 0) throw new DeadlineError(label, deadlineAt);
  return remaining;
}

export async function withDeadline(label, deadlineAt, operation) {
  const remaining = assertTimeRemaining(label, deadlineAt);
  if (remaining === null) return operation();

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label, deadlineAt)), remaining);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
