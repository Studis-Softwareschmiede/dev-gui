/**
 * TokenLimitWatcher — konto-weite Erkennung von Claudes Token-/Usage-Limit-
 * Meldung im PTY-Output + Reset-Zeitpunkt-Bestimmung + Warte-Primitive
 * (docs/specs/taktgeber-nachtwaechter.md AC13, AC14).
 *
 * Scope dieser Story (S-193, bewusst NICHT gebaut — siehe Spec "Nicht-Ziele"):
 *   - KEIN Nachtfenster-Scheduler (S-195 NightWatchScheduler) — dieser Watcher
 *     liefert nur den Reset-Zeitpunkt; der Vergleich gegen `window.end`
 *     ("liegt der Reset NACH dem Fensterende?") wird von `waitForReset()`
 *     bereits ausgewertet (AC14 verlangt genau diese Entscheidung), aber die
 *     Fenster-Berechnung selbst (TZ, über-Mitternacht, `windowEndMs`) bleibt
 *     Aufgabe des Schedulers — er reicht `windowEndMs` fertig berechnet rein.
 *   - KEIN Settings-Store/API (S-194), KEIN UI (S-197), KEIN Endpoint (S-196).
 *   - KEINE Verdrahtung in server.js/ProjectDrain — `attach()` ist die
 *     Schnittstelle, über die ein künftiger Scheduler den Watcher an
 *     beliebige PTY-Sessions (PtyManager-Instanzen, `PtySessionRegistry`)
 *     hängt; welche Sessions das sind, entscheidet der Scheduler (S-195).
 *
 * PTY-Output-Zugriff (Muster `CommandService#armIdleTimer` /
 * `PtyManager#onData`): jede PTY-Instanz emittiert `'output'` mit dem rohen
 * Output-Chunk (String, ANSI-Codes inklusive). `attach(ptyLike)` registriert
 * einen Listener nach demselben Muster wie `CommandService` und gibt eine
 * Detach-Funktion zurück.
 *
 * Meldungs-Erkennung (AC13):
 *   Claudes Limit-Meldung ist nicht in einer offiziellen, stabilen Schema-
 *   Dokumentation spezifiziert — die Spec nennt Beispiele (siehe Modul-Doku
 *   `parseTokenLimitMessage`). Diese Story trifft eine PRAGMATISCHE, hier
 *   dokumentierte Annahme über das Format (siehe dort) und ist bewusst
 *   defensiv: eine nicht erkannte Variante löst NIE einen Fehlalarm aus
 *   (kein Pausieren "ins Blaue"), sondern wird schlicht ignoriert (Edge-Case
 *   "Token-Limit-Meldung nicht parsebar/mehrdeutig").
 *
 *   PTY-Chunks können ein Wort/Satzzeichen mitten durchtrennen (kein
 *   Zeilenpuffer garantiert) — deshalb hält `feed()` einen kleinen
 *   rollierenden Text-Puffer (Default 4000 Zeichen) und prüft nach jedem
 *   Chunk den GESAMTEN Puffer (nicht nur den neuen Chunk) gegen die
 *   Erkennungs-Regex, damit eine über zwei `onData`-Events gesplittete
 *   Meldung trotzdem erkannt wird.
 *
 *   Proximity-Anforderung (kein Fehlalarm über unabhängige Fundstellen,
 *   AC13): das Keyword ("session/usage limit") und der Reset-Zeit-Ausdruck
 *   ("resets …") werden NICHT unabhängig gegen den gesamten Puffer getestet
 *   — sonst würde eine zufällige Kombination aus zwei thematisch
 *   unabhängigen Textstellen im 4000-Zeichen-Puffer (z.B. ein Keyword-
 *   Vorkommen hier, ein unabhängiges "resets 3am"-Beispiel an ganz anderer
 *   Stelle — etwa in dieser Modul-Doku selbst, siehe unten) fälschlich
 *   `matched:true` ergeben. Stattdessen wird für JEDES Keyword-Vorkommen im
 *   Puffer ein enges Zeichenfenster (`KEYWORD_PROXIMITY_WINDOW`, ±150
 *   Zeichen) um den Treffer aufgespannt und NUR darin nach dem Reset-
 *   Ausdruck gesucht — eine echte, zusammenhängende Limit-Meldung hat
 *   Keyword und Reset-Zeit immer in diesem Abstand beieinander; zwei
 *   unabhängige Sätze/Absätze liegen typischerweise weit außerhalb.
 *
 * Zeitzone (Annahme, dokumentiert wie von der Story verlangt):
 *   Enthält die Meldung eine explizite IANA-Zeitzone in Klammern (z.B.
 *   "(Europe/Zurich)"), wird DIESE verwendet (nach Validierung via
 *   `Intl.DateTimeFormat`). Fehlt sie, wird die vom Aufrufer übergebene
 *   `timezone` (Default `Europe/Zurich`, deckt sich mit dem
 *   Nachtwächter-Settings-Default AC15) angenommen — der Watcher selbst hat
 *   keinen anderen Kontext, in welcher Zeitzone Claude die Uhrzeit meint.
 *   Kalender-Rollover (heute→morgen) wird pro Zeitzone via `Intl`-basierter
 *   Wandzeit-Konvertierung berechnet (kein neues npm-Package nötig — Node
 *   ≥20 hat volles ICU eingebaut). DST-Übergangstage (23h/25h-Tage) werden
 *   NICHT gesondert behandelt (Kalendertag-Addition, nicht Millisekunden-
 *   Addition) — für den Anwendungsfall "nächster Reset in ≤24h" ausreichend.
 *
 * @module TokenLimitWatcher
 */

