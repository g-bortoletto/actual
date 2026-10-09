import type {
  DecisionAction,
  ReviewEvidence,
  ReviewItemState,
} from '@actual-app/core/server/accounts/sync-observations';

/**
 * Client-side view helpers for bank-sync review items. The loot-core tables
 * store the evidence and observation ids as JSON strings, so everything the UI
 * renders goes through here first.
 */

export type ReviewItemRow = {
  id: string;
  account_id: string | null;
  kind: string | null;
  state: string | null;
  evidence: string | null;
};

const REVIEW_ITEM_STATES: ReviewItemState[] = [
  'pending',
  'confirmed-single-payment',
  'confirmed-separate-payments',
  'left-unresolved',
  'applied',
];

const DECISION_ACTIONS: DecisionAction[] = [
  'confirm-single-payment',
  'confirm-separate-payments',
  'leave-unresolved',
];

export function isReviewItemState(
  value: string | null,
): value is ReviewItemState {
  return value != null && (REVIEW_ITEM_STATES as string[]).includes(value);
}

export function isDecisionAction(value: string): value is DecisionAction {
  return (DECISION_ACTIONS as string[]).includes(value);
}

/**
 * An item is "pending" while it has not reached the ledger yet — including
 * after a decision was recorded but before it was applied.
 */
export function isPendingReviewState(state: string | null): boolean {
  return state !== 'applied';
}

function isReviewEvidence(value: unknown): value is ReviewEvidence {
  return (
    value != null &&
    typeof value === 'object' &&
    'observations' in value &&
    Array.isArray(value.observations) &&
    'heldAmountCents' in value &&
    typeof value.heldAmountCents === 'number'
  );
}

export function parseReviewEvidence(raw: string | null): ReviewEvidence | null {
  if (raw == null || raw === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isReviewEvidence(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The uncertainty window of a review item: what the ledger is missing if the
 * observations turn out to be one payment (min) versus separate payments
 * (max).
 */
export function reviewAmountRange(
  evidence: ReviewEvidence | null,
): { minCents: number; maxCents: number } | null {
  if (evidence == null) {
    return null;
  }
  const maxCents = evidence.heldAmountCents;
  const minCents = evidence.minScenarioAmountCents ?? maxCents;
  return { minCents, maxCents };
}

export type ReviewAuditLabels = {
  title: string;
  pendingCount: (count: number) => string;
  possibleImpact: string;
  heldObservations: string;
  bankCounterpart: string;
  noDecision: string;
  decisionRecorded: (decision: string) => string;
};

type ReviewAuditHelpers = {
  accountName: (accountId: string | null) => string | undefined;
  formatAmount: (cents: number) => string;
  formatDate: (date: string) => string;
  decisionLabel: (state: string | null) => string | null;
  now: string;
};

/**
 * Plain-language audit of the review queue, for copying into a message or a
 * report. All prose comes from `labels` (i18n lives in the UI layer); this
 * function only lays the data out.
 */
export function buildReviewAuditText(
  items: ReviewItemRow[],
  labels: ReviewAuditLabels,
  helpers: ReviewAuditHelpers,
): string {
  const pendingItems = items.filter(item => isPendingReviewState(item.state));
  const lines: string[] = [
    `${labels.title} (${helpers.now})`,
    labels.pendingCount(pendingItems.length),
  ];

  pendingItems.forEach((item, index) => {
    const evidence = parseReviewEvidence(item.evidence);
    const range = reviewAmountRange(evidence);
    const name = helpers.accountName(item.account_id) ?? item.account_id ?? '';

    lines.push('');
    lines.push(`${index + 1}. ${name}`);

    if (range != null) {
      const amountText =
        range.minCents === range.maxCents
          ? helpers.formatAmount(range.minCents)
          : `${helpers.formatAmount(range.minCents)} – ${helpers.formatAmount(
              range.maxCents,
            )}`;
      lines.push(`   ${labels.possibleImpact} ${amountText}`);
    }

    if (evidence != null && evidence.observations.length > 0) {
      lines.push(`   ${labels.heldObservations}`);
      for (const observation of evidence.observations) {
        const parts = [
          helpers.formatDate(observation.date),
          observation.description,
          helpers.formatAmount(observation.amountCents),
        ];
        if (observation.billReference != null) {
          parts.push(observation.billReference);
        }
        if (observation.status != null) {
          parts.push(observation.status);
        }
        lines.push(`   - ${parts.filter(Boolean).join(' · ')}`);
      }
    }

    if (evidence?.candidates != null && evidence.candidates.length > 0) {
      for (const candidate of evidence.candidates) {
        lines.push(
          `   ${labels.bankCounterpart} ${[
            candidate.payeeName ?? helpers.accountName(candidate.accountId),
            helpers.formatDate(candidate.date),
            helpers.formatAmount(candidate.amountCents),
          ]
            .filter(Boolean)
            .join(' · ')}`,
        );
      }
    }

    const decision = helpers.decisionLabel(item.state);
    lines.push(
      `   ${decision != null ? labels.decisionRecorded(decision) : labels.noDecision}`,
    );
  });

  return lines.join('\n');
}
