<template>
  <!--
    Nur der App-eigene Teil. Der gemeinsame Teil — Server-Logs mit ihrer
    Aufbewahrungsfrist, Hosting, TLS, Betroffenenrechte, verantwortliche Stelle
    mit Anschrift — steht zentral unter elmarhepp.de/datenschutz und wird von
    dort übernommen, nicht hier wiederholt (platform/NEUE-APP.md 3.6).

    Deshalb steht in dieser Datei auch keine Anschrift. Nirgends im Repo steht
    eine: sobald eine App einen Platz dafür hat, wird er irgendwann gefüllt.
  -->
  <main class="legal">
    <article>
      <h1>Datenschutz bei prowiki</h1>

      <p class="lead">
        Diese Seite beschreibt, was <strong>prowiki</strong> selbst verarbeitet.
        Alles, was für alle Anwendungen unter <code>elmarhepp.de</code> gleich
        gilt — Server-Protokolle, Hosting, Verschlüsselung, deine Rechte als
        betroffene Person und die vollständigen Angaben zur verantwortlichen
        Stelle — steht in der
        <a href="https://elmarhepp.de/datenschutz">zentralen Datenschutzerklärung</a>.
      </p>

      <h2>Konten</h2>
      <p>
        Für die Anmeldung speichern wir Name, E-Mail-Adresse, einen
        Passwort-Hash und deine offenen Sitzungen. Ein Konto entsteht nur auf
        Einladung. Die Sitzung liegt in einem <code>httpOnly</code>-Cookie mit
        einer Laufzeit von 30 Tagen; es lässt sich mit „Abmelden" jederzeit
        beenden. Auf Wunsch löschen wir ein Konto vollständig — schreib uns
        dazu an die unten genannte Adresse.
      </p>

      <h2>Inhalte, die du hochlädst</h2>
      <p>
        Dokumente, Video-Transkripte und die daraus erzeugten Wiki-Artikel
        liegen in unserer Datenbank, ebenso deine Chatverläufe mit den zugehörigen
        Quellenangaben. Sie sind nur für Mitglieder deiner Organisation sichtbar,
        solange das jeweilige Wiki auf <em>privat</em> steht.
      </p>

      <h2>Sprachmodelle — der Anbieter ist deine Wahl</h2>
      <p>
        prowiki erzeugt Texte und durchsucht Inhalte mit Sprachmodellen. Diese
        Modelle betreiben wir nicht selbst: <strong>jede Organisation trägt ihren
        eigenen Anbieter samt eigenem Zugangsschlüssel ein</strong> (in den
        Einstellungen unter <em>Modelle</em>). Wohin deine Inhalte gehen,
        entscheidest damit du — nicht wir.
      </p>
      <p>
        Übertragen wird an den von dir eingetragenen Anbieter:
      </p>
      <ul>
        <li>
          <strong>Beim Chat</strong> deine Frage und die Textabschnitte, die die
          Suche dazu herangezogen hat.
        </li>
        <li>
          <strong>Beim Import</strong> der Inhalt des Dokuments — auch ohne dass
          du eine Frage stellst. Aus ihm werden die Wiki-Artikel erzeugt.
        </li>
        <li>
          <strong>Für die Suche</strong> Textabschnitte an den Anbieter, den du
          für Suchvektoren eingetragen hast.
        </li>
      </ul>
      <p>
        Ist für deine Organisation kein Anbieter eingetragen, findet keine
        Übermittlung statt — dann bleiben Chat und Artikel-Erzeugung ohne
        Ergebnis. Ein Ausweichen auf einen Anbieter, den du nicht gewählt hast,
        gibt es nicht.
      </p>
      <p>
        <strong>Wenn der von dir gewählte Anbieter außerhalb der EU sitzt</strong>,
        ist das eine Übermittlung in ein Drittland. Für manche Länder — etwa die
        USA — besteht ein Angemessenheitsbeschluss der Europäischen Kommission,
        für andere — etwa China — nicht. Welches Land es ist, ergibt sich aus dem
        Anbieter, den du hinterlegt hast; prüfe das, bevor du personenbezogene
        oder vertrauliche Inhalte einstellst. Die Verarbeitung durch das
        Sprachmodell ist der Zweck der Anwendung und lässt sich nicht einzeln
        abwählen — der Anbieter dagegen schon.
      </p>

      <h2>Weitere externe Dienste</h2>
      <table>
        <thead>
          <tr><th>Dienst</th><th>Was übertragen wird</th><th>Sitz</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Apify / Supadata</td>
            <td>Video-Adressen zum Abruf öffentlicher Transkripte — keine Nutzereingaben</td>
            <td>EU / USA</td>
          </tr>
        </tbody>
      </table>

      <h2>Speicher im Browser</h2>
      <p>
        Neben dem Sitzungs-Cookie legt prowiki einige Einstellungen lokal in
        deinem Browser ab. Sie sind für den Betrieb nötig und werden nicht
        ausgewertet:
      </p>
      <ul>
        <li><code>prowiki-theme</code> — helles oder dunkles Design</li>
        <li><code>prowiki-sidebar</code> — Seitenleiste ein- oder ausgeklappt</li>
        <li><code>prowiki-last-wiki</code> — zuletzt geöffnetes Wiki</li>
        <li><code>prowiki.speech.rate</code>, <code>prowiki.speech.voice</code> — Vorleseeinstellungen</li>
        <li><code>activeOrgId</code> — aktive Organisation</li>
      </ul>

      <h2>Reichweitenmessung</h2>
      <p>
        Findet nicht statt. prowiki bindet keine Analyse- oder Werbedienste ein
        und setzt keine Cookies zu diesem Zweck.
      </p>

      <h2>Verantwortlich</h2>
      <p>
        Elmar Hepp ·
        <a href="mailto:elmar.hepp@revenexx.com">elmar.hepp@revenexx.com</a><br />
        Vollständige Angaben im
        <a href="https://elmarhepp.de/impressum">Impressum</a>.
      </p>

      <p class="back"><router-link to="/">← zurück zur Anwendung</router-link></p>
    </article>
  </main>
</template>

<script setup lang="ts"></script>

<style scoped>
.legal {
  flex: 1;
  overflow-y: auto;
  padding: 2rem 1.5rem 4rem;
  background: var(--color-content-bg);
}
article {
  max-width: 68ch;
  margin: 0 auto;
  color: var(--color-text);
}
h1 {
  font-size: 1.6rem;
  margin-bottom: 1rem;
}
h2 {
  font-size: 1.05rem;
  margin: 2rem 0 0.5rem;
}
p,
ul {
  margin-bottom: 0.75rem;
}
.lead {
  color: var(--color-text-secondary);
}
ul {
  padding-left: 1.25rem;
}
li {
  margin-bottom: 0.2rem;
}
code {
  background: var(--color-bg-secondary);
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  font-size: 0.9em;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.5rem 0 1rem;
  font-size: 0.9rem;
}
th,
td {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}
th {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
}
a {
  color: var(--color-primary);
}
.back {
  margin-top: 2.5rem;
}
</style>
