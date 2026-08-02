<template>
  <!-- Nur Layout anzeigen wenn eingeloggt -->
  <div class="app-layout" v-if="auth.isAuthenticated">
    <!-- Sidebar -->
    <aside class="app-sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <router-link to="/" class="sidebar-logo"
          >🧠 <span class="logo-text">Knora</span></router-link
        >
        <button
          class="sidebar-toggle"
          @click="sidebarCollapsed = !sidebarCollapsed"
          :title="sidebarCollapsed ? 'Menü einblenden' : 'Menü ausblenden'"
        >
          <i
            :class="sidebarCollapsed ? 'pi pi-angle-right' : 'pi pi-angle-left'"
          ></i>
        </button>
      </div>
      <nav class="sidebar-nav">
        <router-link to="/chat" class="nav-item">
          <i class="pi pi-comments"></i>
          <span>Chat</span>
        </router-link>
        <a href="/workspaces" class="nav-item" @click.prevent="openWorkspaces">
          <i class="pi pi-folder"></i>
          <span>Workspaces</span>
        </a>
        <router-link v-if="auth.isAdmin" to="/settings" class="nav-item">
          <i class="pi pi-cog"></i>
          <span>Einstellungen</span>
        </router-link>
      </nav>
      <div class="sidebar-footer">
        <button
          class="theme-toggle"
          @click="toggleTheme"
          :title="isDark ? 'Helles Design' : 'Dunkles Design'"
        >
          <i :class="isDark ? 'pi pi-sun' : 'pi pi-moon'"></i>
        </button>
        <span class="sidebar-user">{{ auth.userName }}</span>
        <button class="sidebar-logout" @click="logout">Abmelden</button>
      </div>
    </aside>

    <!-- Main Content -->
    <div class="app-main">
      <main class="app-content">
        <router-view />
      </main>
    </div>

    <!-- Globale Log-Leiste (dezent, unten, ein-/ausklappbar) -->
    <ActivityBar />

    <!-- Mobile Bottom-Nav (nur auf kleinen Screens sichtbar) -->
    <nav class="mobile-nav">
      <router-link to="/chat" class="mobile-nav-item">
        <i class="pi pi-comments"></i>
        <span>Chat</span>
      </router-link>
      <a
        href="/workspaces"
        class="mobile-nav-item"
        :class="{ 'router-link-active': isWorkspacesRoute }"
        @click.prevent="openWorkspaces"
      >
        <i class="pi pi-folder"></i>
        <span>Workspaces</span>
      </a>
      <router-link v-if="auth.isAdmin" to="/settings" class="mobile-nav-item">
        <i class="pi pi-cog"></i>
        <span>Einstellungen</span>
      </router-link>
      <button class="mobile-nav-item" @click="toggleTheme">
        <i :class="isDark ? 'pi pi-sun' : 'pi pi-moon'"></i>
        <span>{{ isDark ? "Hell" : "Dunkel" }}</span>
      </button>
    </nav>
  </div>

  <!-- Login-Seite ohne Layout -->
  <router-view v-else />
</template>

<script setup lang="ts">
import { ref, onMounted, watch, computed } from "vue";
import { useAuthStore } from "./stores/auth";
import { useRouter, useRoute } from "vue-router";
import ActivityBar from "./components/ActivityBar.vue";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const isDark = ref(localStorage.getItem("knora-theme") === "dark");
const sidebarCollapsed = ref(
  localStorage.getItem("knora-sidebar") === "collapsed",
);

const isWorkspacesRoute = computed(() =>
  route.path.startsWith("/workspaces"),
);

// Zuletzt aktiven Workspace für Direktsprung merken
const lastWorkspaceId = ref(localStorage.getItem("knora-last-workspace") || "");

watch(lastWorkspaceId, (v) => {
  if (v) localStorage.setItem("knora-last-workspace", v);
  else localStorage.removeItem("knora-last-workspace");
});

