import ApiUsage from "../models/ApiUsage.js";
import { logger } from "../utils/logger.js";

/**
 * Universal API rotator.
 * Bir nechta provayderni qabul qiladi, har birini prioritet bo'yicha tartiblaydi,
 * kvota yetarli bo'lsa ishga tushiradi, xato bo'lsa keyingisiga o'tadi.
 *
 * Provayder shartlari:
 *   {
 *     name: 'serper',
 *     priority: 10,            // kichikroq son — birinchi navbatda
 *     monthlyLimit: 2500,
 *     capabilities: ['searchHotels', 'getHotelPrices', 'getReviews'],
 *     execute: async (capability, args) => { ... }
 *   }
 */
class ApiRotator {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    if (!provider?.name || typeof provider.execute !== "function") {
      throw new Error("apiRotator.register: name + execute talab qilinadi");
    }
    this.providers.set(provider.name, {
      priority: 50,
      monthlyLimit: 1000,
      capabilities: [],
      ...provider,
    });
    logger.debug(`apiRotator: ${provider.name} ro'yxatga olindi`);
  }

  unregister(name) {
    this.providers.delete(name);
  }

  list() {
    return [...this.providers.values()];
  }

  yearMonth(d = new Date()) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  async getUsage(providerName) {
    const ym = this.yearMonth();
    let doc = await ApiUsage.findOne({ provider: providerName, yearMonth: ym });
    if (!doc) {
      doc = await ApiUsage.create({ provider: providerName, yearMonth: ym });
    }
    return doc;
  }

  async hasQuota(provider) {
    const usage = await this.getUsage(provider.name);
    if (usage.disabled) {
      if (usage.disabledUntil && usage.disabledUntil < new Date()) {
        usage.disabled = false;
        usage.disabledUntil = null;
        await usage.save();
      } else {
        return false;
      }
    }
    return usage.requestCount < provider.monthlyLimit;
  }

  async recordSuccess(name) {
    const ym = this.yearMonth();
    await ApiUsage.findOneAndUpdate(
      { provider: name, yearMonth: ym },
      {
        $inc: { requestCount: 1, successCount: 1 },
        $set: { lastSuccessAt: new Date() },
      },
      { upsert: true },
    );
  }

  async recordFailure(name, error) {
    const ym = this.yearMonth();
    const doc = await ApiUsage.findOneAndUpdate(
      { provider: name, yearMonth: ym },
      {
        $inc: { requestCount: 1, failureCount: 1 },
        $set: {
          lastFailureAt: new Date(),
          lastError: String(error?.message || error).slice(0, 500),
        },
      },
      { upsert: true, new: true },
    );

    // 10 ta ketma-ket xato → 1 soatga o'chir
    if (doc.failureCount >= 10 && doc.successCount === 0) {
      doc.disabled = true;
      doc.disabledUntil = new Date(Date.now() + 60 * 60 * 1000);
      await doc.save();
      logger.warn(`apiRotator: ${name} 1 soatga vaqtincha o'chirildi`);
    }
  }

  /**
   * call(capability, args)
   * → birinchi mos provayderdan natija qaytaradi
   */
  async call(capability, args = {}) {
    const candidates = [...this.providers.values()]
      .filter((p) => p.capabilities.includes(capability))
      .sort((a, b) => a.priority - b.priority);

    if (candidates.length === 0) {
      throw new Error(`apiRotator: '${capability}' uchun provayder yo'q`);
    }

    const errors = [];
    for (const provider of candidates) {
      try {
        const ok = await this.hasQuota(provider);
        if (!ok) {
          logger.debug(
            `apiRotator: ${provider.name} — kvota tugagan, keyingisiga o'tilmoqda`,
          );
          continue;
        }

        logger.debug(`apiRotator: ${provider.name} → ${capability}`);
        const result = await provider.execute(capability, args);
        await this.recordSuccess(provider.name);
        return { provider: provider.name, data: result };
      } catch (err) {
        logger.warn(`apiRotator: ${provider.name} xato — ${err.message}`);
        await this.recordFailure(provider.name, err);
        errors.push({ provider: provider.name, error: err.message });
        continue;
      }
    }

    const detail = errors.map((e) => `${e.provider}: ${e.error}`).join("; ");
    throw new Error(
      `apiRotator: barcha provayderlar muvaffaqiyatsiz [${detail}]`,
    );
  }

  async status() {
    const ym = this.yearMonth();
    const out = [];
    for (const p of this.providers.values()) {
      const usage = await ApiUsage.findOne({ provider: p.name, yearMonth: ym });
      out.push({
        name: p.name,
        priority: p.priority,
        monthlyLimit: p.monthlyLimit,
        capabilities: p.capabilities,
        used: usage?.requestCount ?? 0,
        success: usage?.successCount ?? 0,
        failed: usage?.failureCount ?? 0,
        remaining: p.monthlyLimit - (usage?.requestCount ?? 0),
        disabled: usage?.disabled ?? false,
        lastError: usage?.lastError ?? "",
        lastSuccessAt: usage?.lastSuccessAt ?? null,
      });
    }
    return out.sort((a, b) => a.priority - b.priority);
  }
}

export const apiRotator = new ApiRotator();
export default apiRotator;
