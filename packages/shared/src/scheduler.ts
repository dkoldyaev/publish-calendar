import type {
  CalendarDayProjection,
  PhotoRecord,
  PostponementDuration,
  ScheduleInput,
  ScheduleOutput,
  UserSettings,
} from './types.js';

const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== 'string' || timeZone.trim() !== timeZone) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function isValidReminderTime(reminderTime: string): boolean {
  return TIME_REGEX.test(reminderTime);
}

export function isValidCalendarDate(dateStr: string): boolean {
  const match = DATE_REGEX.exec(dateStr);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function extractLocalDateParts(
  instantIso: string,
  timeZone: string
): LocalDateParts {
  const date = new Date(instantIso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid instant ISO string: ${instantIso}`);
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = Number(part.value);
    }
  }
  return {
    year: map['year'] ?? 1970,
    month: map['month'] ?? 1,
    day: map['day'] ?? 1,
    hour: map['hour'] ?? 0,
    minute: map['minute'] ?? 0,
    second: map['second'] ?? 0,
  };
}

export function formatInstantToLocalDate(
  instantIso: string,
  timeZone: string
): string {
  const parts = extractLocalDateParts(instantIso, timeZone);
  const y = String(parts.year).padStart(4, '0');
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addCalendarDays(dateStr: string, days: number): string {
  const match = DATE_REGEX.exec(dateStr);
  if (!match) {
    throw new Error(`Invalid YYYY-MM-DD date string: ${dateStr}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function diffCalendarDays(startDate: string, endDate: string): number {
  const m1 = DATE_REGEX.exec(startDate);
  const m2 = DATE_REGEX.exec(endDate);
  if (!m1 || !m2) {
    throw new Error(`Invalid date in diffCalendarDays: ${startDate}, ${endDate}`);
  }
  const t1 = Date.UTC(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]));
  const t2 = Date.UTC(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]));
  return Math.round((t2 - t1) / 86_400_000);
}

/**
 * Converts a local calendar date (YYYY-MM-DD) and 24-hour time (HH:MM) in a specific
 * IANA time zone into an exact UTC ISO 8601 timestamp, properly accounting for DST transitions.
 */
export function localDateAndTimeToUtcInstant(
  localDate: string,
  reminderTime: string,
  timeZone: string
): string {
  const dateMatch = DATE_REGEX.exec(localDate);
  const timeMatch = TIME_REGEX.exec(reminderTime);
  if (!dateMatch) {
    throw new Error(`Invalid localDate: ${localDate}`);
  }
  if (!timeMatch) {
    throw new Error(`Invalid reminderTime: ${reminderTime}`);
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  const targetUtcAsIfLocal = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  let guessMs = targetUtcAsIfLocal;
  for (let i = 0; i < 3; i++) {
    const parts = extractLocalDateParts(new Date(guessMs).toISOString(), timeZone);
    const actualAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0
    );
    const diffMs = targetUtcAsIfLocal - actualAsUtc;
    if (diffMs === 0) {
      break;
    }
    guessMs += diffMs;
  }

  return new Date(guessMs).toISOString();
}

export function sortPendingQueue(photos: readonly PhotoRecord[]): PhotoRecord[] {
  return photos
    .filter((p) => p.status === 'pending')
    .slice()
    .sort((a, b) => {
      const posA = a.queuePosition ?? Number.MAX_SAFE_INTEGER;
      const posB = b.queuePosition ?? Number.MAX_SAFE_INTEGER;
      if (posA !== posB) {
        return posA - posB;
      }
      const createdCmp = a.createdAt.localeCompare(b.createdAt);
      if (createdCmp !== 0) {
        return createdCmp;
      }
      return a.id.localeCompare(b.id);
    });
}

