// Composable: Workspace-Auflösung (UUID + Slug)
// Ermöglicht Routen wie /documents/politik oder /documents/a9aa0313-...
import { ref } from "vue";
import axios from "axios";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function useWorkspace() {
  const resolving = ref(false);
  const resolveError = ref("");

  /** Prüft ob ein String eine UUID ist */
  function isUUID(val: string): boolean {
    return UUID_REGEX.test(val);
  }

  /** Löst einen Workspace-Bezeichner (UUID oder Slug) in ein Workspace-Objekt auf */
  async function resolveWorkspace(
    workspaceId: string,
  ): Promise<{ id: string; name: string; slug: string } | null> {
    if (isUUID(workspaceId)) {
      try {
        const res = await axios.get(`/api/v1/workspaces/${workspaceId}`);
        const ws = res.data.workspace;
        return ws ? { id: ws.id, name: ws.name, slug: ws.slug } : null;
      } catch {
        return null;
      }
    }

    // Slug auflösen
    resolving.value = true;
    resolveError.value = "";
    try {
      const res = await axios.get(`/api/v1/workspaces/by-slug/${workspaceId}`);
      const ws = res.data.workspace;
      return ws ? { id: ws.id, name: ws.name, slug: ws.slug } : null;
    } catch (e: any) {
      resolveError.value =
        e.response?.data?.error || `Workspace "${workspaceId}" nicht gefunden`;
      return null;
    } finally {
      resolving.value = false;
    }
  }

  return { resolveWorkspace, isUUID, resolving, resolveError };
}
