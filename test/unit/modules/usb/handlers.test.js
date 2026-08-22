/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Covers the port wiring: that every event the settings UI relies on is registered,
 * and that status changes are pushed to the view without a dead port accumulating
 * listeners for the life of the service worker.
 */

jest.mock('../../../../src/modules/usb/provision', () => ({
  reprobe: jest.fn(),
  provision: jest.fn(),
  disable: jest.fn(),
  diagnostics: jest.fn(),
  inspectLocalKeyMaterial: jest.fn(),
  migrateLocalKeyMaterial: jest.fn()
}));

jest.mock('../../../../src/modules/usb/state', () => ({
  getStatus: jest.fn(),
  addStateListener: jest.fn()
}));

describe('usb/handlers', () => {
  let registerUsbHandlers; let provision; let state; let controller; let listener;

  /** Stand-in for a SubController: records handlers and exposes a fake main port. */
  function makeController({withPort = true} = {}) {
    const handlers = new Map();
    const emit = jest.fn();
    return {
      mainType: 'app',
      ports: withPort ? {app: {emit}} : {},
      handlers,
      emit,
      on(event, handler) {
        handlers.set(event, handler);
      }
    };
  }

  beforeEach(() => {
    jest.resetModules();
    provision = require('../../../../src/modules/usb/provision');
    state = require('../../../../src/modules/usb/state');
    listener = null;
    state.addStateListener.mockImplementation(fn => {
      listener = fn;
      return jest.fn();
    });
    ({registerUsbHandlers} = require('../../../../src/modules/usb/handlers'));
    controller = makeController();
    registerUsbHandlers(controller);
  });

  it('registers every event the settings page uses', () => {
    expect([...controller.handlers.keys()].sort()).toEqual([
      'usb-diagnostics',
      'usb-disable',
      'usb-get-status',
      'usb-inspect-local',
      'usb-migrate',
      'usb-probe',
      'usb-provision'
    ]);
  });

  // Answering from cache would leave a page showing a device that has since gone
  // away, and the periodic alarm cannot be relied on as the only trigger.
  it('probes the device on usb-get-status rather than answering from cache', async () => {
    provision.reprobe.mockResolvedValue({state: 'ABSENT', enabled: true});
    const result = await controller.handlers.get('usb-get-status')();
    expect(provision.reprobe).toHaveBeenCalled();
    expect(state.getStatus).not.toHaveBeenCalled();
    expect(result).toEqual({state: 'ABSENT', enabled: true});
  });

  it('routes each action to provision', async () => {
    await controller.handlers.get('usb-probe')();
    expect(provision.reprobe).toHaveBeenCalled();

    await controller.handlers.get('usb-provision')({label: 'stick'});
    expect(provision.provision).toHaveBeenCalledWith({label: 'stick'});

    await controller.handlers.get('usb-disable')();
    expect(provision.disable).toHaveBeenCalled();

    await controller.handlers.get('usb-diagnostics')();
    expect(provision.diagnostics).toHaveBeenCalled();

    await controller.handlers.get('usb-inspect-local')();
    expect(provision.inspectLocalKeyMaterial).toHaveBeenCalled();

    await controller.handlers.get('usb-migrate')();
    expect(provision.migrateLocalKeyMaterial).toHaveBeenCalled();
  });

  it('tolerates usb-provision being called with no arguments', async () => {
    await controller.handlers.get('usb-provision')();
    expect(provision.provision).toHaveBeenCalledWith({label: undefined});
  });

  it('pushes status changes to the view', () => {
    const status = {state: 'ABSENT', enabled: true};
    listener('ABSENT', 'READY', status);
    expect(controller.emit).toHaveBeenCalledWith('usb-status-changed', status);
  });

  it('does nothing when the view has no port', () => {
    const detached = makeController({withPort: false});
    registerUsbHandlers(detached);
    expect(() => listener('ABSENT', 'READY', {})).not.toThrow();
  });

  // A closed view must not leave a listener emitting into it on every probe for
  // the remaining life of the service worker.
  it('stops forwarding once the port rejects an emit', () => {
    const unregister = jest.fn();
    state.addStateListener.mockImplementation(fn => {
      listener = fn;
      return unregister;
    });
    const dead = makeController();
    dead.ports.app.emit = jest.fn(() => {
      throw new Error('port closed');
    });
    registerUsbHandlers(dead);
    expect(() => listener('ABSENT', 'READY', {})).not.toThrow();
    expect(unregister).toHaveBeenCalled();
  });
});