export function normalizeQueuePositions(
  photos: readonly PhotoRecord[]
): PhotoRecord[] {
  const sortedPending = sortPendingQueue(photos);
  const positionById = new Map<string, number>();
  sortedPending.forEach((photo, index) => {
    positionById.set(photo.id, index);
  });

  return photos.map((photo) => {
    if (photo.status === 'pending') {
      const nextPos = positionById.get(photo.id) ?? 0;
      if (photo.queuePosition === nextPos) {
        return photo;
      }
      return { ...photo, queuePosition: nextPos };
    }
    if (photo.queuePosition !== null) {
      return { ...photo, queuePosition: null };
    }
    return photo;
  });
}

/**
 * Pure, deterministic scheduling domain function.
 *
 * Scheduling rules & invariants:
 * 1. Maximum of one pending photograph assigned per calendar day in the configured IANA time zone.
 * 2. Pending photographs preserve relative queue order.
 * 3. Published and deleted photographs are excluded from future scheduling.
 * 4. If a photograph is confirmed as published on a calendar day D (whether on-time, early, or late),
 *    calendar day D is marked occupied by that confirmation so no additional pending photograph
 *    is scheduled for day D.
 * 5. Unconfirmed pending photographs automatically roll forward to todayLocalDate (or postponedUntilDate
 *    if postponed until tomorrow).
 * 6. Past dates where pending photographs were already present in the queue but no publication
 *    confirmation occurred are recorded as missed dates.
 */
export function calculateSchedule(input: ScheduleInput): ScheduleOutput {
  const { photos, settings, currentInstant } = input;
  const { timeZone, reminderTime, postponedUntilDate } = settings;

  if (!isValidIanaTimeZone(timeZone)) {
    throw new Error(`Invalid IANA time zone: ${timeZone}`);
  }
  if (!isValidReminderTime(reminderTime)) {
    throw new Error(`Invalid reminder time: ${reminderTime}`);
  }

  const todayLocalDate = formatInstantToLocalDate(currentInstant, timeZone);
  const pendingQueue = sortPendingQueue(photos);

  const publishedPhotos = photos
    .filter((p) => p.status === 'published' && p.publishedAt !== null)
    .slice()
    .sort((a, b) => {
      const pubA = a.publishedAt ?? '';
      const pubB = b.publishedAt ?? '';
      const cmp = pubA.localeCompare(pubB);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });

  const publishedByDate: Record<string, PhotoRecord[]> = {};
  const occupiedDates = new Set<string>();

  for (const photo of publishedPhotos) {
    if (!photo.publishedAt) {
      continue;
    }
    const localPubDate = formatInstantToLocalDate(photo.publishedAt, timeZone);
    const list = publishedByDate[localPubDate] ?? [];
    list.push(photo);
    publishedByDate[localPubDate] = list;
    occupiedDates.add(localPubDate);
  }

  let startCandidateDate = todayLocalDate;
  if (
    postponedUntilDate !== null &&
    isValidCalendarDate(postponedUntilDate) &&
    postponedUntilDate > startCandidateDate
  ) {
    startCandidateDate = postponedUntilDate;
  }

  const projectedByPhotoId: Record<string, string> = {};
  const projectedByDate: Record<string, PhotoRecord> = {};
  const rolledOverFromByPhotoId: Record<string, string> = {};

  let cursorDate = startCandidateDate;
  for (const photo of pendingQueue) {
    while (occupiedDates.has(cursorDate)) {
      cursorDate = addCalendarDays(cursorDate, 1);
    }
    projectedByPhotoId[photo.id] = cursorDate;
    projectedByDate[cursorDate] = photo;

    const createdLocalDate = formatInstantToLocalDate(photo.createdAt, timeZone);
    if (createdLocalDate < todayLocalDate && cursorDate >= todayLocalDate) {
      rolledOverFromByPhotoId[photo.id] = createdLocalDate;
    }

    cursorDate = addCalendarDays(cursorDate, 1);
  }

  // Compute past missed publication dates:
  // A past calendar day D (< todayLocalDate) is considered a missed publication day
  // if no photograph was published on D, and at least one pending photograph (or photograph
  // published after D) was already created on or before D and remained unpublished on D.
  const missedDates: string[] = [];
  const relevantPhotosForHistory = photos.filter((p) => p.status !== 'deleted');
  if (relevantPhotosForHistory.length > 0) {
    let earliestCreatedDate = todayLocalDate;
    for (const p of relevantPhotosForHistory) {
      const cDate = formatInstantToLocalDate(p.createdAt, timeZone);
      if (cDate < earliestCreatedDate) {
        earliestCreatedDate = cDate;
      }
    }

    // Cap lookback to 366 days for bounded deterministic calculation
    const maxLookbackDate = addCalendarDays(todayLocalDate, -366);
    const scanStart =
      earliestCreatedDate < maxLookbackDate ? maxLookbackDate : earliestCreatedDate;

    let d = scanStart;
    while (d < todayLocalDate) {
      if (!occupiedDates.has(d)) {
        const hadWaitingPhotoOnDay = relevantPhotosForHistory.some((p) => {
          const createdDate = formatInstantToLocalDate(p.createdAt, timeZone);
          if (createdDate > d) {
            return false;
          }
          if (p.status === 'pending') {
            return true;
          }
          if (p.status === 'published' && p.publishedAt) {
            const pubDate = formatInstantToLocalDate(p.publishedAt, timeZone);
            return pubDate > d;
          }
          return false;
        });
        if (hadWaitingPhotoOnDay) {
          missedDates.push(d);
        }
      }
      d = addCalendarDays(d, 1);
    }
  }

  const nextPendingPhoto = pendingQueue[0] ?? null;
  const effectiveNextPublicationDate = nextPendingPhoto
    ? (projectedByPhotoId[nextPendingPhoto.id] ?? null)
    : null;

  let nextReminderInstant: string | null = null;
  if (nextPendingPhoto && effectiveNextPublicationDate) {
    const baseScheduledInstant = localDateAndTimeToUtcInstant(
      effectiveNextPublicationDate,
      reminderTime,
      timeZone
    );
    if (
      settings.activePostponedPhotoId === nextPendingPhoto.id &&
      settings.activePostponedRemindAt !== null
    ) {
      nextReminderInstant = settings.activePostponedRemindAt;
    } else {
      nextReminderInstant = baseScheduledInstant;
    }
  }

  return {
    todayLocalDate,
    timeZone,
    effectiveNextPublicationDate,
    nextPendingPhoto,
    nextReminderInstant,
    projectedByPhotoId,
    projectedByDate,
    publishedByDate,
    missedDates,
    rolledOverFromByPhotoId,
  };
}

