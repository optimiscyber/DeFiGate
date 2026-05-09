// routes/admin.js
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { requireSupport } from '../middleware/requireSupport.js';
import * as admin from '../controllers/adminController.js';

const router = express.Router();

router.use(authenticate);

// Admin-only routes
router.post('/reconcile', requireRole('admin'), admin.reconcile);
router.post('/deposits/reprocess', requireRole('admin'), admin.reprocessDeposit);
router.get('/audit-logs', requireRole('admin'), admin.getAuditLogsEndpoint);

// Support-safe operational controls
router.post('/users/:userId/freeze', requireSupport, admin.freezeUser);
router.post('/users/:userId/unfreeze', requireSupport, admin.unfreezeUser);
router.post('/withdrawals/:transactionId/approve', requireSupport, admin.approveWithdrawalEndpoint);
router.post('/withdrawals/:transactionId/reject', requireSupport, admin.rejectWithdrawalEndpoint);
router.get('/withdrawals/pending', requireSupport, admin.getPendingWithdrawalsEndpoint);

export default router;