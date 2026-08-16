/**
 * Sitzungs- und Organisationszustand.
 *
 * Gegenüber knora fällt hier fast alles weg, was der Store vorher tat: Token
 * lesen, im localStorage ablegen, den Authorization-Header setzen, ihn beim
 * Logout wieder entfernen und beim Start rekonstruieren. Das übernimmt jetzt
 * der Browser mit einem httpOnly-Cookie.
 *
 * Was NICHT mehr existiert: `isAdmin`. Eine globale Admin-Rolle gibt es nicht
 * mehr — was jemand darf, hängt an der Organisation und am einzelnen Wiki
 * (siehe `capabilities`).
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import axios from "axios";
import { authClient } from "../lib/auth-client";
import { capabilitiesOf, isRoleName, type Capability } from "../lib/permissions";

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export const useAuthStore = defineStore("auth", () => {
  const user = ref<{ id: string; email: string; name: string } | null>(null);
  const organizations = ref<OrgSummary[]>([]);
  const activeOrgId = ref<string | null>(
    localStorage.getItem("activeOrgId"),
  );
  const loading = ref(true);

  const isAuthenticated = computed(() => !!user.value);
  const userName = computed(() => user.value?.name ?? "");

  const activeOrg = computed(
    () => organizations.value.find((o) => o.id === activeOrgId.value) ?? null,
  );

  /**
   * Capabilities in der aktiven Organisation. Nur für die Oberfläche gedacht —
   * ob etwas erlaubt ist, entscheidet immer das Backend. Ein Knopf, den man
   * ausblendet, ist keine Zugriffskontrolle.
   */
  const capabilities = computed<ReadonlySet<string>>(() => {
    const role = activeOrg.value?.role;
    if (!role || !isRoleName(role)) return new Set<string>();
    return capabilitiesOf(role);
  });

  function can(capability: Capability): boolean {
    return capabilities.value.has(capability);
  }

  /** Lädt Sitzung und Organisationen. Beim App-Start und nach jedem Wechsel. */
  async function refresh() {
    loading.value = true;
    try {
      const { data } = await authClient.getSession();
      user.value = data?.user
        ? { id: data.user.id, email: data.user.email, name: data.user.name }
        : null;

      if (!user.value) {
        organizations.value = [];
        return;
      }

      // Nicht `authClient.organization.list()`: dessen Antwort enthält die
      // Organisation ohne die Mitgliedsrolle. Ohne Rolle fiel der Store hier
      // stillschweigend auf `viewer` zurück — mit der Folge, dass selbst der
      // Inhaber keinen einzigen verwaltenden Knopf zu sehen bekam.
      const { data: orgData } = await axios.get("/api/v1/orgs");
      organizations.value = (orgData.organizations ?? []).map((o: any) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        role: o.role,
      }));

      // Gemerkte Organisation kann gelöscht worden oder die Mitgliedschaft
      // entzogen sein — dann auf die erste verfügbare zurückfallen.
      if (
        !activeOrgId.value ||
        !organizations.value.some((o) => o.id === activeOrgId.value)
      ) {
        setActiveOrg(organizations.value[0]?.id ?? null);
      }
    } finally {
      loading.value = false;
    }
  }

  function setActiveOrg(id: string | null) {
    activeOrgId.value = id;
    if (id) localStorage.setItem("activeOrgId", id);
    else localStorage.removeItem("activeOrgId");
  }

  async function login(email: string, password: string) {
    const { error } = await authClient.signIn.email({ email, password });
    if (error) throw new Error(error.message ?? "Anmeldung fehlgeschlagen");
    await refresh();
  }

  /**
   * Nach der Registrierung ist man NICHT angemeldet: die E-Mail muss erst
   * bestätigt werden. Der Aufrufer soll das anzeigen, statt einen Redirect zu
   * erwarten, der nicht kommt.
   */
  async function register(email: string, password: string, name: string) {
    const { error } = await authClient.signUp.email({ email, password, name });
    if (error) throw new Error(error.message ?? "Registrierung fehlgeschlagen");
    return { verificationRequired: true };
  }

  async function logout() {
    await authClient.signOut();
    user.value = null;
    organizations.value = [];
    setActiveOrg(null);
  }

  return {
    user,
    organizations,
    activeOrgId,
    activeOrg,
    loading,
    isAuthenticated,
    userName,
    capabilities,
    can,
    refresh,
    setActiveOrg,
    login,
    register,
    logout,
  };
});