/**
 * Applies a postponement option (15m, 1h, 3h, 6h, or tomorrow) deterministically.
 *
 * - Short postponements (15m, 1h, 3h, 6h) adjust only the reminder timestamp for the current
 *   front-of-queue photo without modifying the publication day or queue ordering.
 * - "tomorrow" postpones the publication assignment itself until the next calendar day in
 *   the configured IANA time zone and resets short-postponement state so the next reminder
 *   fires at the user's configured daily reminder time tomorrow.
 */
export function applyPostponement(params: {
  settings: UserSettings;
  photos: readonly PhotoRecord[];
  duration: PostponementDuration;
  currentInstant: string;
}): {
  updatedSettings: UserSettings;
  schedule: ScheduleOutput;
} {
  const { settings, photos, duration, currentInstant } = params;
  const currentSchedule = calculateSchedule({
    photos,
    settings,
    currentInstant,
  });

  const frontPhoto = currentSchedule.nextPendingPhoto;
  if (!frontPhoto) {
    return {
      updatedSettings: settings,
      schedule: currentSchedule,
    };
  }

  if (duration === 'tomorrow') {
    const todayLocal = currentSchedule.todayLocalDate;
    const currentEffectiveDate =
      currentSchedule.effectiveNextPublicationDate ?? todayLocal;
    const baseDate =
      currentEffectiveDate > todayLocal ? currentEffectiveDate : todayLocal;
    const tomorrowLocalDate = addCalendarDays(baseDate, 1);

    const updatedSettings: UserSettings = {
      ...settings,
      postponedUntilDate: tomorrowLocalDate,
      activePostponedRemindAt: null,
      activePostponedPhotoId: null,
      queueRevision: settings.queueRevision + 1,
      updatedAt: currentInstant,
    };

    const nextSchedule = calculateSchedule({
      photos,
      settings: updatedSettings,
      currentInstant,
    });

    return {
      updatedSettings,
      schedule: nextSchedule,
    };
  }

  const durationMinutesMap: Record<Exclude<PostponementDuration, 'tomorrow'>, number> = {
    '15m': 15,
    '1h': 60,
    '3h': 180,
    '6h': 360,
  };

  const deltaMs = durationMinutesMap[duration] * 60_000;
  const currentRemindMs = currentSchedule.nextReminderInstant
    ? new Date(currentSchedule.nextReminderInstant).getTime()
    : new Date(currentInstant).getTime();
  const nowMs = new Date(currentInstant).getTime();
  const baseMs = Math.max(currentRemindMs, nowMs);
  const nextRemindIso = new Date(baseMs + deltaMs).toISOString();

  const updatedSettings: UserSettings = {
    ...settings,
    activePostponedRemindAt: nextRemindIso,
    activePostponedPhotoId: frontPhoto.id,
    queueRevision: settings.queueRevision + 1,
    updatedAt: currentInstant,
  };

  const nextSchedule = calculateSchedule({
    photos,
    settings: updatedSettings,
    currentInstant,
  });

  return {
    updatedSettings,
    schedule: nextSchedule,
  };
}

