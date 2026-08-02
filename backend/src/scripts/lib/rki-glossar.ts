/**
 * Glossar der in den RKI-Protokollen verwendeten Kürzel.
 *
 * WARUM MIT HERKUNFTSFELD:
 * Ein erster Versuch ließ das LLM die Kürzel auflösen. Ergebnis waren
 * autoritativ klingende Falschangaben ("IBBS: Institut für Biologische
 * Sicherheit des RKI"). Bei einem Bestand über ein politisch strittiges Thema
 * ist das der schädlichste Fehler überhaupt: er ist nicht als Vermutung
 * erkennbar und entwertet rückwirkend alles andere.
 *
 * Deshalb trägt jeder Eintrag seine Herkunft:
 *   "korpus"      – die Auflösung steht wörtlich in den Protokollen (stärkster Beleg)
 *   "organigramm" – RKI-Organigramm, abgerufen 2026-07-29 (Stand siehe ORGANIGRAMM_STAND).
 *                   ACHTUNG: gilt für heute. Wo sich eine Einheit seit 2020-2023
 *                   verändert hat, ist das im `hinweis` festgehalten.
 *   "oeffentlich" – anderweitig dokumentierte Bezeichnung (Institutionen, Normen)
 *   "offen"       – ungeklärt oder für den Protokollzeitraum nicht belastbar.
 *                   `expansion` bleibt leer; im Artikel erscheint nur das Kürzel.
 *
 * NUR Einträge mit einer nicht-leeren `expansion` werden in den Artikeln
 * aufgelöst (siehe glossarForPrompt()). "offen" wirkt also wie "nicht vorhanden"
 * – ohne dass die Wissenslücke aus dem Code verschwindet.
 *
 * GEGENPROBE ÜBER DIE TEILNEHMERLISTEN:
 * Aus 378 Protokollen ist bekannt, wer eine Einheit wie oft vertreten hat. Wo
 * das Organigramm und die Personen nicht zusammenpassen, gilt der Eintrag als
 * "offen" – genau so wurden P1, P4, FG21 und FG38 als Fallen erkannt.
 */

/** Abrufdatum des Organigramms, das die "organigramm"-Einträge belegt. */
export const ORGANIGRAMM_STAND = "2026-07-29";
export const ORGANIGRAMM_QUELLE =
  "https://www.rki.de/DE/Institut/Organisation/Organigramm/Organigramm_PDF.pdf";

export type GlossarQuelle = "korpus" | "organigramm" | "oeffentlich" | "offen";

export interface GlossarEintrag {
  /** Ausgeschriebene Bezeichnung. Leer = ungeklärt, wird nicht aufgelöst. */
  expansion: string;
  quelle: GlossarQuelle;
  /** Beleg, Einschränkung oder offene Frage. */
  hinweis?: string;
  /** Schreibvarianten, die auf denselben Eintrag zeigen. */
  aliase?: string[];
}