/** Default-Zeitzone, deckt sich mit `window.timezone`-Default (AC15). */
export const DEFAULT_TIMEZONE = 'Europe/Zurich';

/** Default-Puffer nach Reset, bevor fortgesetzt wird (AC14: "Reset + 1 Minute Puffer"). */
export const DEFAULT_RESET_BUFFER_MS = 60_000;

/** Rollierender Text-Puffer (Zeichen) gegen über Chunks gesplittete Meldungen. */
export const DEFAULT_BUFFER_CHARS = 4000;

// ── Meldungs-Erkennung (pure, kein IO) ──────────────────────────────────────

/**
 * Erkennt, ob der Text (nach ANSI-Stripping) auf eine Token-/Usage-Limit-
 * Meldung hindeutet (Keyword-Test, ohne Reset-Zeit-Anforderung — intern
 * genutzt, um "Meldung da, aber Zeit nicht parsebar" von "gar keine Meldung"
 * zu unterscheiden, beides führt zu KEINEM Fehlalarm, AC13).
 */
const LIMIT_KEYWORD_RE = /\b(?:session|usage)\s+limit\b/i;

/**
 * Reset-Zeit-Ausdruck. Deckt die in der Story genannten Beispielformen ab:
 *   "resets 3am (Europe/Zurich)"   → hour=3,  ampm=am, tz=Europe/Zurich
 *   "resets at 15:45"              → hour=15, min=45
 *   "resets at 3:15pm"             → hour=3,  min=15, ampm=pm
 *   "resets 11pm"                  → hour=11, ampm=pm
 * Gruppen: 1=Stunde, 2=Minute (optional), 3=am/pm (optional), 4=IANA-TZ (optional).
 */
const RESET_TIME_RE =
  /\breset(?:s|ting)?\b\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+\/[A-Za-z_]+)\))?/i;

/**
 * Proximity-Fenster (Zeichen, je Seite) um einen Keyword-Treffer, innerhalb
 * dessen nach dem Reset-Zeit-Ausdruck gesucht wird — verhindert Fehlalarme
 * durch zwei unabhängige, weit auseinanderliegende Fundstellen im
 * rollierenden Puffer (siehe Modul-Doku „Proximity-Anforderung", AC13).
 * 150 Zeichen decken alle in dieser Story dokumentierten Meldungsformen
 * sicher ab (Keyword→Reset-Zeit liegt real innerhalb weniger Wörter).
 */
const KEYWORD_PROXIMITY_WINDOW = 150;

/**
 * Sucht im Text nach einem Keyword-Treffer, für den INNERHALB eines engen
 * Zeichenfensters (`KEYWORD_PROXIMITY_WINDOW`) auch der Reset-Zeit-Ausdruck
 * matcht — statt Keyword und Reset-Zeit unabhängig gegen den gesamten Text
 * zu testen (Fehlalarm-Schutz, siehe Modul-Doku).
 * @param {string} clean  ANSI-bereinigter Text.
 * @returns {RegExpExecArray|null}  Das Reset-Zeit-Match (Gruppen wie
 *   `RESET_TIME_RE`) des ERSTEN Keyword-Treffers mit passendem Fenster,
 *   oder `null` wenn kein Keyword-Treffer einen Reset-Ausdruck in
 *   Proximity hat.
 */
