import { defineStore } from "pinia";
import { ref, computed } from "vue";
import axios from "axios";

export const useAuthStore = defineStore("auth", () => {
  const token = ref<string | null>(localStorage.getItem("token"));
  const user = ref<any | null>(
    localStorage.getItem("user")
      ? JSON.parse(localStorage.getItem("user")!)
      : null,
  );

  const isAuthenticated = computed(() => !!token.value);
  const isAdmin = computed(() => user.value?.role === "admin");
  const userName = computed(() => user.value?.name || "");

  async function login(email: string, password: string) {
    const res = await axios.post("/api/v1/auth/login", { email, password });
    token.value = res.data.token;
    user.value = res.data.user;
    localStorage.setItem("token", res.data.token);
    localStorage.setItem("user", JSON.stringify(res.data.user));
    axios.defaults.headers.common["Authorization"] = `Bearer ${res.data.token}`;
    return res.data;
  }

  async function register(email: string, password: string, name: string) {
    const res = await axios.post("/api/v1/auth/register", {
      email,
      password,
      name,
    });
    token.value = res.data.token;
    user.value = res.data.user;
    localStorage.setItem("token", res.data.token);
    localStorage.setItem("user", JSON.stringify(res.data.user));
    axios.defaults.headers.common["Authorization"] = `Bearer ${res.data.token}`;
    return res.data;
  }

  /**
   * Holt den aktuellen User vom Server. Nötig, weil die Rolle im localStorage
   * vom Login stammt – ändert ein Admin sie, sähe das Frontend das sonst erst
   * nach erneutem Anmelden.
   */
  async function fetchMe() {
    if (!token.value) return null;
    try {
      const res = await axios.get("/api/v1/auth/me");
      user.value = res.data.user;
      localStorage.setItem("user", JSON.stringify(res.data.user));
      return res.data.user;
    } catch (e: any) {
      // Token ungültig oder User gelöscht → sauber abmelden.
      if (e?.response?.status === 401) logout();
      return null;
    }
  }

  function logout() {
    token.value = null;
    user.value = null;
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    delete axios.defaults.headers.common["Authorization"];
  }

  // Setze Header falls Token existiert
  if (token.value) {
    axios.defaults.headers.common["Authorization"] = `Bearer ${token.value}`;
  }

  return {
    token,
    user,
    isAuthenticated,
    isAdmin,
    userName,
    login,
    register,
    logout,
    fetchMe,
  };
});
