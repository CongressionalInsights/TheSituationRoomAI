import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseExecutiveOrderFeed as parseCaliforniaExecutiveOrders } from '../adapters/ca.js';
import { parseExecutiveOrders as parseFloridaExecutiveOrders } from '../adapters/fl.js';
import { parseExecutiveOrderRows as parseMinnesotaExecutiveOrders } from '../adapters/mn.js';
import { parseExecutiveOrders as parseNewYorkExecutiveOrders } from '../adapters/ny.js';
import { parseExecutiveOrders as parseTexasExecutiveOrders } from '../adapters/tx.js';
import { parseExecutiveOrders as parseVirginiaExecutiveOrders } from '../adapters/va.js';
import { isoDate } from '../adapters/helpers.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name) {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

test('date-only source values normalize to UTC midnight regardless of host timezone', () => {
  assert.equal(isoDate('05/17/2026'), '2026-05-17T00:00:00.000Z');
  assert.equal(isoDate('April 22, 2026'), '2026-04-22T00:00:00.000Z');
  assert.equal(isoDate('Sept. 10, 2025'), '2025-09-10T00:00:00.000Z');
  assert.equal(isoDate('Monday, 29 Jun 2026'), '2026-06-29T00:00:00.000Z');
});

test('California executive order feed keeps title, URL, date, and agency scoped to one item', () => {
  const rows = parseCaliforniaExecutiveOrders(fixture('ca-executive-orders.xml'));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    pickStable(rows[0]),
    {
      id: 'CA:executive_order:Governor Newsom signs executive order on responsible AI',
      title: 'Governor Newsom signs executive order on responsible AI',
      url: 'https://www.gov.ca.gov/2026/05/21/governor-newsom-signs-executive-order-on-responsible-ai/',
      agency: 'Office of the Governor'
    }
  );
  assert.equal(rows[0].updatedAt, '2026-05-21T15:00:27.000Z');
});

test('Florida executive order table keeps title, URL, date, and agency scoped to one row', () => {
  const rows = parseFloridaExecutiveOrders(fixture('fl-executive-orders.html'));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    pickStable(rows[0]),
    {
      id: 'FL:executive_order:#2026-132 assigns the 17th circuit to the 15th circuit re: Checree Bryant',
      title: '#2026-132 assigns the 17th circuit to the 15th circuit re: Checree Bryant',
      url: 'https://www.flgov.com/eog/sites/default/files/executive-orders/2026/EO%2026-132.pdf',
      agency: 'Executive Office of the Governor'
    }
  );
  assert.equal(rows[0].updatedAt, '2026-07-01T12:00:00.000Z');
});

test('Minnesota executive order table keeps title, URL, date, and agency scoped to one row', () => {
  const rows = parseMinnesotaExecutiveOrders(fixture('mn-executive-orders.html'));
  assert.equal(rows.length, 3);
  assert.deepEqual(
    pickStable(rows[0]),
    {
      id: 'MN:executive_order:26-07',
      title: 'Declaring a Peacetime Emergency and Continuing Assistance to Communities Impacted by Wildfires',
      url: 'https://www.lrl.mn.gov/archive/execorders/2026-07.pdf',
      agency: 'Office of the Governor'
    }
  );
  assertDatePart(rows[0], '2026-05-17');
  assert.ok(!rows[0].agency.includes('26-05'));
  assert.ok(!rows[0].title.includes('26-05'));
});

test('New York executive order listing keeps title, URL, date, and agency scoped to one article', () => {
  const rows = parseNewYorkExecutiveOrders(fixture('ny-executive-orders.html'));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    pickStable(rows[0]),
    {
      id: 'NY:executive_order:No. 60: Prohibiting State Employees from Profiting on Insider Information',
      title: 'No. 60: Prohibiting State Employees from Profiting on Insider Information',
      url: 'https://www.governor.ny.gov/executive-order/no-60-prohibiting-state-employees-profiting-insider-information',
      agency: 'Office of the Governor'
    }
  );
  assertDatePart(rows[0], '2026-04-22');
});

test('Texas executive order table keeps title, URL, date, and agency scoped to one row', () => {
  const rows = parseTexasExecutiveOrders(fixture('tx-executive-orders.html'));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    pickStable(rows[0]),
    {
      id: 'TX:executive_order:Executive Order GA-56 Relating to protecting children from hemp and hemp-derived products',
      title: 'Executive Order GA-56 Relating to protecting children from hemp and hemp-derived products',
      url: 'https://lrl.texas.gov/scanned/govdocs/Greg%20Abbott/2025/GA-56.pdf',
      agency: 'Office of the Governor'
    }
  );
  assertDatePart(rows[0], '2025-09-10');
});

test('Virginia executive order listing keeps title, URL, date, and agency scoped to one entry', () => {
  const rows = parseVirginiaExecutiveOrders(fixture('va-executive-orders.html'));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    pickStable(rows[0]),
    {
      id: 'VA:executive_order:EO-18 Designation of Executive Branch Officers and Employees Required to File Financial Disclosure Statements',
      title: 'EO-18 Designation of Executive Branch Officers and Employees Required to File Financial Disclosure Statements',
      url: 'https://www.governor.virginia.gov/media/governorvirginiagov/governor-of-virginia/pdf/eo/eo-18-executive-financial-disclosures.pdf',
      agency: 'Office of the Governor'
    }
  );
  assertDatePart(rows[0], '2026-06-30');
});

function pickStable(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    agency: row.agency
  };
}

function assertDatePart(row, expectedDate) {
  assert.equal(row.updatedAt.slice(0, 10), expectedDate);
}