/**
 * Builds calendar day projections for a full calendar month (1..daysInMonth).
 */
export function buildMonthDaysProjection(
  year: number,
  monthOneBased: number,
  schedule: ScheduleOutput
): CalendarDayProjection[] {
  const daysInMonth = new Date(Date.UTC(year, monthOneBased, 0)).getUTCDate();
  const missedSet = new Set(schedule.missedDates);
  const result: CalendarDayProjection[] = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const y = String(year).padStart(4, '0');
    const m = String(monthOneBased).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    const isToday = dateStr === schedule.todayLocalDate;
    const isPast = dateStr < schedule.todayLocalDate;
    const isFuture = dateStr > schedule.todayLocalDate;

    const publishedPhotos = schedule.publishedByDate[dateStr] ?? [];
    const projectedPhoto = schedule.projectedByDate[dateStr] ?? null;

    if (publishedPhotos.length > 0) {
      result.push({
        date: dateStr,
        kind: 'published',
        photo: publishedPhotos[0] ?? null,
        publishedPhotos,
        scheduledDate: dateStr,
        isToday,
        isPast,
        isFuture,
        rolledOverFromDate: null,
      });
    } else if (projectedPhoto !== null) {
      result.push({
        date: dateStr,
        kind: 'pending',
        photo: projectedPhoto,
        publishedPhotos: [],
        scheduledDate: dateStr,
        isToday,
        isPast,
        isFuture,
        rolledOverFromDate:
          schedule.rolledOverFromByPhotoId[projectedPhoto.id] ?? null,
      });
    } else if (missedSet.has(dateStr)) {
      result.push({
        date: dateStr,
        kind: 'missed',
        photo: null,
        publishedPhotos: [],
        scheduledDate: dateStr,
        isToday,
        isPast,
        isFuture,
        rolledOverFromDate: null,
      });
    } else {
      result.push({
        date: dateStr,
        kind: 'empty',
        photo: null,
        publishedPhotos: [],
        scheduledDate: dateStr,
        isToday,
        isPast,
        isFuture,
        rolledOverFromDate: null,
      });
    }
  }

  return result;
}
