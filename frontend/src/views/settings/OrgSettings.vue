<template>
  <main class="main-content">
    <div class="header">
      <h3>⚙️ Einstellungen<span v-if="auth.activeOrg"> · {{ auth.activeOrg.name }}</span></h3>
    </div>

    <!--
      knora hatte hier eine globale Admin-Seite mit einem Reiter "Benutzer", auf
      dem der Betreiber Konten anlegte und Rollen setzte. Beides gibt es hier
      bewusst nicht: Konten entstehen über die Registrierung, Mitgliedschaft
      über Einladungen (Stufe 3). Diese Seite zeigt daher, was heute wirklich
      pro Organisation verwaltbar ist.
    -->
    <!-- "Mein Konto" hängt bewusst NICHT an settings.manage: das eigene Passwort
         zu ändern muss jeder können, auch ein viewer. Nur die beiden
         Organisations-Reiter sind an die Capability gebunden. -->
    <div class="tabs">
      <template v-if="canManageOrg">
        <button
          :class="['tab', { active: tab === 'models' }]"
          @click="tab = 'models'"
        >
          🤖 Modelle
        </button>
        <button
          :class="['tab', { active: tab === 'members' }]"
          @click="tab = 'members'"
        >
          👥 Mitglieder
        </button>
      </template>

      <button
        :class="['tab', { active: tab === 'account' }]"
        @click="tab = 'account'"
      >
        🔑 Mein Konto
      </button>
    </div>

    <template v-if="canManageOrg">
      <!-- ------------------------------------------------------ Modelle -->
      <div v-if="tab === 'models'" class="content">
        <div class="section-head">
          <p class="hint">
            Chat- und Embedding-Anbieter dieser Organisation. Der Schlüssel wird
            nur maskiert angezeigt — gespeichert ist er verschlüsselt und wird
            nie zurückgegeben.
          </p>
          <button class="btn-primary" @click="openCreate">+ Anbieter</button>
        </div>

        <div v-if="loadingModels" class="loading">Lade Anbieter …</div>
        <div v-else-if="providers.length === 0" class="empty">
          <p>Noch kein Modell-Anbieter hinterlegt.</p>
        </div>

        <table v-else class="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Typ</th>
              <th>Modell</th>
              <th>Schlüssel</th>
              <th>Aktiv</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="p in providers" :key="p.id">
            <tr>
              <td>
                <strong>{{ p.name }}</strong>
                <div class="sub">{{ p.api_base_url }}</div>
              </td>
              <td>{{ TYPE_LABELS[p.provider_type] ?? p.provider_type }}</td>
              <td>{{ p.default_model }}</td>
              <td><code>{{ p.api_key_preview }}</code></td>
              <td>
                <button
                  class="pill"
                  :class="p.is_active ? 'on' : 'off'"
                  @click="toggleActive(p)"
                >
                  {{ p.is_active ? "aktiv" : "inaktiv" }}
                </button>
              </td>
              <td class="right">
                <button
                  class="btn-link"
                  :disabled="rowTestId === p.id"
                  @click="testRow(p)"
                >
                  {{ rowTestId === p.id ? "Teste …" : "Testen" }}
                </button>
                <button class="btn-link" @click="openEdit(p)">Bearbeiten</button>
                <button class="btn-link danger" @click="removeProvider(p)">
                  Löschen
                </button>
              </td>
            </tr>
            <!-- Ergebnis unter der geprüften Zeile statt in einer Sammelmeldung
                 am Seitenende: bei drei Anbietern ist sonst nicht erkennbar,
                 welcher gemeint war. -->
            <tr v-if="rowResults[p.id]" class="result-row">
              <td colspan="6">
                <span :class="rowResults[p.id].ok ? 'ok-text' : 'bad-text'">
                  {{
                    rowResults[p.id].ok
                      ? `✅ ${rowResults[p.id].modell} · ${rowResults[p.id].dauer_ms} ms · „${rowResults[p.id].antwort}"`
                      : `❌ ${rowResults[p.id].fehler}`
                  }}
                </span>
              </td>
            </tr>
            </template>
          </tbody>
        </table>
        <p v-if="modelError" class="error">{{ modelError }}</p>
      </div>

      <!-- --------------------------------------------------- Mitglieder -->
      <div v-if="tab === 'members'" class="content">
        <p class="hint">
          Mitglieder dieser Organisation. Die Rolle bestimmt, was jemand in
          allen Wikis darf; einzelne Wikis können sie überschreiben. Einladen
          und Rollen ändern kommt mit dem Mailversand.
        </p>
        <!-- Ohne diesen Satz liest sich die Tabelle falsch herum: "admin" klingt
             nach der stärkeren Rolle, ist aber die zweite. owner hat alles, was
             admin hat, plus Abrechnung und das Löschen der Organisation. -->
        <p class="hint">
          Rangfolge:
          <strong>owner</strong> → admin → editor → author → reviewer → viewer.
          <em>owner</em> ist die höchste Rolle — sie unterscheidet sich von
          <em>admin</em> nur durch <code>billing.manage</code> und das Recht, die
          Organisation zu löschen.
        </p>

        <div v-if="loadingMembers" class="loading">Lade Mitglieder …</div>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>E-Mail</th>
              <th>Rolle</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in sortedMembers" :key="m.id">
              <td>
                <strong>{{ m.name }}</strong>
                <span v-if="m.id === auth.user?.id" class="sub"> (du)</span>
              </td>
              <td>{{ m.email }}</td>
              <td>
                <span class="pill role" :class="{ top: m.role === 'owner' }">
                  {{ m.role }}
                </span>
                <span v-if="m.role === 'owner'" class="sub"> höchste Rolle</span>
              </td>
              <td class="right">
                <button
                  v-if="auth.can('member.delete') && m.id !== auth.user?.id"
                  class="btn-link danger"
                  @click="removeMember(m)"
                >
                  Entfernen
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="memberError" class="error">{{ memberError }}</p>
      </div>

    </template>

    <!-- ------------------------------------------------------- Mein Konto -->
    <div v-if="tab === 'account'" class="content">
      <p class="hint">
        Passwort ändern. Solange es keinen Mailversand gibt, ist das der
        bequeme Weg — „Passwort vergessen" schickt den Link sonst nur ins
        Server-Log.
      </p>

      <form class="pw-form" @submit.prevent="askChangePassword">
        <!-- Auge je Feld, gleiches Muster wie auf der Login-Seite. Ein
             gemeinsamer Schalter wäre knapper, macht aber genau die Prüfung
             unmöglich, für die man ihn braucht: sehen, ob sich in *einem* der
             beiden neuen Felder ein Tippfehler versteckt. -->
        <div class="field">
          <label>Aktuelles Passwort</label>
          <div class="password-wrapper">
            <input
              v-model="pw.current"
              :type="shown.current ? 'text' : 'password'"
              autocomplete="current-password"
            />
            <button
              type="button"
              class="toggle-pw"
              @click="shown.current = !shown.current"
              :title="shown.current ? 'Verbergen' : 'Anzeigen'"
            >
              <i :class="shown.current ? 'pi pi-eye-slash' : 'pi pi-eye'"></i>
            </button>
          </div>
        </div>
        <div class="field">
          <label>Neues Passwort</label>
          <div class="password-wrapper">
            <input
              v-model="pw.next"
              :type="shown.next ? 'text' : 'password'"
              autocomplete="new-password"
            />
            <button
              type="button"
              class="toggle-pw"
              @click="shown.next = !shown.next"
              :title="shown.next ? 'Verbergen' : 'Anzeigen'"
            >
              <i :class="shown.next ? 'pi pi-eye-slash' : 'pi pi-eye'"></i>
            </button>
          </div>
          <!-- Dieselbe Untergrenze wie im Backend (minPasswordLength: 12).
               Steht sie nur dort, sieht der Nutzer erst nach dem Absenden,
               dass sein Passwort zu kurz war. -->
          <p class="field-hint">Mindestens 12 Zeichen.</p>
        </div>
        <div class="field">
          <label>Neues Passwort wiederholen</label>
          <div class="password-wrapper">
            <input
              v-model="pw.repeat"
              :type="shown.repeat ? 'text' : 'password'"
              autocomplete="new-password"
            />
            <button
              type="button"
              class="toggle-pw"
              @click="shown.repeat = !shown.repeat"
              :title="shown.repeat ? 'Verbergen' : 'Anzeigen'"
            >
              <i :class="shown.repeat ? 'pi pi-eye-slash' : 'pi pi-eye'"></i>
            </button>
          </div>
        </div>

        <p v-if="pwError" class="error">{{ pwError }}</p>
        <p v-if="pwDone" class="success">
          Passwort geändert. Andere Sitzungen wurden beendet.
        </p>

        <button class="btn-primary" type="submit" :disabled="!pwValid || pwBusy">
          {{ pwBusy ? "Wird geändert …" : "Passwort ändern" }}
        </button>
      </form>
    </div>

    <!-- ------------------------------------------------ Anbieter-Dialog -->
    <div v-if="showForm" class="dialog-overlay" @click.self="showForm = false">
      <div class="dialog">
        <h3>{{ editId ? "Anbieter bearbeiten" : "Neuer Anbieter" }}</h3>
        <div class="field">
          <label>Name *</label>
          <input v-model="form.name" placeholder="z.B. deepseek-chat" />
        </div>
        <div class="field">
          <label>Typ *</label>
          <select v-model="form.provider_type">
            <option value="chat">Chat</option>
            <option value="embedding">Embedding</option>
            <option value="both">Beides</option>
          </select>
        </div>
        <div class="field">
          <label>API-Basis-URL *</label>
          <input v-model="form.api_base_url" placeholder="https://api.deepseek.com/v1" />
          <!-- Der häufigste Konfigurationsfehler, und einer, der erst Stunden
               später als „Import ohne Wiki-Artikel" auffällt: an diese URL wird
               unverändert /chat/completions bzw. /embeddings angehängt. Wer nur
               die Domain einträgt, bekommt vom Anbieter einen 404. -->
          <p class="field-hint">
            Ohne <code>/chat/completions</code> — das hängt prowiki an. Bei
            OpenRouter also <code>https://openrouter.ai/api/v1</code>.
          </p>
        </div>
        <div class="field">
          <label>Standardmodell *</label>
          <input v-model="form.default_model" placeholder="deepseek-chat" />
        </div>
        <div class="field">
          <label>
            API-Schlüssel {{ editId ? "" : "*" }}
          </label>
          <input
            v-model="form.api_key"
            type="password"
            :placeholder="editId ? 'Leer lassen, um ihn nicht zu ändern' : 'sk-…'"
          />
        </div>
        <!-- Ergebnis des Verbindungstests. Steht über den Knöpfen, damit es
             nicht unter dem Dialogrand verschwindet. -->
        <div
          v-if="testResult"
          class="test-result"
          :class="testResult.ok ? 'ok' : 'bad'"
        >
          <strong>{{
            testResult.ok ? "✅ Verbindung steht" : "❌ Test fehlgeschlagen"
          }}</strong>
          <div v-if="testResult.ok" class="sub">
            {{ testResult.modell }} · {{ testResult.dauer_ms }} ms · Antwort:
            „{{ testResult.antwort }}"
          </div>
          <div v-else class="sub">{{ testResult.fehler }}</div>
        </div>

        <div class="dialog-actions">
          <button class="btn-secondary" @click="showForm = false">
            Abbrechen
          </button>
          <!-- Testen, ohne zu speichern: sonst müsste man eine kaputte Zeile
               erst anlegen, um zu merken, dass sie kaputt ist. -->
          <button
            class="btn-secondary"
            :disabled="!testValid || testing"
            @click="testProvider"
          >
            {{ testing ? "Teste …" : "Testen" }}
          </button>
          <button class="btn-primary" :disabled="!formValid" @click="saveProvider">
            Speichern
          </button>
        </div>
        <p v-if="formError" class="error">{{ formError }}</p>
      </div>
    </div>

    <ConfirmModal
      :show="showConfirm"
      :options="confirmOptions"
      :on-confirm="onConfirm"
      :on-cancel="onCancel"
    />
  </main>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import axios from "axios";
