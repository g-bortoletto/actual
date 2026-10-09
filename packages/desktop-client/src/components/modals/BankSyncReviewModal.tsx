import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgAlertTriangle } from '@actual-app/components/icons/v2';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type { DecisionAction } from '@actual-app/core/server/accounts/sync-observations';
import { q } from '@actual-app/core/shared/query';
import { format as formatDate, parseISO } from 'date-fns';

import {
  buildReviewAuditText,
  isPendingReviewState,
  parseReviewEvidence,
  reviewAmountRange,
} from '#components/banksync/reviewUtils';
import type {
  ReviewAuditLabels,
  ReviewItemRow,
} from '#components/banksync/reviewUtils';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useAccounts } from '#hooks/useAccounts';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { liveQuery } from '#queries/liveQuery';

type BankSyncReviewModalProps = Extract<
  ModalType,
  { name: 'bank-sync-review' }
>['options'];

function decisionLabel(
  state: string | null,
  t: (key: string) => string,
): string | null {
  switch (state) {
    case 'confirmed-single-payment':
      return t('You confirmed these observations are one payment');
    case 'confirmed-separate-payments':
      return t('You confirmed these are separate payments');
    case 'left-unresolved':
      return t('Left unresolved');
    case 'applied':
      return t('Applied');
    default:
      return null;
  }
}

/**
 * Review queue for bank-sync observations that were held out of the ledger.
 *
 * Recording a decision here is a journal entry only — nothing is applied to
 * the ledger yet, and the modal says so explicitly. The ledger keeps the
 * held observations out until the materialization step applies a decision.
 */
