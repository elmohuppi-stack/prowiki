<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-logo">
        <div class="logo-icon">🧠</div>
        <h1>Knora</h1>
        <p class="subtitle">Deine persönliche Wissensdatenbank</p>
      </div>

      <form @submit.prevent="handleSubmit" class="login-form">
        <div class="field">
          <label for="email">E-Mail</label>
          <input
            id="email"
            v-model="email"
            type="email"
            placeholder="deine@email.de"
            required
            autofocus
          />
        </div>
        <div class="field">
          <label for="password">Passwort</label>
          <div class="password-wrapper">
            <input
              id="password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              placeholder="Passwort"
              required
            />
            <button
              type="button"
              class="toggle-pw"
              @click="showPassword = !showPassword"
              :title="showPassword ? 'Verbergen' : 'Anzeigen'"
            >
              <i :class="showPassword ? 'pi pi-eye-slash' : 'pi pi-eye'"></i>
            </button>
          </div>
        </div>

        <p v-if="error" class="error-msg">{{ error }}</p>

        <button type="submit" class="login-btn" :disabled="loading">
          {{ loading ? "Wird angemeldet..." : "Anmelden" }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "../../stores/auth";

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const email = ref("");
const password = ref("");
const showPassword = ref(false);
const error = ref("");
const loading = ref(false);

async function handleSubmit() {
  error.value = "";
  loading.value = true;
  try {
    await auth.login(email.value, password.value);
    const redirect = route.query.redirect;
    router.push(typeof redirect === "string" ? redirect : "/chat");
  } catch (e: any) {
    error.value =
      e.response?.data?.error || e.message || "Fehler bei der Anmeldung";
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #0f0c29 0%, #1a1a2e 50%, #16213e 100%);
}

.login-card {
  background: #ffffff;
  padding: 2.5rem;
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  width: 100%;
  max-width: 400px;
}

.login-logo {
  text-align: center;
  margin-bottom: 2rem;
}

.logo-icon {
  font-size: 3rem;
  margin-bottom: 0.5rem;
}

h1 {
  font-size: 1.75rem;
  font-weight: 700;
  color: #1a1a2e;
  margin-bottom: 0.25rem;
  letter-spacing: -0.5px;
}

.subtitle {
  color: #6b7280;
  font-size: 0.9rem;
}

.login-form {
  display: flex;
  flex-direction: column;
}

.field {
  margin-bottom: 1rem;
}

.field label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 0.35rem;
  color: #374151;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.field input {
  width: 100%;
  padding: 0.75rem 0.875rem;
  border: 1.5px solid #e5e7eb;
  border-radius: 8px;
  font-size: 0.95rem;
  font-family: inherit;
  /* Karte ist immer hell → Text explizit dunkel, unabhängig von App-/PrimeVue-Theme */
  color: #1a1a2e;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
  background: #f9fafb;
}

.field input:focus {
  outline: none;
  border-color: #1a1a2e;
  box-shadow: 0 0 0 3px rgba(26, 26, 46, 0.1);
  background: #fff;
}

.field input::placeholder {
  color: #9ca3af;
}

.password-wrapper {
  position: relative;
}

.password-wrapper input {
  padding-right: 2.75rem;
}

.toggle-pw {
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: #9ca3af;
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s;
}

.toggle-pw:hover {
  color: #1a1a2e;
}

.error-msg {
  color: #dc2626;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: #fef2f2;
  border-radius: 6px;
  border: 1px solid #fecaca;
}

.login-btn {
  width: 100%;
  padding: 0.75rem;
  background: #1a1a2e;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  margin-top: 0.5rem;
  transition: background 0.2s;
}

.login-btn:hover {
  background: #16213e;
}

.login-btn:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}
</style>
