/**
 * Stub for @xterm/xterm — used via moduleNameMapper.
 * Tracks the last created instance in Terminal._lastInstance for test inspection.
 */
import { jest } from '@jest/globals';

export class Terminal {
  constructor() {
    this.open      = jest.fn();
    this.loadAddon = jest.fn();
    this.write     = jest.fn();
    this.onData    = jest.fn();
    this.dispose   = jest.fn();
    this.attachCustomKeyEventHandler = jest.fn((fn) => {
      // Store the handler so tests can invoke it directly
      Terminal._lastKeyEventHandler = fn;
    });
    // Store the latest instance for test access
    Terminal._lastInstance = this;
    Terminal._instances.push(this);
  }
}
Terminal._lastInstance      = null;
Terminal._lastKeyEventHandler = null;
Terminal._instances         = [];
Terminal._reset             = () => {
  Terminal._lastInstance      = null;
  Terminal._lastKeyEventHandler = null;
  Terminal._instances         = [];
};