export const RKI_GLOSSAR: Record<string, GlossarEintrag> = {
  // =========================================================================
  // Im Bestand selbst belegt – stärkster Beleg
  // =========================================================================
  AGI: {
    expansion: "Arbeitsgemeinschaft Influenza",
    quelle: "korpus",
    hinweis: 'Steht wörtlich in den Protokollen: "Arbeitsgemeinschaft Influenza (AGI)".',
    aliase: ["AGI-TK"],
  },
  KL: {
    expansion: "Konsiliarlabor",
    quelle: "korpus",
    hinweis:
      'Steht wörtlich in den Protokollen: "Konsiliarlabor (KL)". NICHT "Klinische Leitung" – der Kontext ("Diagnostik soll am KL stattfinden", "Absprache zwischen Herrn Wolff und Herrn Drosten") belegt das Labor.',
  },

  // =========================================================================
  // Institutionen und Verfahren
  // =========================================================================
  RKI: { expansion: "Robert Koch-Institut", quelle: "oeffentlich" },
  BMG: { expansion: "Bundesministerium für Gesundheit", quelle: "oeffentlich" },
  BMI: { expansion: "Bundesministerium des Innern", quelle: "oeffentlich" },
  BMVI: {
    expansion: "Bundesministerium für Verkehr und digitale Infrastruktur",
    quelle: "oeffentlich",
  },
  AA: { expansion: "Auswärtiges Amt", quelle: "oeffentlich" },
  BZgA: {
    expansion: "Bundeszentrale für gesundheitliche Aufklärung",
    quelle: "oeffentlich",
    aliase: ["BZGA"],
  },
  WHO: { expansion: "Weltgesundheitsorganisation", quelle: "oeffentlich" },
  ECDC: {
    expansion: "European Centre for Disease Prevention and Control",
    quelle: "oeffentlich",
  },
  EWRS: {
    expansion: "Early Warning and Response System (EU)",
    quelle: "oeffentlich",
  },
  GOARN: {
    expansion: "Global Outbreak Alert and Response Network (WHO)",
    quelle: "oeffentlich",
  },
  GHSI: { expansion: "Global Health Security Initiative", quelle: "oeffentlich" },
  JEE: {
    expansion: "Joint External Evaluation (WHO)",
    quelle: "oeffentlich",
    hinweis: "Externe Bewertung der Pandemievorsorge nach den IGV.",
  },
  IGV: {
    expansion: "Internationale Gesundheitsvorschriften",
    quelle: "oeffentlich",
    hinweis: "Englisch: International Health Regulations (IHR).",
    aliase: ["IHR"],
  },
  PHEIC: {
    expansion: "Public Health Emergency of International Concern",
    quelle: "oeffentlich",
    hinweis: "Gesundheitliche Notlage von internationaler Tragweite.",
  },
  IfSG: { expansion: "Infektionsschutzgesetz", quelle: "oeffentlich" },
  "ÖGD": { expansion: "Öffentlicher Gesundheitsdienst", quelle: "oeffentlich" },
  EpiBull: {
    expansion: "Epidemiologisches Bulletin des RKI",
    quelle: "oeffentlich",
  },
  STAKOB: {
    expansion:
      "Ständiger Arbeitskreis der Kompetenz- und Behandlungszentren für Krankheiten durch hochpathogene Erreger",
    quelle: "oeffentlich",
  },
  STIKO: { expansion: "Ständige Impfkommission", quelle: "oeffentlich" },
  IPC: { expansion: "Infection Prevention and Control", quelle: "oeffentlich" },
  DIVI: {
    expansion:
      "Deutsche Interdisziplinäre Vereinigung für Intensiv- und Notfallmedizin",
    quelle: "oeffentlich",
    hinweis: "In den Protokollen meist als Quelle der Intensivbetten-Zahlen.",
  },
  PAE: {
    expansion: "Postgraduiertenausbildung für angewandte Epidemiologie",
    quelle: "organigramm",
  },
  nCoV: {
    expansion: "neuartiges Coronavirus",
    quelle: "oeffentlich",
    hinweis:
      "Bezeichnung vor der Benennung als SARS-CoV-2 (Februar 2020) – in den frühen Protokollen durchgängig verwendet.",
    aliase: ["2019-nCoV"],
  },

  // =========================================================================
  // RKI-Abteilungen und Zentren (Organigramm, Stand 2026-07-29)
  // =========================================================================
  "Abt. 1": {
    expansion: "Abteilung 1 – Infektionskrankheiten",
    quelle: "organigramm",
    aliase: ["Abt.1", "Abt 1", "Abteilung 1", "Abteilung 1-Leitung", "AL1"],
  },
  "Abt. 2": {
    expansion: "Abteilung 2 – Epidemiologie und Gesundheitsmonitoring",
    quelle: "organigramm",
    aliase: ["Abt.2", "Abt 2", "Abteilung 2", "Abteilung 2-Leitung"],
  },
  "Abt. 3": {
    expansion: "Abteilung 3 – Infektionsepidemiologie",
    quelle: "organigramm",
    aliase: ["Abt.3", "Abt 3", "Abteilung 3", "Abteilung 3-Leitung", "AL3"],
  },
  ZBS: {
    expansion: "Zentrum für Biologische Gefahren und Spezielle Pathogene",
    quelle: "organigramm",
  },
  ZIG: {
    expansion: "Zentrum für Internationalen Gesundheitsschutz",
    quelle: "organigramm",
    aliase: ["ZIG-L", "ZIGL", "ZIG-Leitung"],
  },
  ZV: { expansion: "Zentrale Verwaltung", quelle: "organigramm" },
  MFI: {
    expansion:
      "Methodenentwicklung, Forschungsinfrastruktur und Informationstechnologie",
    quelle: "organigramm",
  },

  // =========================================================================
  // Fachgebiete Abteilung 1 – Infektionskrankheiten
  // Über die Teilnehmerlisten gegengeprüft.
  // =========================================================================
  FG11: {
    expansion: "Fachgebiet 11 – Bakterielle darmpathogene Erreger und Legionellen",
    quelle: "organigramm",
    hinweis: "40 Sitzungen (2021-04 bis 2023-05).",
  },
  FG12: {
    expansion:
      "Fachgebiet 12 – Masern, Mumps, Röteln und Viren bei Abwehrschwäche",
    quelle: "organigramm",
    hinweis:
      "Vertreten durch Annette Mankertz und Sebastian Voigt (157 Sitzungen) – passt zum Organigramm.",
  },
  FG14: {
    expansion: "Fachgebiet 14 – Angewandte Infektions- und Krankenhaushygiene",
    quelle: "organigramm",
    hinweis:
      "Vertreten durch Mardjan Arvand und Marc Thanheiser (367 Sitzungen) – passt. NICHT internationale Gesundheit.",
  },
  FG17: {
    expansion:
      "Fachgebiet 17 – Influenzaviren und weitere Viren des Respirationstraktes",
    quelle: "organigramm",
    hinweis:
      "Vertreten durch Thorsten Wolff, Ralf Dürrwald, Djin-Ye Oh (363 Sitzungen) – passt.",
  },

  // =========================================================================
  // Fachgebiete Abteilung 2 – Epidemiologie und Gesundheitsmonitoring
  // =========================================================================
  FG24: {
    expansion: "Fachgebiet 24 – Gesundheitsberichterstattung",
    quelle: "organigramm",
    hinweis: "83 Sitzungen; vertreten u.a. durch Thomas Ziese.",
  },
  FG25: {
    expansion: "Fachgebiet 25 – Körperliche Gesundheit",
    quelle: "organigramm",
    hinweis: "58 Sitzungen (ab 2020-12).",
  },

  // =========================================================================
  // Fachgebiete Abteilung 3 – Infektionsepidemiologie
  // =========================================================================
  FG31: {
    expansion:
      "Fachgebiet 31 – ÖGD-Kontaktstelle, Krisenmanagement, Ausbruchsuntersuchungen und Trainingsprogramme",
    quelle: "organigramm",
    hinweis: "47 Sitzungen.",
  },
  FG33: {
    expansion: "Fachgebiet 33 – Impfprävention / STIKO",
    quelle: "organigramm",
    hinweis:
      "Vertreten durch Ole Wichmann und Thomas Harder (195 Sitzungen) – passt.",
  },
  FG34: {
    expansion:
      "Fachgebiet 34 – HIV/AIDS und andere sexuell oder durch Blut übertragbare Infektionen",
    quelle: "organigramm",
    hinweis: "Vertreten durch Viviane Bremer (250 Sitzungen) – passt.",
  },
  FG35: {
    expansion:
      "Fachgebiet 35 – Gastrointestinale Infektionen, Zoonosen und tropische Infektionen",
    quelle: "organigramm",
    hinweis: "49 Sitzungen.",
  },
  FG36: {
    expansion: "Fachgebiet 36 – Respiratorisch übertragbare Erkrankungen",
    quelle: "organigramm",
    hinweis:
      "Vertreten durch Walter Haas und Silke Buda (375 Sitzungen) – passt. Das für COVID-19 fachlich führende Fachgebiet.",
  },
  FG37: {
    expansion:
      "Fachgebiet 37 – Nosokomiale Infektionen, Surveillance von Antibiotikaresistenz und -verbrauch",
    quelle: "organigramm",
    hinweis:
      "Vertreten durch Tim Eckmanns, Muna Abu Sin, Sebastian Haller (348 Sitzungen) – passt.",
  },

  // =========================================================================
  // Zentren-Einheiten
  // =========================================================================
  ZBS1: {
    expansion: "ZBS 1 – Hochpathogene Viren",
    quelle: "organigramm",
    hinweis:
      "Vertreten durch Andreas Nitsche und Janine Michel (211 Sitzungen) – passt.",
    aliase: ["ZBS 1"],
  },
  ZBS7: {
    expansion: "ZBS 7 – Strategie und Einsatz",
    quelle: "organigramm",
    hinweis:
      "Hervorgegangen aus dem IBBS, umbenannt am 01.06.2021. Deckt sich mit dem Bestand: IBBS erscheint bis 2021-07, ZBS7 ab 2021-06 (111 Sitzungen), beide vertreten durch Christian Herzog.",
    aliase: ["ZBS 7"],
  },
  IBBS: {
    expansion:
      "Informationsstelle des Bundes für Biologische Gefahren und Spezielle Pathogene",
    quelle: "oeffentlich",
    hinweis:
      "Am 01.06.2021 umbenannt in ZBS 7 – Strategie und Einsatz. Im Bestand 243 Sitzungen von 2020-01 bis 2021-07.",
  },
  ZIG1: {
    expansion: "ZIG 1 – Informationsstelle für Internationalen Gesundheitsschutz (INIG)",
    quelle: "organigramm",
    hinweis:
      "INIG ist der Name dieser Einheit, kein eigenes Gremium. Erklärt die Bestandsvariante „ZIG1 / INIG“.",
    aliase: ["ZIG 1", "ZIG1/INIG", "ZIG1 / INIG"],
  },
  INIG: {
    expansion: "Informationsstelle für Internationalen Gesundheitsschutz (ZIG 1)",
    quelle: "organigramm",
    hinweis:
      "Identisch mit ZIG 1. Im Bestand 61 Sitzungen bis 2021-03, danach wird durchgängig ZIG1 geschrieben.",
  },
  ZIG2: {
    expansion: "ZIG 2 – Evidenzbasierte Public Health",
    quelle: "organigramm",
    hinweis: "22 Sitzungen.",
    aliase: ["ZIG 2"],
  },
  MF2: {
    expansion: "MF 2 – Fachdaten-Kompetenzzentrum",
    quelle: "organigramm",
    hinweis: "39 Sitzungen (ab 2021-11).",
    aliase: ["MF 2"],
  },
  MF3: {
    expansion: "MF 3 – Tierexperimentelle Forschung und 3R",
    quelle: "organigramm",
    hinweis: "33 Sitzungen.",
    aliase: ["MF 3"],
  },
  MF4: {
    expansion: "MF 4 – Fach- und Forschungsdatenmanagement",
    quelle: "organigramm",
    hinweis: "102 Sitzungen (ab 2020-11).",
    aliase: ["MF 4"],
  },

  // =========================================================================
  // OFFEN – für den Protokollzeitraum nicht belastbar
  //
  // Diese Kürzel stehen im heutigen Organigramm für etwas anderes als in den
  // Protokollen 2020-2023, oder gar nicht mehr. Eine Auflösung wäre hier
  // schlimmer als keine: sie wäre für den Bestand nachweislich falsch.
  // =========================================================================
  P1: {
    expansion: "",
    quelle: "offen",
    hinweis:
      "FALLE: Das Organigramm 2026 führt P1 als „Pathogenese und Übertragbarkeit von hochpathogenen Atemwegsviren“. Im Bestand wird P1 aber von Ines Lein, Christina Leuker und Mirjam Jenny vertreten (236 Sitzungen ab 2020-07) – Risikokommunikation/Verhaltensforschung. Das ist eine andere Projektgruppe; die damalige Bezeichnung ist ungeklärt.",
  },
  P4: {
    expansion: "",
    quelle: "offen",
    hinweis:
      "Im Organigramm 2026 nicht mehr vorhanden. Im Bestand 98 Sitzungen (2020-01 bis 2023-05), vertreten u.a. durch Dirk Brockmann – Umfeld Modellierung. Damalige Bezeichnung ungeklärt.",
  },
  FG38: {
    expansion: "",
    quelle: "offen",
    hinweis:
      "Im Organigramm 2026 nicht mehr vorhanden. Im Bestand 187 Sitzungen, nur von 2020-09 bis 2022-04 – offenbar eine für die Pandemie geschaffene Einheit. Bezeichnung ungeklärt.",
  },
  FG21: {
    expansion: "",
    quelle: "offen",
    hinweis:
      "Mehrfach umbenannt: Organigramm 2026 „Zentrum für Studienmanagement“, die RKI-Fachgebietsseite nennt „Epidemiologisches Daten- und Befragungszentrum“. Im Bestand vertreten durch Wolfgang Scheida und Patrick Schmich (197 Sitzungen). Für 2020-2023 nicht belastbar.",
  },
  FG32: {
    expansion: "",
    quelle: "offen",
    hinweis:
      "Heute „Surveillance und elektronisches Melde- und Informationssystem (DEMIS) | ÖGD-Kontaktstelle“. DEMIS kam erst später hinzu; im Protokollzeitraum ist die geführte Bezeichnung ungeklärt. Vertreten durch Michaela Diercke, Ute Rexroth, Maria an der Heiden (365 Sitzungen), Umfeld Surveillance/Meldewesen.",
  },
  WBK: {
    expansion: "",
    quelle: "offen",
    hinweis:
      'Erscheint nur als "WBK-Meldung über SurvNet", also als Kategorie im Meldewesen – nicht als Gremium. Bezeichnung ungeklärt.',
  },
  EpiLag: {
    expansion: "",
    quelle: "offen",
    hinweis:
      "Regelmäßige Lagebesprechung mit den Landesgesundheitsbehörden. Ob „Epidemiologische Lage“ oder „Epidemiologische Lagekonferenz“ die geführte Bezeichnung ist, ist ungeklärt.",
  },
  KS: {
    expansion: "",
    quelle: "offen",
    hinweis: "Vermutlich Koordinierungsstelle – im Bestand nicht ausgeschrieben.",
  },
  SurvNet: {
    expansion: "",
    quelle: "offen",
    hinweis:
      "Meldesoftware des RKI nach IfSG (SurvNet@RKI). Geführte Langform ungeklärt.",
  },
  Presse: {
    expansion: "Pressestelle des RKI",
    quelle: "oeffentlich",
    hinweis:
      "375 Sitzungen – die am häufigsten vertretene Einheit überhaupt. Vertreten durch Susanne Glasmacher, Ronja Wenchel, Marieke Degen.",
    aliase: ["Pressestelle"],
  },
  Institutsleitung: {
    expansion: "Institutsleitung des RKI",
    quelle: "oeffentlich",
    hinweis:
      "343 Sitzungen; vertreten durch Lothar H. Wieler (Präsident bis 2023) und Lars Schaade (Vizepräsident, ab 2023 Präsident).",
    aliase: ["IL", "VPräs", "Präs"],
  },
};

/**
 * Nur die geklärten Einträge, als Zeilen für den Artikel-Prompt.
 * Ungeklärte Kürzel erscheinen bewusst nicht – das Modell soll sie unverändert
 * stehen lassen, statt eine Auflösung zu erfinden.
 */
export function glossarForPrompt(): string {
  const lines: string[] = [];
  for (const [kuerzel, e] of Object.entries(RKI_GLOSSAR)) {
    if (!e.expansion) continue;
    lines.push(`- ${kuerzel} = ${e.expansion}`);
  }
  return lines.join("\n");
}

/** Alle Kürzel, die NICHT aufgelöst werden dürfen. */
export function glossarOffeneKuerzel(): string[] {
  return Object.entries(RKI_GLOSSAR)
    .filter(([, e]) => !e.expansion)
    .map(([k]) => k);
}

/** Kanonischer Glossar-Schlüssel für eine Schreibvariante, sonst null. */
export function glossarLookup(kuerzel: string): string | null {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const target = norm(kuerzel);
  for (const [k, e] of Object.entries(RKI_GLOSSAR)) {
    if (norm(k) === target) return k;
    if ((e.aliase ?? []).some((a) => norm(a) === target)) return k;
  }
  return null;
}
