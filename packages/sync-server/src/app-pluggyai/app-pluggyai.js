import express from 'express';

import { isAdmin } from '#account-db';
import { handleError } from '#app-gocardless/util/handle-error';
import { SecretName, secretsService } from '#services/secrets-service';
import * as UserService from '#services/user-service';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '#util/middlewares';
import { isValidFileId } from '#util/paths';

import { pluggyaiService } from './pluggyai-service';

const app = express();
export { app as handlers };
app.use(requestLoggerMiddleware);
app.use(express.json());
app.use(validateSessionMiddleware);

function canAccessFile(fileId, userId) {
  return isAdmin(userId) || UserService.countUserAccess(fileId, userId) > 0;
}

app.post(
  '/status',
  handleError(async (req, res) => {
    const fileId = req.get('X-Actual-File-Id');
    if (!!fileId) {
      if (!isValidFileId(fileId)) {
        res.status(400).send({
          status: 'error',
          reason: 'invalid-file-id',
          details: 'invalid fileId',
        });
        return;
      }

      if (!canAccessFile(fileId, res.locals.user_id)) {
        res.status(403).send({
          status: 'error',
          reason: 'file-access-denied',
          details: "You don't have permissions over this file",
        });
        return;
      }
    }

    const source = pluggyaiService.getCredentialSource(fileId);

    res.send({
      status: 'ok',
      data: {
        configured: !!source,
        source,
      },
    });
  }),
);

app.post(
  '/accounts',
  handleError(async (req, res) => {
    const fileId = req.get('X-Actual-File-Id');
    if (!!fileId) {
      if (!isValidFileId(fileId)) {
        res.status(400).send({
          status: 'error',
          reason: 'invalid-file-id',
          details: 'invalid fileId',
        });
        return;
      }

      if (!canAccessFile(fileId, res.locals.user_id)) {
        res.status(403).send({
          status: 'error',
          reason: 'file-access-denied',
          details: "You don't have permissions over this file",
        });
        return;
      }
    }

    try {
      const source = pluggyaiService.getCredentialSource(fileId);
      if (!source) {
        res.status(400).send({
          status: 'error',
          reason: 'not-configured',
          details: 'Pluggy credentials are not configured',
        });
        return;
      }

      const credentialFileId = source === 'per-budget-file' ? fileId : null;
      const itemIds = (
        secretsService.get(SecretName.pluggyai_itemIds, credentialFileId) ?? ''
      )
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);

      let accounts = [];

      for (const item of itemIds) {
        const partial = await pluggyaiService.getAccountsByItemId(item, fileId);
        accounts = accounts.concat(partial.results);
      }

      res.send({
        status: 'ok',
        data: {
          accounts,
        },
      });
    } catch (error) {
      res.send({
        status: 'ok',
        data: {
          error: error.message,
        },
      });
    }
  }),
);

