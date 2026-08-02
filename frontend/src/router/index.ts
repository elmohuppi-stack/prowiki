import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      redirect: "/chat",
    },
    {
      path: "/login",
      name: "Login",
      component: () => import("../views/auth/Login.vue"),
    },
    {
      path: "/chat",
      name: "Chat",
      component: () => import("../views/chat/ChatView.vue"),
      meta: { requiresAuth: true },
    },
    // --- Workspace Hub (Tabs: Documents, Wiki, Graph) ---
    {
      path: "/workspaces",
      name: "Workspaces",
      component: () => import("../views/workspace/WorkspaceList.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/workspaces/:id",
      component: () => import("../views/workspace/WorkspaceHub.vue"),
      meta: { requiresAuth: true },
      redirect: (to) => ({ path: `/workspaces/${to.params.id}/documents` }),
      children: [
        {
          path: "documents",
          name: "WorkspaceDocuments",
          component: () => import("../views/documents/DocumentList.vue"),
        },
        {
          path: "documents/:documentId",
          name: "WorkspaceDocumentDetail",
          component: () => import("../views/documents/DocumentDetail.vue"),
        },
        {
          path: "wiki",
          name: "WorkspaceWiki",
          component: () => import("../views/wiki/WikiBrowser.vue"),
        },
        {
          // Review eines aus dem Chat erzeugten Artikel-Verbunds (Entwürfe).
          path: "wiki-review/:clusterId",
          name: "WorkspaceWikiReview",
          component: () => import("../views/wiki/WikiClusterReview.vue"),
        },
        {
          path: "wiki/:slug(.*)",
          name: "WorkspaceWikiPage",
          component: () => import("../views/wiki/WikiBrowser.vue"),
        },
        {
          path: "graph",
          name: "WorkspaceGraph",
          component: () => import("../views/wiki/GraphView.vue"),
        },
      ],
    },
    // --- Alte Pfade (Redirects) ---
    {
      path: "/wiki/:workspaceId?",
      redirect: (to) => {
        if (to.params.workspaceId) {
          return `/workspaces/${to.params.workspaceId}/wiki`;
        }
        return "/workspaces";
      },
    },
    {
      path: "/wiki/:workspaceId/:slug",
      redirect: (to) =>
        `/workspaces/${to.params.workspaceId}/wiki/${to.params.slug}`,
    },
    {
      path: "/documents/:workspaceId",
      redirect: (to) => `/workspaces/${to.params.workspaceId}/documents`,
    },
    {
      path: "/documents/:workspaceId/:documentId",
      redirect: (to) =>
        `/workspaces/${to.params.workspaceId}/documents/${to.params.documentId}`,
    },
    // --- Einstellungen ---
    {
      path: "/admin",
      redirect: "/settings",
    },
    {
      path: "/settings",
      name: "Settings",
      component: () => import("../views/admin/AdminPanel.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
  ],
});

// Nach einem Deploy ändern sich die gehashten Chunk-Dateinamen. Ein offenes
// Tab hält aber noch das alte Haupt-Bundle, das auf inzwischen gelöschte Chunks
// verweist – der Lazy-Import schlägt dann mit "Failed to fetch dynamically
// imported module" fehl. In dem Fall einmalig neu laden, um das aktuelle Bundle
// zu holen. sessionStorage-Flag verhindert eine Reload-Schleife bei echten Fehlern.
router.onError((error, to) => {
  const msg = String(error?.message || error);
  const isChunkError =
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
      msg,
    );
  if (isChunkError) {
    const reloadKey = "chunk-reload:" + to.fullPath;
    if (!sessionStorage.getItem(reloadKey)) {
      sessionStorage.setItem(reloadKey, "1");
      window.location.assign(to.fullPath);
    }
  }
});

// Erfolgreiche Navigation: Reload-Flag zurücksetzen, damit ein späterer echter
// Chunk-Fehler auf demselben Pfad wieder einen Reload auslösen darf.
router.afterEach((to) => {
  sessionStorage.removeItem("chunk-reload:" + to.fullPath);
});

// Navigation guard
router.beforeEach((to, from, next) => {
  const token = localStorage.getItem("token");
  if (to.meta.requiresAuth && !token) {
    next({ name: "Login" });
    return;
  }
  // Rollen-Check nur als UI-Führung – durchgesetzt wird er im Backend
  // (requireRole in admin/model-Router).
  if (to.meta.requiresAdmin) {
    const raw = localStorage.getItem("user");
    const role = raw ? JSON.parse(raw)?.role : null;
    if (role !== "admin") {
      next({ path: "/chat" });
      return;
    }
  }
  next();
});

export default router;
