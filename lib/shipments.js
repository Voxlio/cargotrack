/**
 * Shipment domain logic, extracted from the route handlers so it can be tested
 * without spinning up Express or a database.
 *
 * Everything here is pure: it takes plain objects and returns plain objects.
 * Storage and HTTP concerns live in store.js and server.js.
 */

'use strict';

/** The only statuses the console can produce. Anything else is rejected. */
const STATUSES = ['Sorting Depot', 'Customs Exception', 'In Transit', 'Delivered'];

const MAX_FIELD_LENGTH = 200;
const MAX_DETAIL_LENGTH = 2000;

/** Rejection the API turns into a 400. */
class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.field = field;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function clean(value, max = MAX_FIELD_LENGTH) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Keeps first/last non-empty comma-separated segment handling sane. */
function segments(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Format a date the way the tracking UI expects.
 * Respects the process timezone — set TZ in .env to pin it (Vercel defaults to UTC).
 */
function formatDateTime(dateObj, longFormat = true) {
  if (!dateObj) return null;
  const d = new Date(dateObj);
  if (Number.isNaN(d.getTime())) return null;

  const month = d.toLocaleDateString('en-US', { month: 'short' });
  const day = d.toLocaleDateString('en-US', { day: '2-digit' });
  const year = d.getFullYear();

  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours || 12;
  const timeStr = `${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;

  return longFormat ? `${month} ${day}, ${year} - ${timeStr}` : `${month} ${day}, ${timeStr}`;
}

/**
 * Badge styling and pipeline position for a status.
 * Single source of truth — the original code had two drifting copies, which is
 * how "Sorting Depot" ended up with a sky-blue badge in one place and no icon
 * in another.
 */
function describeStatus(status) {
  switch (status) {
    case 'In Transit':
      return {
        badgeClass: 'bg-amber-500/10 text-amber-500 border border-amber-500/30',
        step: 3,
        icon: 'fa-truck-fast',
      };
    case 'Delivered':
      return {
        badgeClass: 'bg-emerald-500/10 text-[#22C55E] border border-emerald-500/30',
        step: 4,
        icon: 'fa-circle-check',
      };
    case 'Customs Exception':
      return {
        badgeClass: 'bg-rose-500/10 text-rose-500 border border-rose-500/30',
        step: 2,
        icon: 'fa-circle-exclamation',
      };
    case 'Sorting Depot':
    default:
      return {
        badgeClass: 'bg-sky-500/10 text-sky-500 border border-sky-500/30',
        step: 1,
        icon: 'fa-warehouse',
      };
  }
}

/** Random 5-digit tracking id, in the SH-12345 shape the UI validates against. */
function randomTrackingId(random = Math.random) {
  return `SH-${Math.floor(random() * 90000) + 10000}`;
}

function randomWaybill(random = Math.random) {
  return `WB-${Math.floor(random() * 800000) + 100000}`;
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

/**
 * Build a brand new shipment record.
 *
 * @param {object} body raw request body
 * @param {{ trackingId: string, now?: Date, random?: () => number }} opts
 * @returns {object} the record to persist
 * @throws {ValidationError}
 */
function buildShipment(body, opts = {}) {
  const input = body && typeof body === 'object' ? body : {};

  const shipper = clean(input.shipper);
  const receiver = clean(input.receiver);

  if (!shipper) throw new ValidationError('Origin shipper details are required.', 'shipper');
  if (!receiver) throw new ValidationError('Destination receiver details are required.', 'receiver');

  const status = clean(input.status) || 'Sorting Depot';
  if (!STATUSES.includes(status)) {
    throw new ValidationError(`Unsupported status "${status}". Use one of: ${STATUSES.join(', ')}.`, 'status');
  }

  const trackingId = opts.trackingId || randomTrackingId(opts.random);
  const now = opts.now ? new Date(opts.now) : new Date();
  const { badgeClass, step } = describeStatus(status);

  // Custom form dates win; otherwise derive a believable ramp from "now".
  const pick = (longKey, shortKey, offsetHours) => {
    const customLong = clean(input[longKey]);
    const customShort = clean(input[shortKey]);
    const fallbackDate = new Date(now.getTime() + offsetHours * 3600 * 1000);
    return {
      long: customLong || formatDateTime(fallbackDate, true),
      short: customShort || formatDateTime(fallbackDate, false),
    };
  };

  const initiated = pick('initiatedDate', 'initiatedDateShort', 0);
  const departed = pick('departedDate', 'departedDateShort', 4);
  const onTransit = pick('onTransitDate', 'onTransitDateShort', 12);
  const delivered = pick('deliveredDate', 'deliveredDateShort', 24);

  let eta;
  if (status === 'Delivered') eta = `Delivered successfully (${delivered.short})`;
  else if (status === 'Customs Exception') eta = 'Hold (Awaiting Customs)';
  else if (status === 'In Transit') eta = `Scheduled Delivery: ${delivered.short}`;
  else eta = `ETA: ${delivered.short}`;

  const times = [
    initiated.short,
    step >= 2 ? departed.short : 'Pending Sorting',
    step >= 3 ? onTransit.short : 'Pending Dispatch',
    step >= 4 ? delivered.short : 'Pending Delivery',
  ];

  // The original pushed then unshifted, producing a timeline that was
  // reversed for some statuses. Build newest-first explicitly instead.
  const timeline = [];

  const shipperSegments = segments(shipper);
  const receiverSegments = segments(receiver);
  const originLabel =
    (shipperSegments.length > 1 ? shipperSegments[1] : shipperSegments[0]) || 'Origin Facility';

  if (step >= 4) {
    timeline.push({
      time: clean(input.deliveredDate) || delivered.long,
      event: clean(input.m4) || 'Cargo Delivered & Completed',
      loc: receiverSegments[0] || 'Destination Receiver Dock',
      icon: 'fa-circle-check',
      desc: 'Cargo offloaded. Checked out cleanly. Received and signed by local consignee.',
    });
  }

  if (step >= 3) {
    timeline.push({
      time: clean(input.onTransitDate) || onTransit.long,
      event: clean(input.m3) || 'Departed facility node on route transit',
      loc: 'Gateway Sorting Node',
      icon: 'fa-truck-fast',
      desc: 'Container manifest dispatched toward target delivery terminal.',
    });
  }

  if (step >= 2) {
    const customs = status === 'Customs Exception';
    timeline.push({
      time: clean(input.departedDate) || departed.long,
      event: clean(input.m2) || (customs ? 'Customs Inspection Hold' : 'Freight Sorted & Consolidated'),
      loc: customs ? 'Port Customs Checkpoint Area' : 'Carrier Dispatch Center',
      icon: customs ? 'fa-circle-exclamation' : 'fa-warehouse',
      desc: customs
        ? 'Random customs check initiated. Import duty declaration under inspection. Agent broker has been notified.'
        : 'Cargo consolidated on linehaul truck loading ramps.',
    });
  }

  timeline.push({
    time: clean(input.initiatedDate) || initiated.long,
    event: clean(input.m1) || 'Manifest Initiated & Picked Up',
    loc: originLabel,
    icon: 'fa-truck-ramp-box',
    desc: 'Package collection completed. Waybill tags generated securely.',
  });

  let location;
  if (status === 'Delivered') location = receiverSegments[0] || receiver;
  else if (status === 'In Transit') location = 'En Route Gateway Center';
  else if (status === 'Customs Exception') location = 'Port Customs Checkpoint Area';
  else location = 'Sorting Hub Depot';

  return {
    waybill: `${randomWaybill(opts.random)}-${trackingId.replace(/^SH-/, '')}`,
    eta,
    location,
    status,
    badgeClass,
    step,
    shipper,
    receiver,
    service: clean(input.service) || 'Express Air Freight Priority',
    weight: clean(input.weight) || '15.0 kg',
    dimensions: clean(input.dimensions) || '40x40x40 cm',
    barcode: `||| ||| | || ${trackingId.replace(/^SH-/, '')} ||`,
    tempSensor: clean(input.temp) || '18.5°C',
    times,
    timeline,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Update
 * ------------------------------------------------------------------ */

/**
 * Apply a status change, returning a new record (the input is not mutated).
 *
 * @param {object} record existing shipment
 * @param {{ status?: string, location?: string, details?: string }} body
 * @param {Date} [now]
 * @returns {object} updated copy
 * @throws {ValidationError}
 */
function applyStatusChange(record, body, now = new Date()) {
  if (!record || typeof record !== 'object') throw new ValidationError('Shipment not found.');

  const input = body && typeof body === 'object' ? body : {};
  const status = clean(input.status);

  if (!STATUSES.includes(status)) {
    throw new ValidationError(`Unsupported status "${status}". Use one of: ${STATUSES.join(', ')}.`, 'status');
  }

  const next = { ...record };
  const { badgeClass, step, icon } = describeStatus(status);

  next.status = status;
  next.badgeClass = badgeClass;
  next.step = step;
  next.location = clean(input.location) || record.location || 'Sorting Hub Depot';

  if (status === 'In Transit') next.eta = 'In Transit (Scheduled)';
  else if (status === 'Delivered') next.eta = 'Delivered successfully';
  else if (status === 'Customs Exception') next.eta = 'Hold (Awaiting Customs)';
  else next.eta = 'Processing in Depot';

  const stampLong = formatDateTime(now, true);
  const stampShort = formatDateTime(now, false);

  // Fill the four pipeline slots in order, replacing only placeholders so a
  // genuine earlier timestamp is never overwritten.
  const times = Array.isArray(record.times) ? [...record.times] : [];
  // Placeholder text that buildShipment writes into each not-yet-reached slot.
  // Index 0 is the pickup time and is never a placeholder.
  const placeholders = [null, 'Pending Sorting', 'Pending Dispatch', 'Pending Delivery'];
  for (let i = 0; i < 4 && i < step; i += 1) {
    if (!times[i] || times[i] === placeholders[i]) {
      times[i] = stampShort;
    }
  }
  next.times = times;

  next.timeline = [
    {
      time: stampLong,
      event: `Status updated to: ${status}`,
      loc: next.location,
      icon,
      desc: clean(input.details, MAX_DETAIL_LENGTH) || `Package status altered to ${status} at ${next.location}. Operational logs updated.`,
    },
    ...(Array.isArray(record.timeline) ? record.timeline : []),
  ];

  next.updatedAt = now.toISOString();
  return next;
}

module.exports = {
  STATUSES,
  ValidationError,
  formatDateTime,
  describeStatus,
  randomTrackingId,
  randomWaybill,
  buildShipment,
  applyStatusChange,
};
