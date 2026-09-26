/**
 * VAT rate handling in the app (frontend/src/lib/vatRate.ts).
 *
 * The review form only offered 0/4/5/10/22 and the normalizer rounded every
 * detected rate to the nearest of those, so a 20% receipt (UK, France) was
 * saved and exported as 22%, a 19% one (Germany) as 22%, a 7% one as 5%, and a
 * printed 0% became 22 because 0 is falsy. These cases pin the fix.
 *
 * Runs on plain Node (>= 22.7, no dependencies):
 *     node --experimental-strip-types test/test_vat_rate.mjs
 */
import assert from 'node:assert/strict';
import {
  COMMON_VAT_RATES,
  inferVatRate,
  normalizeVatRateInput,
  parseVatAmountInput,
  parseVatRate,
  suggestVatRate,
} from '../frontend/src/lib/vatRate.ts';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('a detected rate is kept, not mapped onto 0/4/5/10/22', () => {
  for (const rate of [20, 19, 21, 7, 6, 12, 13, 23, 25]) {
    assert.equal(parseVatRate(rate), String(rate), `${rate}% must stay ${rate}%`);
  }
});

test('non-integer rates survive', () => {
  assert.equal(parseVatRate(7.7), '7.7');
  assert.equal(parseVatRate(5.5), '5.5');
  assert.equal(parseVatRate('8.1%'), '8.1');
  assert.equal(parseVatRate('19,6 %'), '19.6');
});

test('a printed 0% is a rate, not "missing"', () => {
  assert.equal(parseVatRate(0), '0');
  assert.equal(parseVatRate('0%'), '0');
});

test('formats coming from the API and from saved data', () => {
  assert.equal(parseVatRate('A 22.00%'), '22');
  assert.equal(parseVatRate('22'), '22');
  assert.equal(parseVatRate('20.0'), '20');
});

test('inferred rates lose their cent-rounding noise', () => {
  assert.equal(parseVatRate(19.98), '20');
  assert.equal(parseVatRate(22.01), '22');
  assert.equal(parseVatRate(9.52), '9.5');
});

test('missing or nonsensical values give an empty rate', () => {
  for (const v of [undefined, null, '', 'abc', 150, -3, NaN, {}]) {
    assert.equal(parseVatRate(v), '', `${String(v)} must not produce a rate`);
  }
});

test('what the user types is accepted in common forms', () => {
  assert.equal(normalizeVatRateInput('20'), '20');
  assert.equal(normalizeVatRateInput(' 19 '), '19');
  assert.equal(normalizeVatRateInput('7,7'), '7.7');
  assert.equal(normalizeVatRateInput('20%'), '20');
  assert.equal(normalizeVatRateInput('20.0'), '20');
  assert.equal(normalizeVatRateInput('0'), '0');
});

test('what is not a rate is rejected', () => {
  for (const v of ['', ' ', 'abc', '-5', '101', '1e2', '20 %%', '2 0']) {
    assert.equal(normalizeVatRateInput(v), null, `${JSON.stringify(v)} must be rejected`);
  }
});

test('the suggestions cover the main rates in use', () => {
  for (const rate of ['0', '4', '5', '10', '19', '20', '21', '22']) {
    assert.ok(COMMON_VAT_RATES.includes(rate), `${rate} missing from suggestions`);
  }
});

test('a rate is inferred from total and VAT, with the same window as the backend', () => {
  assert.equal(inferVatRate(12.2, 2.2), '22');
  assert.equal(inferVatRate(12, 2), '20');
  assert.equal(inferVatRate(2.97, 0.27), '10');
  for (const [total, vat] of [[100, 0], [null, 2], [2, null], [5, 5], [100, 60], [100, 0.1]]) {
    assert.equal(inferVatRate(total, vat), '', `${total}/${vat} is not a plausible rate`);
  }
});

test('typing the amounts pre-fills the rate', () => {
  assert.equal(suggestVatRate('12,20', '2,20'), '22');
  assert.equal(suggestVatRate('12,00', '2,00'), '20');
});

test('no VAT typed means no VAT: rate 0', () => {
  assert.equal(suggestVatRate('12,20', ''), '0');
  assert.equal(suggestVatRate('12,20', '0'), '0');
  assert.equal(suggestVatRate('', ''), '0');
});

test('when there is nothing sensible to suggest the field is left alone', () => {
  assert.equal(suggestVatRate('', '2'), null);
  assert.equal(suggestVatRate('12', 'abc'), null);
});

test('an empty VAT amount is accepted as 0; junk is not', () => {
  assert.equal(parseVatAmountInput(''), 0);
  assert.equal(parseVatAmountInput('   '), 0);
  assert.equal(parseVatAmountInput('0'), 0);
  assert.equal(parseVatAmountInput('2,20'), 2.2);
  assert.equal(parseVatAmountInput('abc'), null);
});

let failures = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