import { useAuthStore } from "../../stores/auth";
import { useConfirm } from "../../composables/useConfirm";
import { authClient } from "../../lib/auth-client";
import ConfirmModal from "../../components/ConfirmModal.vue";

const auth = useAuthStore();
const {
  show: showConfirm,
  options: confirmOptions,
  ask: askConfirm,
  onConfirm,
  onCancel,
} = useConfirm();

const TYPE_LABELS: Record<string, string> = {
  chat: "Chat",
  embedding: "Embedding",
  both: "Beides",
};

const canManageOrg = computed(() => auth.can("settings.manage"));

// Wer die Organisation nicht verwalten darf, sieht nur "Mein Konto" — dann ist
// das auch der Startreiter, sonst zeigte die Seite eine leere Fläche.
const tab = ref<"models" | "members" | "account">(
  auth.can("settings.manage") ? "models" : "account",
);

/** Höchste Rolle zuerst — die Tabelle soll die Rangfolge abbilden, nicht den Namen. */
const ROLE_ORDER = ["owner", "admin", "editor", "author", "reviewer", "viewer"];
const sortedMembers = computed(() =>
  [...members.value].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  ),
);

const pw = ref({ current: "", next: "", repeat: "" });
const shown = ref({ current: false, next: false, repeat: false });
const pwError = ref("");
const pwDone = ref(false);
const pwBusy = ref(false);

