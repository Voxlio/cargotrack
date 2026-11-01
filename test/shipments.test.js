'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUSES,
  ValidationError,
  buildShipment,
  applyStatusChange,
  describeStatus,
  randomTrackingId,
  formatDateTime,
} = require('../lib/shipments.js');

const FIXED = new Date('2026-11-01T09:30:00Z');

function build(overrides = {}) {
  return buildShipment(
    { shipper: 'Lux Logistics SA, Paris (CDG)', receiver: 'TechCorp Industries, New York (JFK)', ...overrides },
    { trackingId: 'SH-12345', now: FIXED, random: () => 0.5 }
  );
}

/* ----------------------------- create ----------------------------- */

test('rejects a shipment with no shipper or receiver', () => {
  assert.throws(() => buildShipment({ receiver: 'Someone' }, { trackingId: 'SH-1' }), ValidationError);
  assert.throws(() => buildShipment({ shipper: 'Someone' }, { trackingId: 'SH-1' }), ValidationError);
  assert.throws(() => buildShipment({}, { trackingId: 'SH-1' }), ValidationError);
});

test('rejects an unknown status rather than silently defaulting', () => {
  assert.throws(() => build({ status: 'Teleported' }), ValidationError);
});

test('accepts every documented status', () => {
  for (const status of STATUSES) {
    assert.equal(build({ status }).status, status);
  }
});

test('trims and collapses whitespace in text fields', () => {
  const record = build({ shipper: '  Lux   Logistics  ,  Paris  ' });
  assert.equal(record.shipper, 'Lux Logistics , Paris');
});

test('truncates absurdly long input instead of storing it', () => {
  const record = build({ weight: 'x'.repeat(5000) });
  assert.equal(record.weight.length, 200);
});

test('builds the timeline newest-first', () => {
  const record = build({ status: 'Delivered' });

  assert.equal(record.timeline.length, 4);
  assert.equal(record.timeline[0].icon, 'fa-circle-check');
  assert.equal(record.timeline[1].icon, 'fa-truck-fast');
  assert.equal(record.timeline[2].icon, 'fa-warehouse');
  assert.equal(record.timeline[3].icon, 'fa-truck-ramp-box');

  // Newest entry first means the timestamps descend.
  const times = record.timeline.map((t) => Date.parse(t.time.replace(' - ', ' ')));
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i - 1] >= times[i], 'timeline is not in descending time order');
  }
});

test('a sorting-depot shipment has only the pickup checkpoint', () => {
  const record = build({ status: 'Sorting Depot' });
  assert.equal(record.step, 1);
  assert.equal(record.timeline.length, 1);
  assert.equal(record.times[1], 'Pending Sorting');
  assert.equal(record.times[2], 'Pending Dispatch');
});

test('customs exception lands on step 2 with a customs entry', () => {
  const record = build({ status: 'Customs Exception' });
  assert.equal(record.step, 2);
  assert.equal(record.timeline[0].event, 'Customs Inspection Hold');
  assert.match(record.eta, /Customs/);
});

test('falls back to a location when the shipper has no comma', () => {
  const record = build({ shipper: 'Solo Warehouse' });
  const pickup = record.timeline[record.timeline.length - 1];
  assert.equal(pickup.loc, 'Solo Warehouse');
  assert.ok(pickup.loc, 'timeline location must never be undefined');
});

test('custom checkpoint messages override the defaults', () => {
  const record = build({ m1: 'Picked up by drone' });
  const pickup = record.timeline[record.timeline.length - 1];
  assert.equal(pickup.event, 'Picked up by drone');
});

test('derived timestamps use the injected clock', () => {
  const record = build({ status: 'Sorting Depot' });
  // formatDateTime renders in the process timezone, so compare against the
  // same formatter rather than a hard-coded local string.
  assert.equal(record.times[0], formatDateTime(FIXED, false));
  assert.match(record.times[0], /^Nov 01, \d{2}:\d{2} (AM|PM)$/);
});

test('timeline entries never contain undefined JSON fields', () => {
  const record = build();
  const json = JSON.parse(JSON.stringify(record));
  for (const entry of json.timeline) {
    for (const key of ['time', 'event', 'loc', 'icon', 'desc']) {
      assert.ok(entry[key] !== undefined && entry[key] !== null, `timeline.${key} is missing`);
      assert.equal(typeof entry[key], 'string');
    }
  }
});

/* ----------------------------- update ----------------------------- */

test('applyStatusChange does not mutate its input', () => {
  const original = build({ status: 'Sorting Depot' });
  const snapshot = JSON.parse(JSON.stringify(original));
  applyStatusChange(original, { status: 'Delivered' }, FIXED);
  assert.deepEqual(original, snapshot);
});

test('applyStatusChange moves the shipment and prepends a log entry', () => {
  const original = build({ status: 'Sorting Depot' });
  const updated = applyStatusChange(original, { status: 'In Transit', location: 'Kano Hub' }, FIXED);

  assert.equal(updated.status, 'In Transit');
  assert.equal(updated.step, 3);
  assert.equal(updated.location, 'Kano Hub');
  assert.equal(updated.timeline[0].event, 'Status updated to: In Transit');
  assert.equal(updated.timeline.length, original.timeline.length + 1);
});

test('applyStatusChange rejects an invalid status', () => {
  const original = build();
  assert.throws(() => applyStatusChange(original, { status: 'Lost in space' }, FIXED), ValidationError);
  assert.throws(() => applyStatusChange(original, {}, FIXED), ValidationError);
});

test('applyStatusChange fills pending slots with the update time', () => {
  const original = build({ status: 'Sorting Depot' });
  const updated = applyStatusChange(original, { status: 'Delivered' }, FIXED);

  const stamp = formatDateTime(FIXED, false);
  assert.equal(updated.times[1], stamp);
  assert.equal(updated.times[2], stamp);
  assert.equal(updated.times[3], stamp);
});

test('applyStatusChange keeps a real earlier timestamp', () => {
  const original = build({ status: 'In Transit' });
  const before = original.times[1];
  const updated = applyStatusChange(original, { status: 'Delivered' }, FIXED);
  assert.equal(updated.times[1], before);
});

/* ----------------------------- helpers ---------------------------- */

test('describeStatus covers every status with a badge and a step', () => {
  for (const status of STATUSES) {
    const info = describeStatus(status);
    assert.ok(info.badgeClass.includes('border'));
    assert.ok(info.step >= 1 && info.step <= 4);
    assert.ok(info.icon.startsWith('fa-'));
  }
  assert.equal(describeStatus('Delivered').step, 4);
});

test('randomTrackingId always produces the SH-##### shape', () => {
  for (let i = 0; i < 500; i += 1) {
    assert.match(randomTrackingId(), /^SH-\d{5}$/);
  }
});

test('randomTrackingId never generates SH-00000..09999 boundaries incorrectly', () => {
  assert.equal(randomTrackingId(() => 0), 'SH-10000');
  assert.equal(randomTrackingId(() => 0.999999), 'SH-99999');
});

test('formatDateTime returns null for junk input', () => {
  assert.equal(formatDateTime(null), null);
  assert.equal(formatDateTime('not a date'), null);
});
