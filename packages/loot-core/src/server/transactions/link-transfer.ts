/**
 * Links two existing transactions as a transfer — the server-side, validated
 * counterpart of the client's "Make transfer" action.
 *
 * Why this exists: writing a bare `transfer_id` is not a transfer. Actual's
 * transfer lifecycle derives the counterpart from the payee, so
 * `transfer.onUpdate` deletes the referenced transaction when the row's payee
 * is not a transfer payee (see PLUGGY_SYNC_RCA.md §2.3). This operation
 * follows the supported flow — reciprocal transfer payees plus reciprocal
 * `transfer_id`, applied with transfer hooks bypassed — but with strict
 * preconditions, a dry-run mode, and post-write verification of every
 * invariant that must not change.
 *
 * It never touches amounts, accounts, dates, notes, or source ids, and it
 * creates no financial rows.
 */

import * as db from '#server/db';

import { batchUpdateTransactions } from '.';

type TransactionRow = {
  id: string;
  account: string;
  amount: number;
  date: string;
  payee: string | null;
  transfer_id: string | null;
  is_parent: boolean;
  is_child: boolean;
  tombstone: boolean;
};

export type LinkTransferChange = {
  id: string;
  payee: string;
  transfer_id: string;
  category: null;
};

export type LinkTransferPlan =
  | { status: 'already-linked'; changes: [] }
  | { status: 'planned'; changes: LinkTransferChange[] };

export type LinkTransferResult = {
  status: 'linked' | 'already-linked' | 'planned';
  changes: LinkTransferChange[];
};

async function loadTransaction(id: string): Promise<TransactionRow> {
  const row = await db.first<TransactionRow>(
    `SELECT id, account, amount, date, payee, transfer_id, is_parent, is_child, tombstone
       FROM v_transactions_internal
      WHERE id = ? AND tombstone = 0`,
    [id],
  );
  if (!row) {
    throw new Error(`Transaction not found: ${id}`);
  }
  return row;
}

async function getTransferPayeeId(accountId: string): Promise<string> {
  const payee = await db.first<{ id: string }>(
    'SELECT id FROM payees WHERE transfer_acct = ? AND tombstone = 0',
    [accountId],
  );
  if (!payee) {
    throw new Error(
      `Account ${accountId} has no transfer payee; refusing to link`,
    );
  }
  return payee.id;
}

/**
 * Validates that two transactions may be linked and returns the changes that
 * would be applied. Throws on anything uncertain — same account, splits,
 * non-opposite amounts, an existing link to something else.
 */
export async function planLinkTransfer(
  fromId: string,
  toId: string,
): Promise<LinkTransferPlan> {
  if (fromId === toId) {
    throw new Error('Cannot link a transaction to itself');
  }

  const [from, to] = await Promise.all([
    loadTransaction(fromId),
    loadTransaction(toId),
  ]);

  if (from.account === to.account) {
    throw new Error('Cannot link two transactions from the same account');
  }
  if (from.is_parent || from.is_child || to.is_parent || to.is_child) {
    throw new Error('Split transactions cannot be linked as transfers');
  }

  if (from.transfer_id === to.id && to.transfer_id === from.id) {
    return { status: 'already-linked', changes: [] };
  }
  if (from.transfer_id != null || to.transfer_id != null) {
    throw new Error(
      'One of the transactions is already linked to a different transfer; resolve that link first',
    );
  }

  if (from.amount !== -to.amount) {
    throw new Error(
      `Amounts are not exact opposites (${from.amount} vs ${to.amount}); refusing to link`,
    );
  }

  const fromTransferPayee = await getTransferPayeeId(from.account);
  const toTransferPayee = await getTransferPayeeId(to.account);

  return {
    status: 'planned',
    changes: [
      {
        id: from.id,
        payee: toTransferPayee,
        transfer_id: to.id,
        category: null,
      },
      {
        id: to.id,
        payee: fromTransferPayee,
        transfer_id: from.id,
        category: null,
      },
    ],
  };
}

/**
 * Applies a transfer link between two existing transactions. Idempotent: a
 * repeat call on an already-linked pair reports `already-linked` and changes
 * nothing. With `dryRun` the plan is returned without writing.
 *
 * After writing, both rows are re-read and the invariants are verified;
 * a failed verification throws with the actual problems instead of retrying.
 */
export async function linkTransfer({
  fromId,
  toId,
  dryRun = false,
}: {
  fromId: string;
  toId: string;
  dryRun?: boolean;
}): Promise<LinkTransferResult> {
  const plan = await planLinkTransfer(fromId, toId);

  if (plan.status === 'already-linked') {
    return { status: 'already-linked', changes: [] };
  }
  if (dryRun) {
    return { status: 'planned', changes: plan.changes };
  }

  const before = await Promise.all([
    loadTransaction(fromId),
    loadTransaction(toId),
  ]);

  // The transfer pointers and payees go through the regular batch path (with
  // transfer hooks bypassed, exactly like the client's "Make transfer" flow);
  // clearing the category is a plain field update. All of it runs inside the
  // caller's mutator, so the messages flush together.
  await batchUpdateTransactions({
    updated: plan.changes.map(({ id, payee, transfer_id }) => ({
      id,
      payee,
      transfer_id,
    })),
    runTransfers: false,
  });
  for (const change of plan.changes) {
    await db.updateTransaction({ id: change.id, category: null });
  }

  const after = await Promise.all([
    loadTransaction(fromId),
    loadTransaction(toId),
  ]);
  const [fromBefore, toBefore] = before;
  const [fromAfter, toAfter] = after;

  const problems: string[] = [];
  if (fromAfter.transfer_id !== toId || toAfter.transfer_id !== fromId) {
    problems.push('transfer pointers are not reciprocal');
  }
  if (
    fromAfter.payee !== plan.changes[0].payee ||
    toAfter.payee !== plan.changes[1].payee
  ) {
    problems.push('transfer payees were not applied');
  }
  if (
    fromAfter.amount !== fromBefore.amount ||
    toAfter.amount !== toBefore.amount
  ) {
    problems.push('amounts changed');
  }
  if (
    fromAfter.account !== fromBefore.account ||
    toAfter.account !== toBefore.account
  ) {
    problems.push('accounts changed');
  }
  if (fromAfter.date !== fromBefore.date || toAfter.date !== toBefore.date) {
    problems.push('dates changed');
  }

  if (problems.length > 0) {
    throw new Error(
      `Transfer link verification failed after applying changes: ${problems.join(
        '; ',
      )}. The records were re-read; inspect them before retrying.`,
    );
  }

  return { status: 'linked', changes: plan.changes };
}
