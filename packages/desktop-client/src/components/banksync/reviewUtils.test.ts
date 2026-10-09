import { describe, expect, it } from 'vitest';

import {
  buildReviewAuditText,
  isDecisionAction,
  isPendingReviewState,
  parseReviewEvidence,
  reviewAmountRange,
} from './reviewUtils';
import type { ReviewAuditLabels } from './reviewUtils';

const validEvidence = JSON.stringify({
  observations: [
    {
      observationId: 'card:a',
      date: '2026-09-25',
      amountCents: 10000,
      description: 'Pagamento recebido',
    },
    {
      observationId: 'card:b',
      date: '2026-09-25',
      amountCents: 10000,
      description: 'Pagamento recebido',
    },
  ],
  heldAmountCents: 20000,
  minScenarioAmountCents: 10000,
});

describe('reviewUtils', () => {
  it('parses valid evidence', () => {
    const evidence = parseReviewEvidence(validEvidence);
    expect(evidence?.observations).toHaveLength(2);
    expect(evidence?.heldAmountCents).toBe(20000);
  });

  it('returns null for missing or invalid evidence', () => {
    expect(parseReviewEvidence(null)).toBeNull();
    expect(parseReviewEvidence('')).toBeNull();
    expect(parseReviewEvidence('not json')).toBeNull();
    expect(parseReviewEvidence('{"foo": 1}')).toBeNull();
  });

  it('treats every state except applied as pending', () => {
    expect(isPendingReviewState('pending')).toBe(true);
    expect(isPendingReviewState('confirmed-single-payment')).toBe(true);
    expect(isPendingReviewState('left-unresolved')).toBe(true);
    expect(isPendingReviewState('applied')).toBe(false);
    expect(isPendingReviewState(null)).toBe(true);
  });

  it('computes the uncertainty window', () => {
    expect(reviewAmountRange(parseReviewEvidence(validEvidence))).toEqual({
      minCents: 10000,
      maxCents: 20000,
    });

    const withoutMin = parseReviewEvidence(
      JSON.stringify({
        observations: [],
        heldAmountCents: 5000,
      }),
    );
    expect(reviewAmountRange(withoutMin)).toEqual({
      minCents: 5000,
      maxCents: 5000,
    });
    expect(reviewAmountRange(null)).toBeNull();
  });

  it('validates decision actions', () => {
    expect(isDecisionAction('confirm-single-payment')).toBe(true);
    expect(isDecisionAction('confirm-separate-payments')).toBe(true);
    expect(isDecisionAction('leave-unresolved')).toBe(true);
    expect(isDecisionAction('delete')).toBe(false);
  });
});

describe('buildReviewAuditText', () => {
  const labels: ReviewAuditLabels = {
    title: 'Bank sync review summary',
    pendingCount: count => `${count} item(s) need review`,
    possibleImpact: 'Possible impact:',
    heldObservations: 'Held observations:',
    bankCounterpart: 'Bank counterpart:',
    noDecision: 'No decision recorded yet',
    decisionRecorded: decision =>
      `Decision recorded: ${decision} — not yet applied.`,
  };

  const helpers = {
    accountName: (id: string | null) =>
      id === 'card' ? 'Credit Card' : undefined,
    formatAmount: (cents: number) => `${(cents / 100).toFixed(2)} BRL`,
    formatDate: (date: string) => date,
    decisionLabel: (state: string | null) =>
      state === 'pending' || state == null
        ? null
        : state === 'applied'
          ? 'Applied'
          : 'Left unresolved',
    now: '2026-10-08',
  };

  it('summarizes pending items with observations and candidates', () => {
    const text = buildReviewAuditText(
      [
        {
          id: 'item-1',
          account_id: 'card',
          kind: 'ambiguous-payment',
          state: 'pending',
          evidence: JSON.stringify({
            observations: [
              {
                observationId: 'card:a',
                date: '2026-09-25',
                amountCents: 10000,
                description: 'Pagamento recebido',
                billReference: 'closed-bill-A',
                status: 'POSTED',
              },
              {
                observationId: 'card:b',
                date: '2026-09-25',
                amountCents: 10000,
                description: 'Pagamento recebido',
              },
            ],
            candidates: [
              {
                transactionId: 't1',
                accountId: 'bank',
                date: '2026-09-25',
                amountCents: -10000,
                payeeName: 'Pagamento de fatura',
              },
            ],
            heldAmountCents: 20000,
            minScenarioAmountCents: 10000,
          }),
        },
      ],
      labels,
      helpers,
    );

    expect(text).toContain('Bank sync review summary (2026-10-08)');
    expect(text).toContain('1 item(s) need review');
    expect(text).toContain('1. Credit Card');
    expect(text).toContain('Possible impact: 100.00 BRL – 200.00 BRL');
    expect(text).toContain(
      '- 2026-09-25 · Pagamento recebido · 100.00 BRL · closed-bill-A · POSTED',
    );
    expect(text).toContain(
      'Bank counterpart: Pagamento de fatura · 2026-09-25 · -100.00 BRL',
    );
    expect(text).toContain('No decision recorded yet');
  });

  it('excludes applied items and shows recorded decisions', () => {
    const text = buildReviewAuditText(
      [
        {
          id: 'a',
          account_id: 'card',
          kind: null,
          state: 'applied',
          evidence: null,
        },
        {
          id: 'b',
          account_id: 'card',
          kind: null,
          state: 'left-unresolved',
          evidence: null,
        },
      ],
      labels,
      helpers,
    );

    expect(text).toContain('1 item(s) need review');
    expect(text).toContain(
      'Decision recorded: Left unresolved — not yet applied.',
    );
    expect(text).not.toContain('Applied');
  });
});