const pwValid = computed(
  () =>
    pw.value.current.length > 0 &&
    pw.value.next.length >= 12 &&
    pw.value.next === pw.value.repeat,
);

/**
 * Bewusst mit Rückfrage: die Änderung beendet alle anderen Sitzungen. Wer sie
 * versehentlich auslöst, fliegt auf seinen übrigen Geräten raus.
 */
async function askChangePassword() {
  pwError.value = "";
  pwDone.value = false;

  if (pw.value.next !== pw.value.repeat) {
    pwError.value = "Die beiden neuen Passwörter stimmen nicht überein.";
    return;
  }
  if (pw.value.next.length < 12) {
    pwError.value = "Das neue Passwort muss mindestens 12 Zeichen haben.";
    return;
  }

  const ok = await askConfirm({
    title: "Passwort ändern",
    message:
      "Das Passwort wird sofort ersetzt und alle anderen Sitzungen werden beendet. " +
      "Auf anderen Geräten musst du dich danach neu anmelden.",
    confirmText: "Ändern",
    danger: false,
  });
  if (!ok) return;

  pwBusy.value = true;
  const { error } = await authClient.changePassword({
    currentPassword: pw.value.current,
    newPassword: pw.value.next,
    revokeOtherSessions: true,
  });
  pwBusy.value = false;

  if (error) {
    // Häufigster Fall: das aktuelle Passwort stimmt nicht. Better Auth antwortet
    // darauf mit 401 und einer englischen Meldung — nachgemessen, nicht geraten:
    // 400 wäre die naheliegende Annahme gewesen und ist falsch.
    pwError.value =
      error.status === 401 || error.status === 400
        ? "Das aktuelle Passwort ist nicht korrekt."
        : (error.message ?? "Ändern fehlgeschlagen");
    return;
  }

  pw.value = { current: "", next: "", repeat: "" };
  // Sichtbarkeit mit zurücksetzen: ein aufgedecktes Feld bliebe sonst offen
  // stehen und das nächste eingetippte Passwort wäre von Anfang an lesbar.
  shown.value = { current: false, next: false, repeat: false };
  pwDone.value = true;
}

