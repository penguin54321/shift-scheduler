import { reactive } from "vue";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { auth, googleProvider } from "./firebase";
import { api, errorMessages, type AppContext } from "./api";

interface SessionState {
  ready: boolean;
  user: User | null;
  ctx: AppContext | null;
  error: string | null;
}

export const session = reactive<SessionState>({ ready: false, user: null, ctx: null, error: null });

let resolveReady: () => void;
export const sessionReady = new Promise<void>((r) => (resolveReady = r));

onAuthStateChanged(auth, async (user) => {
  session.user = user;
  session.ctx = null;
  session.error = null;
  if (user) {
    try {
      // 強制刷新 token，才能拿到老闆剛設定的 custom claims
      await user.getIdToken(true);
      session.ctx = await api.getAppContext();
    } catch (err) {
      session.error = errorMessages(err).join("\n");
    }
  }
  session.ready = true;
  resolveReady();
});

export async function refreshContext() {
  session.ctx = await api.getAppContext();
}

export async function login() {
  session.error = null;
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") {
      session.error = errorMessages(err).join("\n");
    }
  }
}

export async function logout() {
  await signOut(auth);
}

export function homeFor(ctx: AppContext | null): string {
  if (ctx?.role === "boss") return "/boss";
  if (ctx?.role === "employee") return "/employee";
  return "/login";
}
