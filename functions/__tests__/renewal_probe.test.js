process.env.NODE_ENV = 'test';
const { needsTierCreditRenewal, calendarDayDiff } = require('../index');

describe('Tier credit renewal probe', () => {
    test('R1: Jan-31 stamp blocks Feb-1 double grant (month-end leak)', () => {
        const raw = { tier: 'standard', tierCredits: 100, lastTierCreditRenewalAt: '2025-01-31' };
        const needs = needsTierCreditRenewal(raw, '2025-02-01');
        console.log('PROBE_RESULT ' + JSON.stringify({ scenario: 'R1_month_end', needsRenewal: needs, daysSince: calendarDayDiff('2025-01-31', '2025-02-01') }));
        expect(needs).toBe(false);
    });

    test('R2: 30+ days since last renewal triggers refresh', () => {
        const raw = { tier: 'free', tierCredits: 5, lastTierCreditRenewalAt: '2025-01-01' };
        const needs = needsTierCreditRenewal(raw, '2025-02-01');
        console.log('PROBE_RESULT ' + JSON.stringify({ scenario: 'R2_30_day', needsRenewal: needs, daysSince: calendarDayDiff('2025-01-01', '2025-02-01') }));
        expect(needs).toBe(true);
    });

    test('R3: legacy same-month YYYY-MM does not re-grant', () => {
        const raw = { tier: 'free', tierCredits: 10, subscriptionRenewalDate: '2025-06' };
        const needs = needsTierCreditRenewal(raw, '2025-06-14');
        console.log('PROBE_RESULT ' + JSON.stringify({ scenario: 'R3_legacy_same_month', needsRenewal: needs }));
        expect(needs).toBe(false);
    });

    test('R4: legacy prior-month YYYY-MM still renews', () => {
        const raw = { tier: 'free', tierCredits: 0, subscriptionRenewalDate: '2025-05' };
        const needs = needsTierCreditRenewal(raw, '2025-06-01');
        console.log('PROBE_RESULT ' + JSON.stringify({ scenario: 'R4_legacy_new_month', needsRenewal: needs }));
        expect(needs).toBe(true);
    });
});
