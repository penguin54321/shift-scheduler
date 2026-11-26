<script setup lang="ts">
import { isEmulator } from "../firebase";
import { login, logout, session } from "../session";
</script>

<template>
  <main class="login-page">
    <section class="panel">
      <img src="/favicon.svg" alt="" width="56" height="56" />
      <h1>排班系統</h1>
      <p class="muted">登入後即可排下個月的班表</p>

      <template v-if="session.user && session.ctx?.role === 'none'">
        <div class="banner banner-warning">
          <div>
            <strong>{{ session.user.email }}</strong> 不在員工名單中。<br />
            請聯絡老闆將您的 Google 帳號加入名單後再登入。
          </div>
        </div>
        <button class="btn" @click="logout">改用其他帳號</button>
      </template>

      <template v-else>
        <button class="btn google" @click="login">
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/>
          </svg>
          使用 Google 帳號登入
        </button>
        <p v-if="isEmulator" class="small muted">本機模擬器模式：登入視窗可直接新增測試帳號</p>
      </template>

      <p v-if="session.error" class="error small">{{ session.error }}</p>

      <ul class="rules">
        <li><strong>只能排下個月</strong>，以「日」為單位</li>
        <li>週末、國定假日、特殊休假日<strong>自動不開放</strong></li>
        <li>每天最多 <strong>3</strong> 人；每人每月 <strong>10～20</strong> 天</li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
  background: radial-gradient(circle at 20% 10%, #e3f0ef 0, transparent 45%),
    radial-gradient(circle at 85% 90%, #fdf1e5 0, transparent 40%), var(--bg);
}
.panel {
  width: min(420px, 100%); background: var(--surface); border: 1px solid var(--border);
  border-radius: 20px; box-shadow: var(--shadow-lg); padding: 36px 32px; text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 14px;
}
h1 { font-size: 26px; }
.panel > p { margin: 0 0 8px; }
.google { height: 46px; width: 100%; font-size: 15px; gap: 10px; }
.banner { text-align: left; width: 100%; margin: 0; }
.error { color: var(--holiday); white-space: pre-line; margin: 0; }
.rules {
  list-style: none; margin: 12px 0 0; padding: 16px 0 0; border-top: 1px solid var(--border);
  width: 100%; text-align: left; font-size: 13px; color: var(--text-2); display: grid; gap: 6px;
}
.rules li::before { content: "•"; color: var(--primary); margin-right: 8px; font-weight: 700; }
</style>