// Wenn wir in einem Workspace-Kontext sind, speichern wir die ID
watch(
  () => route.params.id as string,
  (id) => {
    if (id) lastWorkspaceId.value = id;
  },
);

watch(sidebarCollapsed, (v) => {
  localStorage.setItem("knora-sidebar", v ? "collapsed" : "expanded");
});

onMounted(() => {
  applyTheme();
  // Rolle serverseitig auffrischen – der localStorage-Stand stammt vom Login.
  auth.fetchMe();
});

watch(isDark, () => {
  applyTheme();
  localStorage.setItem("knora-theme", isDark.value ? "dark" : "light");
});

function applyTheme() {
  document.documentElement.setAttribute(
    "data-theme",
    isDark.value ? "dark" : "light",
  );
}

function toggleTheme() {
  isDark.value = !isDark.value;
}

function openWorkspaces() {
  const lastId = localStorage.getItem("knora-last-workspace");
  if (lastId) {
    router.push(`/workspaces/${lastId}/documents`);
  } else {
    router.push("/workspaces");
  }
}

function logout() {
  auth.logout();
  router.push("/login");
}
</script>

<style>
@import "primeicons/primeicons.css";

:root {
  --sidebar-width: 260px;
  --header-height: 56px;
}

/* Light Theme (default) */
:root,
[data-theme="light"] {
  --color-sidebar-bg: #1a1a2e;
  --color-sidebar-text: #e0e0e0;
  --color-sidebar-hover: #16213e;
  --color-sidebar-active: #0f3460;
  --color-header-bg: #ffffff;
  --color-content-bg: #f5f7fa;
  --color-text: #1a1a1a;
  --color-text-secondary: #6b7280;
  --color-border: #e5e7eb;
  --color-bg: #ffffff;
  --color-bg-secondary: #f3f4f6;
  --color-primary: #1a1a2e;
}

/* Dark Theme */
[data-theme="dark"] {
  --color-sidebar-bg: #0d0d1a;
  --color-sidebar-text: #c0c0c0;
  --color-sidebar-hover: #1a1a2e;
  --color-sidebar-active: #0f3460;
  --color-header-bg: #1a1a2e;
  --color-content-bg: #111118;
  --color-text: #e0e0e0;
  --color-text-secondary: #9ca3af;
  --color-border: #2d2d3a;
  --color-bg: #1a1a2e;
  --color-bg-secondary: #16162a;
  --color-primary: #4f8cff;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html,
body {
  height: 100%;
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--color-text);
  background: var(--color-content-bg);
  line-height: 1.6;
}

#app {
  height: 100%;
}

.app-layout {
  display: flex;
  height: 100vh;
  /* dvh: auf dem Handy die tatsächlich sichtbare Höhe (Adressleiste/Tastatur) */
  height: 100dvh;
}

/* Sidebar */
.app-sidebar {
  width: var(--sidebar-width);
  background: var(--color-sidebar-bg);
  color: var(--color-sidebar-text);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width 0.2s ease;
  overflow: hidden;
}
.app-sidebar.collapsed {
  width: 60px;
}

