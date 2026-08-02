// Vorlesen über die Web Speech API des Browsers – kein Backend, keine Kosten.
// Die Sprechtext-Aufbereitung liegt in utils/speech-text.ts.
//
// Chunks werden einzeln gesprochen (onend → nächster Chunk), nicht als Queue an
// speechSynthesis übergeben: nur so bleiben Pause, Stop und Fortschritt über
// alle Browser hinweg zuverlässig.
import { computed, onUnmounted, ref } from "vue";

const RATE_KEY = "knora.speech.rate";
const VOICE_KEY = "knora.speech.voice";
const MAX_CONSECUTIVE_ERRORS = 3;
// Chrome ignoriert ein speak() direkt nach cancel() – minimal verzögert starten.
const RESTART_DELAY_MS = 60;

export type SpeechState = "idle" | "playing" | "paused";

export function useSpeech(langPrefix = "de") {
  const supported =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window;

  const voices = ref<SpeechSynthesisVoice[]>([]);
  const voiceName = ref(readStored(VOICE_KEY) || "");
  const rate = ref(Number(readStored(RATE_KEY)) || 1);
  const state = ref<SpeechState>("idle");
  const chunks = ref<string[]>([]);
  const index = ref(0);

  // cancel() löst onend/onerror der laufenden Utterance aus. Über die runId
  // werden Callbacks abgebrochener Durchläufe ignoriert.
  let runId = 0;
  let errorCount = 0;
  let startTimer: number | undefined;

  const isActive = computed(() => state.value !== "idle");
  const progress = computed(() =>
    chunks.value.length ? index.value / chunks.value.length : 0,
  );
  const currentChunk = computed(() => chunks.value[index.value] ?? "");

  function loadVoices() {
    if (!supported) return;
    voices.value = window.speechSynthesis
      .getVoices()
      .filter((voice) => voice.lang.toLowerCase().startsWith(langPrefix))
      // Beste zuerst – das ist zugleich die Auto-Wahl (siehe activeVoice)
      .sort((a, b) => rankVoice(b) - rankVoice(a));
    // Gespeicherte Stimme ist auf diesem Gerät evtl. nicht vorhanden
    if (voiceName.value && !voices.value.some((v) => v.name === voiceName.value)) {
      voiceName.value = "";
    }
  }

  /** Leerer voiceName = "beste verfügbare Stimme" statt Browser-Default. */
  const activeVoice = computed<SpeechSynthesisVoice | null>(() => {
    if (voiceName.value) {
      return voices.value.find((v) => v.name === voiceName.value) ?? null;
    }
    return voices.value[0] ?? null;
  });

  if (supported) {
    loadVoices();
    // Chrome liefert die Stimmen asynchron nach
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
  }

  function speakFrom(myRun: number) {
    if (myRun !== runId || !supported) return;

    const text = chunks.value[index.value];
    if (text === undefined) {
      state.value = "idle";
      index.value = 0;
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate.value;
    const voice = activeVoice.value;
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || (langPrefix === "de" ? "de-DE" : langPrefix);

    utterance.onend = () => {
      if (myRun !== runId) return;
      errorCount = 0;
      index.value += 1;
      speakFrom(myRun);
    };

    utterance.onerror = (event) => {
      if (myRun !== runId) return;
      // Entstehen beim Stoppen/Überspringen – kein echter Fehler
      if (event.error === "interrupted" || event.error === "canceled") return;
      console.warn(`[speech] ${event.error}`);
      errorCount += 1;
      if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
        stop();
        return;
      }
      index.value += 1;
      speakFrom(myRun);
    };

    window.speechSynthesis.speak(utterance);
  }

  /** Laufende Ausgabe abbrechen, ohne den Zustand zurückzusetzen. */
  function silence() {
    if (!supported) return;
    runId += 1; // laufende Callbacks entwerten
    if (startTimer !== undefined) {
      window.clearTimeout(startTimer);
      startTimer = undefined;
    }
    // Chrome kann bei cancel() im Pause-Zustand hängen bleiben
    if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    window.speechSynthesis.cancel();
  }

  /** Ab dem aktuellen Chunk (neu) sprechen – z. B. nach Tempo-/Stimmwechsel. */
  function playFromCurrent() {
    silence();
    errorCount = 0;
    const myRun = ++runId;
    state.value = "playing";
    startTimer = window.setTimeout(() => speakFrom(myRun), RESTART_DELAY_MS);
  }

  function start(textChunks: string[]) {
    if (!supported || !textChunks.length) return;
    chunks.value = textChunks;
    index.value = 0;
    playFromCurrent();
  }

  function pause() {
    if (!supported || state.value !== "playing") return;
    window.speechSynthesis.pause();
    state.value = "paused";
  }

  function resume() {
    if (!supported || state.value !== "paused") return;
    window.speechSynthesis.resume();
    state.value = "playing";
  }

  function stop() {
    silence();
    state.value = "idle";
    index.value = 0;
    chunks.value = [];
  }

  /** Play/Pause/Fortsetzen an einem Button. */
  function toggle(getChunks: () => string[]) {
    if (state.value === "playing") {
      pause();
    } else if (state.value === "paused") {
      resume();
    } else {
      start(getChunks());
    }
  }

  function seek(offset: number) {
    if (!isActive.value || !chunks.value.length) return;
    const next = index.value + offset;
    if (next < 0 || next >= chunks.value.length) return;
    index.value = next;
    playFromCurrent();
  }

  function setRate(value: number) {
    rate.value = value;
    writeStored(RATE_KEY, String(value));
    // rate greift nur bei neuen Utterances → ab aktuellem Chunk neu starten
    if (isActive.value) playFromCurrent();
  }

  function setVoice(name: string) {
    voiceName.value = name;
    writeStored(VOICE_KEY, name);
    if (isActive.value) playFromCurrent();
  }

  onUnmounted(() => {
    silence();
    state.value = "idle";
    if (supported) {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
    }
  });

  return {
    supported,
    voices,
    voiceName,
    activeVoice,
    rate,
    state,
    chunks,
    index,
    isActive,
    progress,
    currentChunk,
    start,
    pause,
    resume,
    stop,
    toggle,
    seek,
    setRate,
    setVoice,
  };
}

/**
 * Qualitäts-Heuristik für Stimmen. Der Browser-Default ist keine gute Wahl:
 * Chrome nimmt die erste passende Systemstimme (auf macOS meist eine alte
 * Kompakt-Stimme), obwohl die deutlich bessere Netzwerk-Stimme "Google Deutsch"
 * daneben liegt. Höherer Wert = besser.
 */
function rankVoice(voice: SpeechSynthesisVoice): number {
  const name = voice.name.toLowerCase();
  let score = 0;

  // Namensmerkmale der neueren, neuronalen Stimmen
  if (/siri|premium|enhanced|neural|natural/.test(name)) score += 40;
  if (name.includes("google")) score += 30;
  // Netzwerkstimmen sind in Chrome durchweg besser als die lokalen Altbestände
  if (!voice.localService) score += 20;
  // Explizit als "compact" markierte Stimmen klingen am schlechtesten
  if (name.includes("compact")) score -= 30;
  if (voice.default) score += 5;

  return score;
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private-Mode o. Ä. – Einstellung gilt dann nur für diese Sitzung
  }
}
