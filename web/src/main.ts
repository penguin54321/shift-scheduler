import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import { homeFor, session, sessionReady } from "./session";
import "./styles.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: () => homeFor(session.ctx) },
    { path: "/login", component: () => import("./views/LoginView.vue") },
    { path: "/employee", component: () => import("./views/EmployeeView.vue"), meta: { role: "employee" } },
    { path: "/boss", component: () => import("./views/BossView.vue"), meta: { role: "boss" } },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  await sessionReady;
  const required = to.meta.role as string | undefined;
  if (required && session.ctx?.role !== required) return homeFor(session.ctx);
  if (to.path === "/login" && session.ctx && session.ctx.role !== "none") return homeFor(session.ctx);
  return true;
});

export { router };
createApp(App).use(router).mount("#app");
