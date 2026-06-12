/**
 * stackValidation.test.js — Unit-Tests für das gemeinsame Validierungsmodul.
 *
 * Covers:
 *   isValidStackName  — alphanumerisch + _ + -, Länge max. 64, keine Shell-Metazeichen
 *   isValidRelativePath — kein absoluter Pfad, keine ..-Segmente
 *
 * Dieses Modul ist die Single Source of Truth für beide Consumer:
 *   StackRegistry.js und VpsComposeControl.js (I1, stack-deploy-orchestration Iteration 2).
 */

import { describe, it, expect } from '@jest/globals';
import { isValidStackName, isValidRelativePath, MAX_STACK_NAME_LEN } from '../src/validation/stackValidation.js';

// ── isValidStackName ───────────────────────────────────────────────────────────

describe('stackValidation — isValidStackName', () => {
  it('akzeptiert einfache alphanumerische Namen', () => {
    expect(isValidStackName('myapp')).toBe(true);
    expect(isValidStackName('MyApp123')).toBe(true);
    expect(isValidStackName('app-v2')).toBe(true);
    expect(isValidStackName('my_stack')).toBe(true);
  });

  it('akzeptiert Namen mit Bindestrichen und Unterstrichen', () => {
    expect(isValidStackName('my-app')).toBe(true);
    expect(isValidStackName('app_v2_prod')).toBe(true);
    expect(isValidStackName('rapt-dashboard')).toBe(true);
  });

  it('akzeptiert Namen exakt am Längenlimit (64 Zeichen)', () => {
    const exactly64 = 'a'.repeat(64);
    expect(isValidStackName(exactly64)).toBe(true);
  });

  it('lehnt Namen ab die das Längenlimit überschreiten (>64 Zeichen)', () => {
    const tooLong = 'a'.repeat(65);
    expect(isValidStackName(tooLong)).toBe(false);
  });

  it('lehnt leere Strings ab', () => {
    expect(isValidStackName('')).toBe(false);
  });

  it('lehnt nicht-String-Typen ab', () => {
    expect(isValidStackName(null)).toBe(false);
    expect(isValidStackName(undefined)).toBe(false);
    expect(isValidStackName(123)).toBe(false);
    expect(isValidStackName({})).toBe(false);
  });

  it('lehnt .. ab (Path-Traversal-Schutz)', () => {
    expect(isValidStackName('../etc')).toBe(false);
    expect(isValidStackName('my..app')).toBe(false);
  });

  it('lehnt / ab (Slash in Stack-Namen)', () => {
    expect(isValidStackName('my/app')).toBe(false);
    expect(isValidStackName('/etc/passwd')).toBe(false);
  });

  it('lehnt Shell-Metazeichen ab', () => {
    expect(isValidStackName('app;evil')).toBe(false);
    expect(isValidStackName('app|evil')).toBe(false);
    expect(isValidStackName('app&evil')).toBe(false);
    expect(isValidStackName('app$(cmd)')).toBe(false);
    expect(isValidStackName('app`cmd`')).toBe(false);
    expect(isValidStackName('my app')).toBe(false); // Leerzeichen
  });

  it('MAX_STACK_NAME_LEN exportiert korrekt (64)', () => {
    expect(MAX_STACK_NAME_LEN).toBe(64);
  });
});

// ── isValidRelativePath ────────────────────────────────────────────────────────

describe('stackValidation — isValidRelativePath', () => {
  it('akzeptiert einfache relative Pfade', () => {
    expect(isValidRelativePath('docker-compose.yml')).toBe(true);
    expect(isValidRelativePath('docker/docker-compose.yml')).toBe(true);
    expect(isValidRelativePath('config/prod/compose.yml')).toBe(true);
  });

  it('akzeptiert relative Pfade mit einem Punkt-Präfix (aktuelles Verzeichnis)', () => {
    expect(isValidRelativePath('docker-compose.yml')).toBe(true);
  });

  it('lehnt absolute Pfade mit führendem / ab (Path-Traversal-Schutz)', () => {
    expect(isValidRelativePath('/etc/passwd')).toBe(false);
    expect(isValidRelativePath('/docker-compose.yml')).toBe(false);
  });

  it('lehnt Pfade mit führendem ~ ab (Home-Directory-Traversal-Schutz)', () => {
    expect(isValidRelativePath('~/stacks/app')).toBe(false);
    expect(isValidRelativePath('~/.ssh/authorized_keys')).toBe(false);
  });

  it('lehnt Pfade mit .. ab (Path-Traversal-Schutz)', () => {
    expect(isValidRelativePath('../etc/passwd')).toBe(false);
    expect(isValidRelativePath('../../root/.ssh')).toBe(false);
    expect(isValidRelativePath('docker/../../../etc/docker-compose.yml')).toBe(false);
  });

  it('lehnt leere Strings ab', () => {
    expect(isValidRelativePath('')).toBe(false);
  });

  it('lehnt nicht-String-Typen ab', () => {
    expect(isValidRelativePath(null)).toBe(false);
    expect(isValidRelativePath(undefined)).toBe(false);
    expect(isValidRelativePath(42)).toBe(false);
  });
});
