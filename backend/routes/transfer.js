import express from "express";
import { authenticate } from "../middleware/auth.js";
import * as transfer from "../controllers/transferController.js";

const router = express.Router();

router.post("/", authenticate, transfer.transfer);
router.post("/send", authenticate, transfer.transfer);
router.post("/lookup", authenticate, transfer.lookupRecipient);
router.post("/initiate", authenticate, transfer.initiateTransfer);
router.post("/confirm", authenticate, transfer.confirmTransfer);
router.get("/history", authenticate, transfer.getTransferHistory);
router.post("/withdraw", authenticate, transfer.withdraw);
router.get("/withdraw/:transactionId", authenticate, transfer.getWithdrawalStatusController);

export default router;
