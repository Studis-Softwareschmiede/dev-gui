/**
 * ImageRefResolver — reine Prädikate/Auswahl-Logik für die Ziel-Ref-Auflösung beim
 * Container-Update, wenn der Bestands-Ref Digest-gepinnt ist (container-image-update
 * AC16/AC17): erkennt, ob ein Image-Ref auf einen unveränderlichen Digest gepinnt ist
 * (`repo@sha256:<digest>` bzw. ein reiner Digest/Image-ID ohne Tag), und wählt aus den
 * RepoTags eines Images den eindeutigen beweglichen Tag aus (falls vorhanden).
 *
 * Reiner, seiteneffektfreier Helfer — kein Docker-/SSH-I/O (das lebt in
 * `VpsDockerControl.getImageRepoTags`, ADR-012). Analog zu `RunConfigMapper.js`: die
 * Docker-Lesung liefert Rohdaten, dieses Modul entscheidet, was sie bedeuten.
 *
 * @module deploy/ImageRefResolver
 */

/** sha256-Digest-Muster (64 Hex-Zeichen). */
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

/**
 * Prüft, ob ein Image-Ref auf einen unveränderlichen Digest gepinnt ist
 * (container-image-update AC16/AC17):
 *   - `repo@sha256:<digest>` — explizite Digest-Referenz (der Teil nach dem letzten `@`
 *     ist der Digest; ein ggf. vorhandener Tag vor dem `@` ändert daran nichts — der
 *     Pull würde trotzdem immer denselben Digest treffen).
 *   - `sha256:<digest>` — reiner Digest/Image-ID ohne Repo/Tag.
 *
 * Ein gewöhnlicher `repo:tag`-Ref (kein `@`) ist NICHT gepinnt — AC4 bleibt für diesen
 * Fall unverändert (derselbe Tag wird direkt weiterverwendet).
 *
 * @param {unknown} ref
 * @returns {boolean}
 */
export function isDigestPinnedImageRef(ref) {
  if (typeof ref !== 'string' || !ref) return false;
  if (ref.includes('@')) {
    const digestPart = ref.slice(ref.lastIndexOf('@') + 1);
    return SHA256_DIGEST_RE.test(digestPart);
  }
  return SHA256_DIGEST_RE.test(ref);
}

/**
 * Wählt aus einer RepoTags-Liste (`docker image inspect` → `.RepoTags`) den eindeutigen
 * beweglichen Tag (container-image-update AC17): genau EIN gültiger (nicht `<none>`)
 * Eintrag → dieser wird verwendet. Kein Eintrag oder mehr als einer → mehrdeutig, KEIN
 * Tag wählbar (fail-closed-Signal an den Aufrufer — der Update-Pfad bricht in diesem Fall
 * mit `update-unsafe` ab, AC7).
 *
 * @param {unknown} repoTags
 * @returns {{ ok: true, tag: string } | { ok: false }}
 */
export function pickMovingTag(repoTags) {
  const tags = Array.isArray(repoTags)
    ? repoTags.filter((t) => typeof t === 'string' && t.length > 0 && !t.includes('<none>'))
    : [];
  if (tags.length === 1) {
    return { ok: true, tag: tags[0] };
  }
  return { ok: false };
}
