import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth";

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
    // --- Wiki Hub (Tabs: Documents, Wiki, Graph) ---
    {
      path: "/wikis",
      name: "Wikis",
      component: () => import("../views/wiki-admin/WikiList.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/wikis/:id",
      component: () => import("../views/wiki-admin/WikiHub.vue"),
      meta: { requiresAuth: true },
      redirect: (to) => ({ path: `/wikis/${to.params.id}/documents` }),
      children: [
        {
          path: "documents",
          name: "WikiDocuments",
          component: () => import("../views/documents/DocumentList.vue"),
        },
        {
          path: "documents/:documentId",
          name: "WikiDocumentDetail",
          component: () => import("../views/documents/DocumentDetail.vue"),
        },
        {
          path: "wiki",
          name: "WikiWiki",
          component: () => import("../views/wiki/WikiBrowser.vue"),
        },
        {
          // Review eines aus dem Chat erzeugten Artikel-Verbunds (Entwürfe).
          path: "wiki-review/:clusterId",
          name: "WikiWikiReview",
          component: () => import("../views/wiki/WikiClusterReview.vue"),
        },
        {
          path: "wiki/:slug(.*)",
          name: "WikiWikiPage",
          component: () => import("../views/wiki/WikiBrowser.vue"),
        },
        {
          path: "graph",
          name: "WikiGraph",
          component: () => import("../views/wiki/GraphView.vue"),
        },
      ],
    },
    // --- Alte Pfade (Redirects) ---
    {
      path: "/wiki/:wikiId?",
      redirect: (to) => {
        if (to.params.wikiId) {
          return `/wikis/${to.params.wikiId}/wiki`;
        }
        return "/wikis";
      },
    },
    {
      path: "/wiki/:wikiId/:slug",
      redirect: (to) =>
        `/wikis/${to.params.wikiId}/wiki/${to.params.slug}`,
    },
    {
      path: "/documents/:wikiId",
      redirect: (to) => `/wikis/${to.params.wikiId}/documents`,
    },
    {
      path: "/documents/:wikiId/:documentId",
      redirect: (to) =>
        `/wikis/${to.params.wikiId}/documents/${to.params.documentId}`,
    },
    {
      // Einstellungen der *aktiven Organisation*. In knora lag hier
      // `/settings` als globale Admin-Seite hinter `requiresAdmin` — die
      // globale Rolle gibt es nicht mehr, geprüft wird `settings.manage`
      // in der Organisation (und im Backend erneut, siehe model.ts).
      path: "/settings",
      name: "Settings",
      component: () => import("../views/settings/OrgSettings.vue"),
      meta: { requiresAuth: true },
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

/**
 * Navigation guard.
 *
 * knora las hier `localStorage.getItem("token")` und eine Rolle aus dem
 * localStorage. Beides gibt es nicht mehr: die Sitzung steckt in einem
 * httpOnly-Cookie, das JavaScript nicht lesen kann. Gefragt wird deshalb der
 * Store, der die Sitzung einmalig beim Start vom Server holt.
 *
 * Der Guard ist reine Oberflächenführung. Durchgesetzt wird der Zugriff im
 * Backend über die Capability-Prüfung — ein Guard, den man im Browser
 * abschalten kann, ist keine Sicherung.
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (auth.loading) await auth.refresh();

  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    return { name: "Login", query: { redirect: to.fullPath } };
  }
  if (to.name === "Login" && auth.isAuthenticated) {
    return { path: "/chat" };
  }
  return true;
});

export default router;
