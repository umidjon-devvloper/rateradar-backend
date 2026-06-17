import mongoose from "mongoose";

const apiUsageSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, index: true },
    yearMonth: { type: String, required: true, index: true },
    engine: { type: String, default: "default" },
    requestCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    lastSuccessAt: { type: Date, default: null },
    lastFailureAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
    disabledUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

apiUsageSchema.index(
  { provider: 1, yearMonth: 1, engine: 1 },
  { unique: true },
);

export default mongoose.model("ApiUsage", apiUsageSchema);
