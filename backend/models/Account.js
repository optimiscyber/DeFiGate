import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";

const Account = sequelize.define(
  "Account",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    asset: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "USDC",
    },
    available_balance: {
      type: DataTypes.DECIMAL(20, 6),
      allowNull: false,
      defaultValue: 0,
    },
    pending_balance: {
      type: DataTypes.DECIMAL(20, 6),
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: "balances",
    timestamps: true,
    createdAt: false,
    updatedAt: "updated_at",
  }
);

export default Account;
