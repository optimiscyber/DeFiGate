// routes/admin.js
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import * as admin from '../controllers/adminController.js';

const router = express.Router();

// All admin routes require authentication AND admin role
router.use(authenticate);
router.use(requireAdmin);

// Reconciliation
router.post('/reconcile', admin.reconcile);

// Deposit reprocessing
router.post('/deposits/reprocess', admin.reprocessDeposit);

// Audit logs
router.get('/audit-logs', admin.getAuditLogsEndpoint);

export default router;