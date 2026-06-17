import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { env } from '../config/env.js';
import User from '../models/User.js';

async function seed() {
  await connectDB();
  const exists = await User.findOne({ email: env.ADMIN_EMAIL });
  if (exists) {
    console.log(`✓ Admin allaqachon mavjud: ${env.ADMIN_EMAIL}`);
    if (exists.role !== 'admin') {
      exists.role = 'admin';
      await exists.save();
      console.log('✓ Role admin ga o\x27zgartirildi');
    }
  } else {
    await User.create({
      email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD,
      name: 'RateRadar Admin', role: 'admin', lang: 'uz',
      onboardingCompleted: true,
    });
    console.log(`✓ Admin yaratildi: ${env.ADMIN_EMAIL}`);
    console.log(`  Parol: ${env.ADMIN_PASSWORD} (TEZDA O'ZGARTIRING)`);
  }
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => { console.error('Seed xato:', err); process.exit(1); });