const providers = ref<any[]>([]);
const members = ref<any[]>([]);
const loadingModels = ref(true);
const loadingMembers = ref(true);
const modelError = ref("");
const memberError = ref("");

const orgId = computed(() => auth.activeOrgId);

const showForm = ref(false);
const editId = ref<string | null>(null);
const formError = ref("");
const form = ref({
  name: "",
  provider_type: "chat",
  api_base_url: "",
  default_model: "",
  api_key: "",
});

/**
 * Ergebnis des Verbindungstests — einmal für den Dialog, einmal je Tabellenzeile.
 *
 * Getrennt gehalten, weil beide gleichzeitig sichtbar sein können und ein
 * gemeinsamer Speicher das Ergebnis der einen Stelle an der anderen anzeigen
 * würde.
 */
type TestErgebnis = {
  ok: boolean;
  status?: number;
  dauer_ms: number;
  modell?: string | null;
  antwort?: string | null;
  fehler?: string;
};

const testing = ref(false);
const testResult = ref<TestErgebnis | null>(null);
const rowTestId = ref<string | null>(null);
const rowResults = ref<Record<string, TestErgebnis>>({});

// Beim Bearbeiten darf der Schlüssel leer bleiben — dann wird er nicht ersetzt.
const formValid = computed(
  () =>
    form.value.name.trim() &&
    form.value.api_base_url.trim() &&
    form.value.default_model.trim() &&
    (editId.value || form.value.api_key.trim()),
);

