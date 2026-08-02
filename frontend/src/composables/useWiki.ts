// Composable: Wiki-Auflösung (UUID + Slug)
// Ermöglicht Routen wie /documents/politik oder /documents/a9aa0313-...
import { ref } from "vue";
import axios from "axios";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function useWiki() {
  const resolving = ref(false);
  const resolveError = ref("");

  /** Prüft ob ein String eine UUID ist */
  function isUUID(val: string): boolean {
    return UUID_REGEX.test(val);
  }

  /** Löst einen Wiki-Bezeichner (UUID oder Slug) in ein Wiki-Objekt auf */
  async function resolveWiki(
    wikiId: string,
  ): Promise<{ id: string; name: string; slug: string } | null> {
    if (isUUID(wikiId)) {
      try {
        const res = await axios.get(`/api/v1/wikis/${wikiId}`);
        const ws = res.data.wiki;
        return ws ? { id: ws.id, name: ws.name, slug: ws.slug } : null;
      } catch {
        return null;
      }
    }

    // Slug auflösen
    resolving.value = true;
    resolveError.value = "";
    try {
      const res = await axios.get(`/api/v1/wikis/by-slug/${wikiId}`);
      const ws = res.data.wiki;
      return ws ? { id: ws.id, name: ws.name, slug: ws.slug } : null;
    } catch (e: any) {
      resolveError.value =
        e.response?.data?.error || `Wiki "${wikiId}" nicht gefunden`;
      return null;
    } finally {
      resolving.value = false;
    }
  }

  return { resolveWiki, isUUID, resolving, resolveError };
}