function findProximateResetMatch(clean) {
  const keywordRe = new RegExp(LIMIT_KEYWORD_RE.source, 'gi');
  let km;
  while ((km = keywordRe.exec(clean)) !== null) {
    const start = Math.max(0, km.index - KEYWORD_PROXIMITY_WINDOW);
    const end = Math.min(clean.length, km.index + km[0].length + KEYWORD_PROXIMITY_WINDOW);
    const windowText = clean.slice(start, end);
    const resetMatch = RESET_TIME_RE.exec(windowText);
    if (resetMatch) return resetMatch;
  }
  return null;
}

/**
 * Entfernt ANSI-Escape-Sequenzen (Farben, Cursor-Steuerung) aus PTY-Output,
 * bevor die Erkennungs-Regex läuft — reale PTY-Ausgabe interaktiver CLIs
 * enthält praktisch immer solche Sequenzen und würde sie sonst mitten in die
 * Meldung schneiden.
 * @param {string} str
 * @returns {string}
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Validiert einen IANA-Zeitzonen-Bezeichner via `Intl.DateTimeFormat`
 * (wirft bei unbekannter/ungültiger Zone).
 * @param {unknown} tz
 * @returns {boolean}
 */
export function isValidIanaTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    return Boolean(new Intl.DateTimeFormat('en-US', { timeZone: tz }));
  } catch {
    return false;
  }
}

/**
 * Liest Jahr/Monat/Tag/Stunde/Minute/Sekunde eines Zeitpunkts in einer
 * gegebenen IANA-Zeitzone (Wandzeit).
 *
 * Exportiert (S-195 NightWatchScheduler, taktgeber-nachtwaechter AC10):
 * Wiederverwendung statt Duplikation des TZ-Wandzeit-Musters für die
 * Nachtfenster-Berechnung (über-Mitternacht + TZ, siehe Modul-Doku dort).
 *
 * @param {number} instantMs
 * @param {string} timeZone
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}}
 */
export function getZonedParts(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map = {};
  for (const part of dtf.formatToParts(instantMs)) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) === 24 ? 0 : Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * Offset (ms) zwischen UTC und der Wandzeit einer Zone zu einem gegebenen
 * UTC-Zeitpunkt: `wandzeit_als_utc_ms = instantMs + offset`.
 * @param {number} instantMs
 * @param {string} timeZone
 * @returns {number}
 */
function tzOffsetMsAt(instantMs, timeZone) {
  const p = getZonedParts(instantMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instantMs;
}

/**
 * Wandelt eine Wandzeit (Jahr/Monat/Tag/Stunde/Minute, in `timeZone`) in
 * einen UTC-Epoch-ms-Zeitpunkt um. Zwei-Schritt-Näherung (Standard-Technik,
 * ausreichend außerhalb der DST-Umstellungsminute selbst — s. Modul-Doku).
 * @param {number} year
 * @param {number} month  1-12
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {string} timeZone
 * @returns {number}
 */
export function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = tzOffsetMsAt(guess, timeZone);
  const utc1 = guess - offset1;
  const offset2 = tzOffsetMsAt(utc1, timeZone);
  return guess - offset2;
}

/**
 * Addiert Kalendertage auf ein Jahr/Monat/Tag-Tripel (reine Kalenderarithmetik,
 * unabhängig von Zeitzone/DST — für "nächster Kalendertag" ausreichend).
 *
 * Exportiert (S-195 NightWatchScheduler): Wiederverwendung für die
 * Über-Mitternacht-Fensterende-Berechnung (AC10/AC11) statt Duplikation.
 *
 * @param {number} year
 * @param {number} month  1-12
 * @param {number} day
 * @param {number} deltaDays
 * @returns {{year:number, month:number, day:number}}
 */
export function addCalendarDays(year, month, day, deltaDays) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Parst einen (rohen, ggf. ANSI-behafteten) PTY-Text auf eine Token-/Usage-
 * Limit-Meldung samt Reset-Zeitpunkt (AC13).
 *
 * Robust gegen Fehlalarm (Edge-Case "nicht parsebar/mehrdeutig"):
 *   - Kein Limit-Keyword ("session limit"/"usage limit") im Text → `matched:false`.
 *   - Limit-Keyword vorhanden, aber keine erkennbare Reset-Zeit / Zeit
 *     außerhalb des plausiblen Bereichs (Stunde/Minute ungültig) →
 *     `matched:false` (Meldung ist da, aber nicht robust auswertbar — KEIN
 *     Fehlalarm, kein Pausieren).
 *   - Limit-Keyword UND ein Reset-Zeit-Ausdruck vorhanden, aber NICHT in
 *     Proximity zueinander (siehe `findProximateResetMatch` /
 *     `KEYWORD_PROXIMITY_WINDOW`) → `matched:false` (zwei unabhängige,
 *     thematisch unzusammenhängende Textstellen im rollierenden Puffer sind
 *     KEINE zusammenhängende Limit-Meldung — KEIN Fehlalarm).
 *
 * Heute-vs-morgen-Rollover: liegt die genannte Uhrzeit (in der ermittelten
 * Zeitzone) zum Zeitpunkt `nowMs` bereits in der Vergangenheit (inkl. exakt
 * jetzt), wird der NÄCHSTE Kalendertag angenommen.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.nowMs]  Referenzzeitpunkt (injectable, Default Date.now()).
 * @param {string} [opts.defaultTimezone]  Fallback wenn die Meldung keine TZ nennt.
 * @returns {{ matched: boolean, resetAt: number|null, rawMatch: string|null, timezone: string|null }}
 */