/**
 * Zum Testen reicht weniger als zum Speichern: der Name ist dem Anbieter egal.
 * Ein Schlüssel muss da sein — entweder frisch eingetippt oder gespeichert
 * (dann trägt `editId` ihn nach).
 */
const testValid = computed(
  () =>
    form.value.api_base_url.trim() &&
    form.value.default_model.trim() &&
    (editId.value || form.value.api_key.trim()),
);

/**
 * Anbieter aus dem Dialog anrufen, ohne ihn zu speichern.
 *
 * `provider_type: "both"` wird als Chat getestet — für einen echten
 * Doppeltest müsste man zwei Aufrufe machen und zwei Ergebnisse anzeigen, und
 * die Fehlerquelle ist in beiden Fällen dieselbe Basis-URL.
 */
async function testProvider() {
  testing.value = true;
  testResult.value = null;
  try {
    const res = await axios.post(`/api/v1/orgs/${orgId.value}/models/test`, {
      id: editId.value || undefined,
      provider_type: form.value.provider_type,
      api_base_url: form.value.api_base_url.trim(),
      default_model: form.value.default_model.trim(),
      api_key: form.value.api_key.trim() || undefined,
    });
    testResult.value = res.data;
  } catch (e: any) {
    testResult.value = {
      ok: false,
      dauer_ms: 0,
      fehler: e.response?.data?.error || e.message,
    };
  } finally {
    testing.value = false;
  }
}

/** Dasselbe für eine gespeicherte Zeile — mit dem gespeicherten Schlüssel. */
async function testRow(p: any) {
  rowTestId.value = p.id;
  try {
    const res = await axios.post(`/api/v1/orgs/${orgId.value}/models/test`, {
      id: p.id,
      provider_type: p.provider_type,
      api_base_url: p.api_base_url,
      default_model: p.default_model,
    });
    rowResults.value = { ...rowResults.value, [p.id]: res.data };
  } catch (e: any) {
    rowResults.value = {
      ...rowResults.value,
      [p.id]: {
        ok: false,
        dauer_ms: 0,
        fehler: e.response?.data?.error || e.message,
      },
    };
  } finally {
    rowTestId.value = null;
  }
}

