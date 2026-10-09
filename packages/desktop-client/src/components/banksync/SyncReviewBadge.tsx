import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgAlertTriangle } from '@actual-app/components/icons/v2';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { q } from '@actual-app/core/shared/query';

import { pushModal } from '#modals/modalsSlice';
import { liveQuery } from '#queries/liveQuery';
import { useDispatch } from '#redux';

import { isPendingReviewState } from './reviewUtils';

type SyncReviewBadgeProps = {
  accountId: string;
};

/**
 * "Sync incomplete — N to review" indicator shown beside the account balance
 * while bank-sync observations are held out of the ledger awaiting a decision.
 * The balance is knowingly incomplete in that state; this badge is the entry
 * point to resolve it.
 */
export function SyncReviewBadge({ accountId }: SyncReviewBadgeProps) {
  const dispatch = useDispatch();
  const { t } = useTranslation();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const query = q('bank_sync_review_items')
      .filter({ account_id: accountId })
      .select(['id', 'state']);

    const live = liveQuery<{ id: string; state: string | null }>(query, {
      onData: rows => {
        setPendingCount(
          rows.filter(row => isPendingReviewState(row.state)).length,
        );
      },
      onError: () => {
        setPendingCount(0);
      },
    });

    return () => {
      live?.unsubscribe();
    };
  }, [accountId]);

  if (pendingCount === 0) {
    return null;
  }

  return (
    <Button
      variant="bare"
      data-testid="sync-review-badge"
      onPress={() =>
        dispatch(
          pushModal({
            modal: { name: 'bank-sync-review', options: { accountId } },
          }),
        )
      }
      style={{ padding: 0 }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          borderRadius: 4,
          padding: '4px 6px',
          color: theme.warningText,
          backgroundColor: theme.warningBackground,
        }}
      >
        <SvgAlertTriangle width={12} height={12} />
        <Text style={{ color: theme.warningText, fontWeight: 600 }}>
          {t('Sync incomplete — {{count}} to review', {
            count: pendingCount,
          })}
        </Text>
      </View>
    </Button>
  );
}
