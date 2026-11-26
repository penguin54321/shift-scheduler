#!/usr/bin/env node
/**
 * 設定 / 移除老闆角色（Firebase Auth Custom Claims）。
 *
 * 用法：
 *   本機模擬器： npm run set-role -- boss@gmail.com --emulator
 *   正式環境：   GOOGLE_APPLICATION_CREDENTIALS=scripts/keys/service-account.json \
 *                npm run set-role -- boss@gmail.com
 *   移除老闆：   npm run set-role -- boss@gmail.com --remove
 *
 * 注意：該帳號必須先用 Google 登入過一次（Auth 裡才有這個使用者）；
 * 設定後請登出再登入，新的角色才會生效。
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"));
const useEmulator = args.includes("--emulator");
const remove = args.includes("--remove");

if (!email) {
  console.error("請提供 email，例如：npm run set-role -- boss@gmail.com --emulator");
  process.exit(1);
}

const firebaserc = JSON.parse(readFileSync(new URL("../.firebaserc", import.meta.url), "utf8"));
let projectId = firebaserc.projects.default;

if (useEmulator) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
  projectId = "demo-shift-scheduler";
  initializeApp({ projectId });
} else {
  initializeApp({ credential: applicationDefault(), projectId });
}

const auth = getAuth();
try {
  const user = await auth.getUserByEmail(email);
  const claims = { ...(user.customClaims ?? {}) };
  if (remove) delete claims.role;
  else claims.role = "boss";
  await auth.setCustomUserClaims(user.uid, claims);
  console.log(`✅ ${email}（${projectId}）角色已${remove ? "移除" : "設為 boss"}。請該使用者登出後重新登入。`);
} catch (err) {
  if (err.code === "auth/user-not-found") {
    console.error(`❌ 找不到 ${email}，請先讓該帳號用 Google 登入系統一次。`);
  } else {
    console.error("❌", err.message);
  }
  process.exit(1);
}