onMounted(load);
// Beim Wechsel der aktiven Organisation neu laden — sonst zeigt die Seite
// weiter die Anbieter der vorherigen.
watch(orgId, load);

async function load() {
  if (!orgId.value || !canManageOrg.value) {
    loadingModels.value = false;
    loadingMembers.value = false;
    return;
  }
  await Promise.all([loadProviders(), loadMembers()]);
}

async function loadProviders() {
  loadingModels.value = true;
  modelError.value = "";
  try {
    const res = await axios.get(`/api/v1/orgs/${orgId.value}/models`);
    providers.value = res.data.providers || [];
    // Alte Testergebnisse verwerfen: nach einer Änderung sagen sie nichts mehr
    // über den Zustand aus, den sie zu zeigen scheinen.
    rowResults.value = {};
  } catch (e: any) {
    modelError.value = e.response?.data?.error || "Anbieter nicht ladbar";
  } finally {
    loadingModels.value = false;
  }
}

async function loadMembers() {
  loadingMembers.value = true;
  memberError.value = "";
  try {
    const res = await axios.get(`/api/v1/orgs/${orgId.value}/users`);
    members.value = res.data.users || [];
  } catch (e: any) {
    memberError.value = e.response?.data?.error || "Mitglieder nicht ladbar";
  } finally {
    loadingMembers.value = false;
  }
}

function openCreate() {
  editId.value = null;
  formError.value = "";
  testResult.value = null;
  form.value = {
    name: "",
    provider_type: "chat",
    api_base_url: "",
    default_model: "",
    api_key: "",
  };
  showForm.value = true;
}

function openEdit(p: any) {
  editId.value = p.id;
  formError.value = "";
  testResult.value = null;
  form.value = {
    name: p.name,
    provider_type: p.provider_type,
    api_base_url: p.api_base_url,
    default_model: p.default_model,
    api_key: "",
  };
  showForm.value = true;
}

async function saveProvider() {
  formError.value = "";
  const payload: Record<string, unknown> = {
    name: form.value.name.trim(),
    provider_type: form.value.provider_type,
    api_base_url: form.value.api_base_url.trim(),
    default_model: form.value.default_model.trim(),
  };
  if (form.value.api_key.trim()) payload.api_key = form.value.api_key.trim();

  try {
    if (editId.value) {
      await axios.put(`/api/v1/orgs/${orgId.value}/models/${editId.value}`, payload);
    } else {
      await axios.post(`/api/v1/orgs/${orgId.value}/models`, payload);
    }
    showForm.value = false;
    await loadProviders();
  } catch (e: any) {
    formError.value = e.response?.data?.error || "Speichern fehlgeschlagen";
  }
}

async function toggleActive(p: any) {
  try {
    await axios.put(`/api/v1/orgs/${orgId.value}/models/${p.id}`, {
      is_active: !p.is_active,
    });
    await loadProviders();
  } catch (e: any) {
    modelError.value = e.response?.data?.error || "Umschalten fehlgeschlagen";
  }
}

async function removeProvider(p: any) {
  const ok = await askConfirm({
    title: "Anbieter löschen",
    message: `"${p.name}" wirklich löschen? Wikis, die dieses Modell nutzen, verlieren ihre Zuordnung.`,
    confirmText: "Löschen",
  });
  if (!ok) return;
  try {
    await axios.delete(`/api/v1/orgs/${orgId.value}/models/${p.id}`);
    await loadProviders();
  } catch (e: any) {
    modelError.value = e.response?.data?.error || "Löschen fehlgeschlagen";
  }
}

/**
 * Mitglied entfernen läuft über Better Auth, nicht über einen eigenen
 * Endpunkt: das organization-Plugin verwaltet `member` und prüft dabei
 * dieselbe Access-Control-Definition wie das Backend.
 */