.sidebar-header {
  padding: 1.25rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.app-sidebar.collapsed .sidebar-header {
  justify-content: flex-start;
  padding: 1.25rem 0;
  gap: 0;
}

.sidebar-logo {
  font-size: 1.35rem;
  font-weight: 700;
  color: #fff;
  text-decoration: none;
  letter-spacing: -0.5px;
  white-space: nowrap;
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.app-sidebar.collapsed .sidebar-logo {
  font-size: 1.2rem;
  padding-left: 0.35rem;
}
.app-sidebar.collapsed .logo-text {
  display: none;
}

.sidebar-toggle {
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: var(--color-sidebar-text);
  font-size: 0.75rem;
  padding: 0.2rem 0.35rem;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}
.sidebar-toggle:hover {
  background: rgba(255, 255, 255, 0.1);
}
.app-sidebar.collapsed .sidebar-toggle {
  display: flex;
  margin-left: auto;
  font-size: 0.7rem;
  padding: 0.15rem 0.2rem;
  border: none;
}

.sidebar-nav {
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.app-sidebar.collapsed .sidebar-nav {
  padding: 0.75rem 0.5rem;
  align-items: center;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.85rem;
  border-radius: 8px;
  color: var(--color-sidebar-text);
  text-decoration: none;
  font-size: 0.925rem;
  transition:
    background 0.15s,
    color 0.15s;
  white-space: nowrap;
}
.app-sidebar.collapsed .nav-item {
  justify-content: center;
  padding: 0.7rem;
  width: 44px;
}

.nav-item:hover {
  background: var(--color-sidebar-hover);
  color: #fff;
}

.nav-item.router-link-active,
.nav-item.router-link-exact-active {
  background: var(--color-sidebar-active);
  color: #fff;
}

.nav-item i {
  font-size: 1.1rem;
  width: 1.25rem;
  text-align: center;
}
.app-sidebar.collapsed .nav-item i {
  width: auto;
  font-size: 1.2rem;
}

.app-sidebar.collapsed .nav-item span {
  display: none;
}

/* Sidebar Footer */
.sidebar-footer {
  padding: 0.75rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.app-sidebar.collapsed .sidebar-footer {
  flex-direction: column;
  padding: 0.5rem;
  gap: 0.4rem;
}

.sidebar-footer .sidebar-user {
  flex: 1;
}

.sidebar-user {
  font-size: 0.8rem;
  color: var(--color-sidebar-text);
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-sidebar.collapsed .sidebar-user {
  display: none;
}

.theme-toggle {
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: var(--color-sidebar-text);
  font-size: 0.85rem;
  padding: 0.3rem 0.5rem;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.app-sidebar.collapsed .theme-toggle {
  padding: 0.4rem;
  font-size: 1rem;
}

.theme-toggle:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.3);
}

.sidebar-logout {
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: var(--color-sidebar-text);
  font-size: 0.75rem;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.app-sidebar.collapsed .sidebar-logout {
  display: none;
}

.sidebar-logout:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.3);
}

/* Main Area */
.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.app-content {
  flex: 1;
  overflow-y: auto;
  /* Platz für die eingeklappte Log-Leiste am unteren Rand */
  padding-bottom: 2rem;
}

a {
  color: var(--color-sidebar-active);
  text-decoration: none;
}

button {
  cursor: pointer;
  font-family: inherit;
}

/* Mobile Bottom-Nav: standardmäßig versteckt (Desktop nutzt die Sidebar) */
.mobile-nav {
  display: none;
}

/* ---- Responsive: Handy / kleine Tablets ---- */
@media (max-width: 768px) {
  /* Seitliche Sidebar auf Mobil komplett ausblenden */
  .app-sidebar {
    display: none;
  }

  .app-content {
    /* Platz für die fixe Bottom-Nav (56px) + die eingeklappte Log-Leiste (2rem),
       damit unten angedockte Elemente (z.B. die Chat-Eingabe) frei bleiben */
    padding-bottom: calc(56px + 2rem + env(safe-area-inset-bottom, 0px));
  }

  .mobile-nav {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 50;
    height: calc(56px + env(safe-area-inset-bottom, 0px));
    padding-bottom: env(safe-area-inset-bottom, 0px);
    background: var(--color-sidebar-bg);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .mobile-nav-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.15rem;
    background: none;
    border: none;
    color: var(--color-sidebar-text);
    text-decoration: none;
    font-size: 0.65rem;
    padding: 0.35rem 0;
    transition: color 0.15s;
  }

  .mobile-nav-item i {
    font-size: 1.25rem;
  }

  .mobile-nav-item:hover {
    color: #fff;
  }

  .mobile-nav-item.router-link-active,
  .mobile-nav-item.router-link-exact-active {
    /* Feste Akzentfarbe: liest sich in beiden Themes auf dem dunklen Bar-Hintergrund */
    color: #4f8cff;
  }
}
</style>