export function parseTokenLimitMessage(text, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const defaultTimezone = opts.defaultTimezone ?? DEFAULT_TIMEZONE;
  const unmatched = { matched: false, resetAt: null, rawMatch: null, timezone: null };

  if (typeof text !== 'string' || text.length === 0) return unmatched;
  const clean = stripAnsi(text);

  if (!LIMIT_KEYWORD_RE.test(clean)) return unmatched;

  // Proximity-Anforderung (AC13, kein Fehlalarm über unabhängige
  // Fundstellen): Reset-Zeit muss NAHE einem Keyword-Treffer stehen, nicht
  // irgendwo im Gesamttext (siehe Modul-Doku + findProximateResetMatch).
  const m = findProximateResetMatch(clean);
  if (!m) return unmatched; // Meldung da, aber keine erkennbare Reset-Zeit IN PROXIMITY → kein Fehlalarm

  let hour = parseInt(m[1], 10);
  const minute = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const ampm = m[3] ? m[3].toLowerCase() : null;
  const tzCandidate = m[4] ?? null;

  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return unmatched;

  if (ampm) {
    if (!Number.isInteger(hour) || hour < 1 || hour > 12) return unmatched;
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  } else if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return unmatched;
  }

  const timezone = tzCandidate && isValidIanaTimeZone(tzCandidate) ? tzCandidate : defaultTimezone;

  const nowParts = getZonedParts(nowMs, timezone);
  let resetAt = zonedWallTimeToUtc(nowParts.year, nowParts.month, nowParts.day, hour, minute, timezone);

  if (resetAt <= nowMs) {
    // Uhrzeit heute bereits vorbei (oder exakt jetzt) → nächster Kalendertag.
    const tomorrow = addCalendarDays(nowParts.year, nowParts.month, nowParts.day, 1);
    resetAt = zonedWallTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, timezone);
  }

  return { matched: true, resetAt, rawMatch: m[0], timezone };
}

// ── TokenLimitWatcher ────────────────────────────────────────────────────────

/**
 * @typedef {{ limited: boolean, resetAt: number|null, rawMatch: string|null, detectedAt: number|null }} TokenLimitState
 */

/**
 * TokenLimitWatcher — hält den zuletzt erkannten Limit-Zustand und bietet die
 * Warte-Primitive für AC14. Kein Interval nötig (im Gegensatz zu
 * `NotificationWatcher`): die Erkennung ist rein output-getrieben
 * (`feed()`/`attach()`), nicht periodisch pollend — PTY-Output kommt bereits
 * event-basiert (`PtyManager#onData` → `'output'`-Event).
 */
export class TokenLimitWatcher {
  #timezone;
  #now;
  #bufferChars;
  #buffer = '';
  /** @type {TokenLimitState} */
  #state = { limited: false, resetAt: null, rawMatch: null, detectedAt: null };
  /** @type {Array<() => void>} */
  #detachFns = [];

  /**
   * @param {object} [opts]
   * @param {string} [opts.timezone]  Default-Zeitzone für Meldungen ohne
   *   explizite TZ-Angabe (Default `Europe/Zurich`, AC15-Default).
   * @param {() => number} [opts.now]  Injectable Uhr (ms epoch), Default `Date.now`.
   * @param {number} [opts.bufferChars]  Größe des rollierenden Text-Puffers.
   */
  constructor({ timezone = DEFAULT_TIMEZONE, now, bufferChars = DEFAULT_BUFFER_CHARS } = {}) {
    this.#timezone = timezone;
    this.#now = now ?? (() => Date.now());
    this.#bufferChars = bufferChars;
  }