export function BankSyncReviewModal({ accountId }: BankSyncReviewModalProps) {
  const { t } = useTranslation();
  const { data: accounts = [] } = useAccounts();
  const format = useFormat();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';

  const [items, setItems] = useState<ReviewItemRow[]>([]);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const query = accountId
      ? q('bank_sync_review_items')
          .filter({ account_id: accountId })
          .select(['id', 'account_id', 'kind', 'state', 'evidence'])
      : q('bank_sync_review_items').select([
          'id',
          'account_id',
          'kind',
          'state',
          'evidence',
        ]);

    const live = liveQuery<ReviewItemRow>(query, {
      onData: rows => setItems(rows),
      onError: () => setItems([]),
    });

    return () => {
      live?.unsubscribe();
    };
  }, [accountId]);

  async function decide(reviewItemId: string, action: DecisionAction) {
    setBusyItemId(reviewItemId);
    setError(null);
    try {
      await send('bank-sync-review-decide', { reviewItemId, action });
      if (action !== 'leave-unresolved') {
        // Materialize right away; if this fails the decision stays recorded
        // as "not yet applied" and can be retried with the Apply button.
        await send('bank-sync-review-apply', { reviewItemId });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyItemId(null);
    }
  }

  async function applyNow(reviewItemId: string) {
    setBusyItemId(reviewItemId);
    setError(null);
    try {
      await send('bank-sync-review-apply', { reviewItemId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyItemId(null);
    }
  }

  const pendingItems = items.filter(item => isPendingReviewState(item.state));

  const accountName = (id: string | null) =>
    accounts.find(account => account.id === id)?.name;

  const formatAmount = (cents: number) => format(cents, 'financial');
  const formatDay = (date: string) => formatDate(parseISO(date), dateFormat);

  const auditLabels: ReviewAuditLabels = {
    title: t('Bank sync review summary'),
    pendingCount: count => t('{{count}} item(s) need review', { count }),
    possibleImpact: t('Possible impact on the card balance:'),
    heldObservations: t('Held observations:'),
    bankCounterpart: t('Possible bank counterpart found:'),
    noDecision: t('No decision recorded yet'),
    decisionRecorded: decision =>
      t('Decision recorded: {{decision}} — not yet applied.', { decision }),
  };

  async function copyAudit() {
    const text = buildReviewAuditText(items, auditLabels, {
      accountName,
      formatAmount,
      formatDate: formatDay,
      decisionLabel: state => decisionLabel(state, t),
      now: new Date().toISOString().slice(0, 10),
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Modal name="bank-sync-review">
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Bank sync review')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ padding: '0 10px 10px' }}>
            <Text style={{ color: theme.pageTextSubdued }}>
              <Trans>
                Some bank transactions look like duplicates and are held out of
                your ledger until you review them. Nothing is applied
                automatically, and the account balance is incomplete while items
                are held.
              </Trans>
            </Text>

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                marginTop: 8,
              }}
            >
              <Button variant="bare" onPress={copyAudit}>
                <Trans>Copy summary</Trans>
              </Button>
              {copied && (
                <Text style={{ color: theme.noticeText }}>
                  <Trans>Copied</Trans>
                </Text>
              )}
            </View>

            {error != null && (
              <Text style={{ color: theme.errorText, marginTop: 8 }}>
                {error}
              </Text>
            )}

            {pendingItems.length === 0 ? (
              <Text style={{ marginTop: 12 }}>
                <Trans>No items need review.</Trans>
              </Text>
            ) : (
              pendingItems.map(item => {
                const evidence = parseReviewEvidence(item.evidence);
                const range = reviewAmountRange(evidence);
                const label = decisionLabel(item.state, t);
                const busy = busyItemId === item.id;

                return (
                  <View
                    key={item.id}
                    data-testid="bank-sync-review-item"
                    style={{
                      marginTop: 12,
                      border: `1px solid ${theme.tableBorder}`,
                      borderRadius: 6,
                      padding: 10,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 5,
                      }}
                    >
                      <SvgAlertTriangle
                        width={12}
                        height={12}
                        style={{ color: theme.warningText }}
                      />
                      <Text style={{ fontWeight: 600 }}>
                        {accountName(item.account_id) != null
                          ? `${accountName(item.account_id)}: `
                          : ''}
                        <Trans>Possible duplicate card payment</Trans>
                      </Text>
                    </View>

                    {range != null && (
                      <Text style={{ marginTop: 4 }}>
                        <Trans>Possible impact on the card balance:</Trans>{' '}
                        <FinancialText>
                          {range.minCents === range.maxCents
                            ? formatAmount(range.minCents)
                            : `${formatAmount(range.minCents)} – ${formatAmount(
                                range.maxCents,
                              )}`}
                        </FinancialText>{' '}
                        {evidence != null &&
                          t('({{count}} held observations)', {
                            count: evidence.observations.length,
                          })}
                      </Text>
                    )}

                    {evidence?.observations.map(observation => (
                      <Text
                        key={observation.observationId}
                        style={{
                          marginTop: 4,
                          color: theme.pageTextSubdued,
                        }}
                      >
                        {formatDay(observation.date)} ·{' '}
                        {observation.description || t('(no description)')} ·{' '}
                        <FinancialText>
                          {formatAmount(observation.amountCents)}
                        </FinancialText>
                        {observation.billReference != null
                          ? ` · ${t('bill')} ${observation.billReference}`
                          : ''}
                        {observation.status != null
                          ? ` · ${observation.status}`
                          : ''}
                      </Text>
                    ))}

                    {evidence?.candidates != null &&
                      evidence.candidates.length > 0 && (
                        <Text
                          style={{ marginTop: 6, color: theme.pageTextSubdued }}
                        >
                          <Trans>Possible bank counterpart found:</Trans>{' '}
                          {evidence.candidates
                            .map(candidate =>
                              [
                                candidate.payeeName ??
                                  accountName(candidate.accountId),
                                formatDay(candidate.date),
                                formatAmount(candidate.amountCents),
                              ]
                                .filter(Boolean)
                                .join(' · '),
                            )
                            .join('; ')}
                        </Text>
                      )}

                    {label != null && (
                      <Text style={{ marginTop: 6, color: theme.noticeText }}>
                        {t(
                          'Decision recorded: {{decision}} — not yet applied.',
                          {
                            decision: label,
                          },
                        )}
                      </Text>
                    )}

                    <View
                      style={{
                        flexDirection: 'row',
                        flexWrap: 'wrap',
                        gap: 8,
                        marginTop: 8,
                      }}
                    >
                      {(item.state === 'confirmed-single-payment' ||
                        item.state === 'confirmed-separate-payments') && (
                        <Button
                          variant="primary"
                          isDisabled={busy}
                          onPress={() => applyNow(item.id)}
                        >
                          <Trans>Apply now</Trans>
                        </Button>
                      )}
                      <Button
                        variant="primary"
                        isDisabled={busy}
                        onPress={() =>
                          decide(item.id, 'confirm-single-payment')
                        }
                      >
                        <Trans>Confirm one payment</Trans>
                      </Button>
                      <Button
                        isDisabled={busy}
                        onPress={() =>
                          decide(item.id, 'confirm-separate-payments')
                        }
                      >
                        <Trans>Confirm separate payments</Trans>
                      </Button>
                      <Button
                        variant="bare"
                        isDisabled={busy}
                        onPress={() => decide(item.id, 'leave-unresolved')}
                      >
                        <Trans>Leave unresolved</Trans>
                      </Button>
                    </View>
                  </View>
                );
              })
            )}
          </View>
        </>
      )}
    </Modal>
  );
}
