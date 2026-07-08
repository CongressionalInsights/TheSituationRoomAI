import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseExecutiveOrderFeed as parseCaliforniaExecutiveOrders } from '../adapters/ca.js';
import { parseNoticeRegisterMonths as parseCaliforniaRulemaking } from '../adapters/ca.js';
import {
  parseExecutiveOrders as parseFloridaExecutiveOrders,
  parseRulemaking as parseFloridaRulemaking
} from '../adapters/fl.js';
import {
  parseExecutiveOrderRows as parseMinnesotaExecutiveOrders,
  parseRegisterIssues as parseMinnesotaRulemaking
} from '../adapters/mn.js';
import {
  parseExecutiveOrders as parseNewYorkExecutiveOrders,
  parseStateRegister as parseNewYorkRulemaking
} from '../adapters/ny.js';
import {
  parseExecutiveOrders as parseTexasExecutiveOrders,
  parseRulemakingFeed as parseTexasRulemaking
} from '../adapters/tx.js';
import {
  parseExecutiveOrders as parseVirginiaExecutiveOrders,
  parseRulemakingFeed as parseVirginiaRulemaking
} from '../adapters/va.js';
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

test('California rulemaking parser emits notice-register issues and skips surrounding navigation', () => {
  const rows = parseCaliforniaRulemaking(fixture('ca-rulemaking.html'));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => pickStable(row)),
    [
      {
        id: 'CA:rulemaking:2026-February',
        title: 'California Regulatory Notice Register: February 2026',
        url: 'https://oal.ca.gov/february-2026-notice-register/',
        agency: 'Office of Administrative Law'
      },
      {
        id: 'CA:rulemaking:2026-March',
        title: 'California Regulatory Notice Register: March 2026',
        url: 'https://oal.ca.gov/march-2026-notice-register/',
        agency: 'Office of Administrative Law'
      }
    ]
  );
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

test('Florida rulemaking parser emits the current administrative register issue', () => {
  const rows = parseFloridaRulemaking(fixture('fl-rulemaking.html'), {
    url: 'https://flrules.org/gateway/recentIssue.asp',
    lastModified: 'Tue, 07 Jul 2026 17:46:11 GMT'
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    pickStable(rows[0]),
    {
      id: 'FL:rulemaking:4681',
      title: 'Florida Administrative Register: Vol. 52 No. 1',
      url: 'https://flrules.org/gateway/recentIssue.asp',
      agency: 'Florida Department of State'
    }
  );
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

test('Minnesota rulemaking parser emits issue rows and skips non-issue navigation rows', () => {
  const rows = parseMinnesotaRulemaking(
    fixture('mn-rulemaking.html'),
    'https://www.revisor.mn.gov/state_register/51/',
    '51'
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => pickStable(row)),
    [
      {
        id: 'MN:rulemaking:51:1',
        title: 'Minnesota State Register: Volume 51, Number 1',
        url: 'https://www.revisor.mn.gov/state_register/51/1/',
        agency: 'Minnesota Department of Administration'
      },
      {
        id: 'MN:rulemaking:51:2',
        title: 'Minnesota State Register: Volume 51, Number 2',
        url: 'https://www.revisor.mn.gov/state_register/51/2/',
        agency: 'Minnesota Department of Administration'
      }
    ]
  );
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

test('New York rulemaking parser emits state-register documents and skips other articles', () => {
  const rows = parseNewYorkRulemaking(fixture('ny-rulemaking.html'));
  assert.equal(rows.length, 1);
  assert.deepEqual(
    pickStable(rows[0]),
    {
      id: 'NY:rulemaking:July 1, 2026/Vol. XLVIII, Issue 26',
      title: 'New York State Register: July 1, 2026/Vol. XLVIII, Issue 26',
      url: 'https://dos.ny.gov/july-1-2026vol-xlviii-issue-26',
      agency: 'New York Department of State'
    }
  );
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

test('Texas rulemaking parser emits one canonical dated issue and drops PDF/archive navigation', () => {
  const rows = parseTexasRulemaking(fixture('tx-rulemaking.xml'));
  assert.equal(rows.length, 1);
  assert.deepEqual(
    pickStable(rows[0]),
    {
      id: 'TX:rulemaking:July 3, 2026',
      title: 'Texas Register issue for July 3, 2026',
      url: 'http://www.sos.state.tx.us/texreg/archive/July32026/index.html',
      agency: 'Texas Secretary of State'
    }
  );
  assert.equal(rows[0].updatedAt, '2026-07-03T00:00:00.000Z');
  assert.match(rows[0].summary, /PDF rendering: http:\/\/www\.sos\.state\.tx\.us\/texreg\/pdf\/backview\/0703\/index\.shtml/);
  assert.ok(!rows.some((row) => /PDF format|available electronically|1976/i.test(`${row.title} ${row.updatedAt}`)));
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

test('Virginia rulemaking parser emits register issues and skips RSS navigation entries', () => {
  const rows = parseVirginiaRulemaking(fixture('va-rulemaking.xml'));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => pickStable(row)),
    [
      {
        id: 'VA:rulemaking:Volume 42, Issue 23 - Monday, 29 Jun 2026',
        title: 'Virginia Register of Regulations: Volume 42, Issue 23 - Monday, 29 Jun 2026',
        url: 'http://register.dls.virginia.gov/toc.aspx?voliss=42:23',
        agency: 'Virginia Code Commission'
      },
      {
        id: 'VA:rulemaking:Volume 42, Issue 22 - Monday, 15 Jun 2026',
        title: 'Virginia Register of Regulations: Volume 42, Issue 22 - Monday, 15 Jun 2026',
        url: 'http://register.dls.virginia.gov/toc.aspx?voliss=42:22',
        agency: 'Virginia Code Commission'
      }
    ]
  );
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
