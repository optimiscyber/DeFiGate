import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";

const LedgerEntry = sequelize.define(
  "LedgerEntry",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    transaction_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    debit_account_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    credit_account_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(20, 6),
      allowNull: false,
    },
  },
  {
    tableName: "ledger_entries",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
  }
);

export default LedgerEntry;
