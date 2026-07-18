/**
 * ImageRefResolver.test.js — Unit-Tests für die reine Ziel-Ref-Auflösungs-Logik
 * (container-image-update AC16/AC17, S-377).
 *
 * Covers (container-image-update):
 *   AC16 — isDigestPinnedImageRef(): erkennt repo@sha256:<digest> UND reinen
 *          Digest/Image-ID-Ref (sha256:<digest>) als gepinnt; gewöhnlicher repo:tag-Ref
 *          ist NICHT gepinnt (AC4 bleibt für diesen Fall unverändert).
 *   AC17 — pickMovingTag(): genau EIN gültiger (nicht "<none>") RepoTags-Eintrag wird
 *          gewählt; leere Liste, mehrdeutige Liste (>1) oder ausschließlich "<none>"-
 *          Einträge → kein Tag wählbar (fail-closed-Signal).
 *
 * Strategie: rein funktional, kein I/O, keine Mocks nötig.
 */

import { describe, it, expect } from '@jest/globals';
import { isDigestPinnedImageRef, pickMovingTag } from '../src/deploy/ImageRefResolver.js';

describe('isDigestPinnedImageRef() — container-image-update AC16', () => {
  it('repo@sha256:<64-hex-digest> → true (explizite Digest-Referenz)', () => {
    expect(
      isDigestPinnedImageRef('ghcr.io/org/app@sha256:1111111111111111111111111111111111111111111111111111111111111111'),
    ).toBe(true);
  });

  it('reiner Digest/Image-ID-Ref ("sha256:<digest>") ohne Repo/Tag → true', () => {
    expect(
      isDigestPinnedImageRef('sha256:1111111111111111111111111111111111111111111111111111111111111111'),
    ).toBe(true);
  });

  it('gewöhnlicher repo:tag-Ref (kein "@") → false (AC4 unverändert)', () => {
    expect(isDigestPinnedImageRef('ghcr.io/org/app:v1')).toBe(false);
    expect(isDigestPinnedImageRef('ghcr.io/org/app:latest')).toBe(false);
  });

  it('Ref ohne Tag und ohne "@" (nur Repo-Name) → false', () => {
    expect(isDigestPinnedImageRef('ghcr.io/org/app')).toBe(false);
  });

  it('"@"-Suffix, das kein gültiger sha256-Digest ist → false (kein falsches Positiv)', () => {
    expect(isDigestPinnedImageRef('ghcr.io/org/app@notadigest')).toBe(false);
    expect(isDigestPinnedImageRef('ghcr.io/org/app@sha256:tooshort')).toBe(false);
  });

  it('null/undefined/leerer String/Nicht-String → false, kein Crash', () => {
    expect(isDigestPinnedImageRef(null)).toBe(false);
    expect(isDigestPinnedImageRef(undefined)).toBe(false);
    expect(isDigestPinnedImageRef('')).toBe(false);
    expect(isDigestPinnedImageRef(42)).toBe(false);
  });
});

describe('pickMovingTag() — container-image-update AC17', () => {
  it('genau EIN gültiger Tag → { ok:true, tag }', () => {
    expect(pickMovingTag(['ghcr.io/org/app:latest'])).toEqual({ ok: true, tag: 'ghcr.io/org/app:latest' });
  });

  it('leere Liste → { ok:false } (kein Tag ermittelbar)', () => {
    expect(pickMovingTag([])).toEqual({ ok: false });
  });

  it('null/undefined (kein RepoTags-Feld) → { ok:false }', () => {
    expect(pickMovingTag(null)).toEqual({ ok: false });
    expect(pickMovingTag(undefined)).toEqual({ ok: false });
  });

  it('mehrdeutige Liste (>1 gültiger Tag) → { ok:false }', () => {
    expect(pickMovingTag(['ghcr.io/org/app:latest', 'ghcr.io/org/app:v2'])).toEqual({ ok: false });
  });

  it('ausschließlich "<none>:<none>"-Einträge (dangling) → { ok:false }', () => {
    expect(pickMovingTag(['<none>:<none>'])).toEqual({ ok: false });
  });

  it('EIN gültiger Tag + "<none>"-Rauschen → das "<none>"-Rauschen wird gefiltert, gültiger Tag bleibt eindeutig', () => {
    expect(pickMovingTag(['ghcr.io/org/app:latest', '<none>:<none>'])).toEqual({ ok: true, tag: 'ghcr.io/org/app:latest' });
  });
});
