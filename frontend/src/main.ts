import { createApp } from "vue";
import { createPinia } from "pinia";
import axios from "axios";
import PrimeVue from "primevue/config";
import Aura from "@primevue/themes/aura";
import App from "./App.vue";
import router from "./router";
import { useAuthStore } from "./stores/auth";

const app = createApp(App);
app.use(createPinia());
app.use(router);

// Globaler 401-Handler: Ein abgelaufenes/ungültiges Token bleibt sonst im
// localStorage liegen. Der Router-Guard sieht es als "eingeloggt" und leitet
// NICHT zur Login-Seite; gleichzeitig scheitern alle API-Calls still mit 401
// und die Seite hängt im "Lädt…"-Zustand. Deshalb hier zentral: bei 401 die
// Session verwerfen und zur Login-Seite navigieren.
axios.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error?.response?.status === 401) {
      const auth = useAuthStore();
      // Nur reagieren, wenn wir (vermeintlich) eingeloggt waren – so löst der
      // 401 einer fehlgeschlagenen Login-Anfrage keinen Redirect-Loop aus.
      if (auth.isAuthenticated) {
        auth.logout();
        if (router.currentRoute.value.name !== "Login") {
          router.push({
            name: "Login",
            query: { redirect: router.currentRoute.value.fullPath },
          });
        }
      }
    }
    return Promise.reject(error);
  },
);
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      // Bewusst ein NIE aktiver Selektor: PrimeVue bleibt immer im Light-Theme.
      // Die App hat ein eigenes Dark-Mode-System (data-theme auf <html> +
      // --color-*-Variablen). Würde PrimeVue via [data-theme="dark"] mitdunkeln,
      // sickerte seine globale (helle) Textfarbe in hart-hell gestylte Bereiche
      // (z.B. die weiße Login-Karte) → unlesbar. PrimeVue-Komponenten werden
      // stattdessen bei Bedarf gezielt über :deep()/CSS-Variablen angepasst.
      darkModeSelector: ".pv-force-dark-never",
    },
  },
});
app.mount("#app");