  /**
   * Hängt den Watcher an eine PTY-artige Quelle (muss `.on('output', cb)`
   * unterstützen, Muster `PtyManager`/`CommandService#armIdleTimer`).
   * Ein künftiger Scheduler (S-195) entscheidet, an welche/wie viele
   * Sessions (konto-weit) der Watcher gehängt wird — nicht Teil dieser Story.
   *
   * @param {{ on: Function, off?: Function }} ptyLike
   * @returns {() => void} Detach-Funktion.
   */
  attach(ptyLike) {
    if (!ptyLike || typeof ptyLike.on !== 'function') return () => {};
    const listener = (chunk) => this.feed(chunk);
    ptyLike.on('output', listener);
    const detach = () => {
      if (typeof ptyLike.off === 'function') ptyLike.off('output', listener);
    };
    this.#detachFns.push(detach);
    return detach;
  }

  /** Löst alle über `attach()` registrierten Listener wieder. */
  detachAll() {
    for (const detach of this.#detachFns.splice(0)) detach();
  }

  /**
   * Füttert einen rohen PTY-Output-Chunk (String) in den Watcher (AC13).
   * Aktualisiert den rollierenden Puffer und prüft ihn auf eine Limit-
   * Meldung. Nicht-String/leere Chunks werden ignoriert (defensiv).
   * @param {unknown} chunk
   */
  feed(chunk) {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    this.#buffer = (this.#buffer + chunk).slice(-this.#bufferChars);

    const result = parseTokenLimitMessage(this.#buffer, {
      nowMs: this.#now(),
      defaultTimezone: this.#timezone,
    });

    if (result.matched && result.resetAt !== null) {
      // Neu erkennen, wenn noch nicht limitiert ODER ein abweichender
      // Reset-Zeitpunkt erkannt wird (z.B. eine zweite, spätere Meldung).
      if (!this.#state.limited || result.resetAt !== this.#state.resetAt) {
        this.#state = {
          limited: true,
          resetAt: result.resetAt,
          rawMatch: result.rawMatch,
          detectedAt: this.#now(),
        };
      }
    }
  }

  /** @returns {TokenLimitState} Kopie des aktuellen Zustands. */
  getState() {
    return { ...this.#state };
  }

  /** Setzt den erkannten Limit-Zustand zurück (z.B. nach erfolgreicher Pause). */
  clear() {
    this.#state = { limited: false, resetAt: null, rawMatch: null, detectedAt: null };
    this.#buffer = '';
  }

  /**
   * Wartelogik (AC14): pausiert bis `resetAt + bufferMs` (Default 1 Minute),
   * setzt danach den Limit-Zustand zurück ("fortsetzen"). Liegt `resetAt`
   * NACH `windowEndMs` (falls übergeben) → NICHT warten, sondern sofort mit
   * `{ paused:false, reason:'exceeds-window' }` zurückkehren (der Aufrufer —
   * der Scheduler, S-195 — entscheidet dann, im aktuellen Fenster zu stoppen
   * und in der nächsten Nacht fortzusetzen: `reason:'token-limit-stop'` auf
   * Scheduler-Ebene, siehe Spec-Vertrag "Engine-Schnittstelle").
   *
   * Edge-Case "Reset in der Vergangenheit/unplausibel" (kann durch
   * Verarbeitungs-Latenz zwischen Erkennung und Aufruf entstehen): die
   * Wartezeit wird nie negativ (`Math.max(…, 0)`) — minimaler Puffer statt
   * Crash/negatives `setTimeout`.
   *
   * @param {object} [opts]
   * @param {number|null} [opts.windowEndMs]  Fensterende in ms epoch (vom
   *   Scheduler vorberechnet); `null`/weggelassen = keine Fenster-Prüfung.
   * @param {number} [opts.bufferMs]  Puffer nach Reset (Default 60 000 = 1 min, AC14).
   * @param {(ms: number) => Promise<void>} [opts.sleepFn]  Injectable Sleep (Tests).
   * @returns {Promise<{ paused: true, resumedAt: number }
   *   | { paused: false, reason: 'not-limited'|'exceeds-window', resetAt: number|null }>}
   */
  async waitForReset({ windowEndMs = null, bufferMs = DEFAULT_RESET_BUFFER_MS, sleepFn } = {}) {
    const state = this.#state;
    if (!state.limited || state.resetAt === null) {
      return { paused: false, reason: 'not-limited', resetAt: null };
    }

    if (windowEndMs !== null && windowEndMs !== undefined && state.resetAt > windowEndMs) {
      return { paused: false, reason: 'exceeds-window', resetAt: state.resetAt };
    }

    const resumeAt = state.resetAt + bufferMs;
    const sleep = sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const waitMs = Math.max(resumeAt - this.#now(), 0);
    await sleep(waitMs);
    this.clear();
    return { paused: true, resumedAt: resumeAt };
  }
}