app.post(
  '/transactions',
  handleError(async (req, res) => {
    const { accountId, startDate } = req.body || {};
    const fileId = req.get('X-Actual-File-Id');
    if (!!fileId) {
      if (!isValidFileId(fileId)) {
        res.status(400).send({
          status: 'error',
          reason: 'invalid-file-id',
          details: 'invalid fileId',
        });
        return;
      }

      if (!canAccessFile(fileId, res.locals.user_id)) {
        res.status(403).send({
          status: 'error',
          reason: 'file-access-denied',
          details: "You don't have permissions over this file",
        });
        return;
      }
    }

    try {
      const source = pluggyaiService.getCredentialSource(fileId);
      if (!source) {
        res.status(400).send({
          status: 'error',
          reason: 'not-configured',
          details: 'Pluggy credentials are not configured',
        });
        return;
      }

      const transactions = await pluggyaiService.getTransactionsByAccountId(
        accountId,
        startDate,
        fileId,
      );

      const account = await pluggyaiService.getAccountById(accountId, fileId);

      let startingBalance = parseInt(
        Math.round(account.balance * 100).toString(),
      );
      if (account.type === 'CREDIT') {
        startingBalance = -startingBalance;
      }
      const date = getDate(account.updatedAt);

      const balances = [
        {
          balanceAmount: {
            amount: startingBalance,
            currency: account.currencyCode,
          },
          balanceType: 'expected',
          referenceDate: date,
        },
      ];

      const all = [];
      const booked = [];
      const pending = [];

      for (const trans of Object.values(transactions)) {
        const finalTrans = preparePluggyTransaction(trans, {
          accountType: account.type,
          startDate,
        });

        if (finalTrans === null) {
          continue;
        }

        if (finalTrans.booked) {
          booked.push(finalTrans);
        } else {
          pending.push(finalTrans);
        }
        all.push(finalTrans);
      }

      const sortFunction = (a, b) => b.sortOrder - a.sortOrder;

      const bookedSorted = booked.sort(sortFunction);
      const pendingSorted = pending.sort(sortFunction);
      const allSorted = all.sort(sortFunction);

      res.send({
        status: 'ok',
        data: {
          balances,
          startingBalance,
          transactions: {
            all: allSorted,
            booked: bookedSorted,
            pending: pendingSorted,
          },
        },
      });
    } catch (error) {
      res.send({
        status: 'ok',
        data: {
          error: error.message,
        },
      });
    }
    return;
  }),
);

function getDate(date) {
  return date.toISOString().split('T')[0];
}

function flattenObject(obj, prefix = '') {
  const result = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (value === null) {
      continue;
    }

    if (value instanceof Date) {
      // Date values (purchaseDate, createdAt, ...) would otherwise vanish:
      // Object.entries(new Date()) is empty, so the recursion below drops them.
      result[newKey] = getDate(value);
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, newKey));
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

function getPayeeName(trans) {
  if (trans.merchant && (trans.merchant.name || trans.merchant.businessName)) {
    return trans.merchant.name || trans.merchant.businessName || '';
  }

  if (trans.paymentData) {
    const { receiver, payer } = trans.paymentData;

    if (trans.type === 'DEBIT' && receiver) {
      return receiver.name || receiver.documentNumber?.value || '';
    }

    if (trans.type === 'CREDIT' && payer) {
      return payer.name || payer.documentNumber?.value || '';
    }
  }

  return '';
}

/**
 * Maps one Pluggy transaction into the shape Actual's bank sync expects.
 *
 * `date` is the provider's posting date, kept as-is for every row, including
 * card installments. Do not recompute it from
 * `creditCardMetadata.purchaseDate` + `installmentNumber`: the provider already
 * reports when each installment posted, and `purchaseDate` is sometimes
 * inconsistent with the installment series, which shifted real dates by whole
 * months. Purchase date and the rest of the credit-card metadata stay in the
 * payload as evidence.
 *
 * Returns null for empty rows and for rows older than `startDate` (sandbox rows
 * ignore the cutoff).
 */
export function preparePluggyTransaction(trans, { accountType, startDate }) {
  if (typeof trans !== 'object' || Object.keys(trans).length === 0) {
    return null;
  }

  const newTrans = {};

  newTrans.booked = !(trans.status === 'PENDING');

  const transactionDate = trans.date;

  if (transactionDate < startDate && !trans.sandbox) {
    return null;
  }

  newTrans.date = getDate(transactionDate);
  newTrans.payeeName = getPayeeName(trans);
  newTrans.notes = trans.descriptionRaw || trans.description;

  if (accountType === 'CREDIT') {
    if (trans.amountInAccountCurrency) {
      trans.amountInAccountCurrency *= -1;
    }

    trans.amount *= -1;
  }

  let amountInCurrency = trans.amountInAccountCurrency ?? trans.amount;
  amountInCurrency = Math.round(amountInCurrency * 100) / 100;

  newTrans.transactionAmount = {
    amount: amountInCurrency,
    currency: trans.currencyCode,
  };

  newTrans.transactionId = trans.id;
  newTrans.sortOrder = transactionDate.getTime();
  newTrans.originalDate = getDate(transactionDate);

  delete trans.amount;

  return { ...flattenObject(trans), ...newTrans };
}