async function removeMember(m: any) {
  const ok = await askConfirm({
    title: "Mitglied entfernen",
    message: `${m.name} (${m.email}) aus der Organisation entfernen? Zugriff auf alle Wikis dieser Organisation endet sofort.`,
    confirmText: "Entfernen",
  });
  if (!ok) return;
  memberError.value = "";
  const { error } = await authClient.organization.removeMember({
    memberIdOrEmail: m.email,
    organizationId: orgId.value!,
  });
  if (error) {
    memberError.value = error.message ?? "Entfernen fehlgeschlagen";
    return;
  }
  await loadMembers();
}
</script>

<style scoped>
.main-content {
  flex: 1;
  overflow-y: auto;
}
.header {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0 1.5rem;
  border-bottom: 1px solid var(--color-border);
}
.tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0.75rem 1rem;
  cursor: pointer;
  color: var(--color-text-secondary);
  font-size: 0.95rem;
}
.tab.active {
  color: var(--color-text);
  border-bottom-color: var(--color-primary);
  font-weight: 600;
}
.content {
  padding: 1.5rem;
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1rem;
}
.hint {
  color: var(--color-text-secondary);
  font-size: 0.875rem;
  max-width: 60ch;
  margin-bottom: 1rem;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}
.tbl th {
  text-align: left;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
  padding: 0.65rem 0.9rem;
  border-bottom: 1px solid var(--color-border);
}
.tbl td {
  padding: 0.75rem 0.9rem;
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}
.tbl tr:last-child td {
  border-bottom: none;
}
.tbl td.right {
  text-align: right;
  white-space: nowrap;
}
.sub {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}
.pill {
  font-size: 0.75rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  cursor: pointer;
}
.pill.on {
  border-color: #16a34a;
  color: #16a34a;
}
.pill.off {
  color: var(--color-text-secondary);
}
.pill.role {
  cursor: default;
}
.pill.role.top {
  border-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 600;
}

.pw-form {
  max-width: 24rem;
}
.password-wrapper {
  position: relative;
}
.password-wrapper input {
  padding-right: 2.5rem;
}
.toggle-pw {
  position: absolute;
  right: 0.4rem;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  padding: 0.25rem;
  display: flex;
  align-items: center;
}
.toggle-pw:hover {
  color: var(--color-text);
}
.field-hint {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-top: 0.25rem;
}
.success {
  color: #16a34a;
  margin: 0.75rem 0;
  font-size: 0.875rem;
}
.btn-link {
  background: none;
  border: none;
  color: var(--color-primary);
  cursor: pointer;
  padding: 0 0.35rem;
  font-size: 0.875rem;
}
.btn-link.danger {
  color: #dc2626;
}
.empty,
.loading {
  text-align: center;
  padding: 3rem 2rem;
  color: var(--color-text-secondary);
}
.error {
  color: #dc2626;
  margin-top: 0.75rem;
  font-size: 0.875rem;
}

/* Dialog — gleiche Form wie in WikiList.vue */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.dialog {
  background: var(--color-bg);
  border-radius: 10px;
  padding: 1.5rem;
  width: min(460px, 92vw);
}
.dialog h3 {
  margin-bottom: 1rem;
}
.field {
  margin-bottom: 0.9rem;
}
.field label {
  display: block;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  margin-bottom: 0.25rem;
}
.field input,
.field select {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
}
.test-result {
  margin-top: 1rem;
  padding: 0.65rem 0.8rem;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  font-size: 0.875rem;
}
.test-result.ok {
  border-color: #16a34a;
}
.test-result.bad {
  border-color: #dc2626;
}
.test-result .sub {
  margin-top: 0.25rem;
  word-break: break-word;
}
.result-row td {
  padding-top: 0;
  font-size: 0.8rem;
}
.ok-text {
  color: #16a34a;
}
.bad-text {
  color: #dc2626;
}
.btn-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1.25rem;
}
.btn-primary {
  background: var(--color-primary);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-secondary {
  background: var(--color-bg-secondary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
}
</style>
